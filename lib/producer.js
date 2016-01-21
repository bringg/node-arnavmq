var amqp = require('amqplib');
var logger = require('../helpers/logger')(true);

var config;
var connected = false;
var connecting = false;
var reqQueue = [];
var amqpUrl, amqpConnection, amqpChannel, amqpIntervalId;

var connect = function(_amqpUrl) {
  connecting = true;
  amqpUrl = amqpUrl || _amqpUrl || process.env.AMQP_URL || 'amqp://localhost';

  return amqp.connect(amqpUrl)
  .then(function (_connection) {
    amqpConnection = _connection;

    amqpConnection.on('close', reconnect);
    amqpConnection.on('error', reconnect);

    amqpIntervalId = clearInterval(amqpIntervalId);

    return createChannel();
  });
};

var createChannel = function() {
  return amqpConnection.createChannel()
  .then(function (_amqpChannel) {
    logger.log('info', '[AMQP] Producer is now connected and ready to produce messages');

    connected = true;

    amqpChannel = _amqpChannel;

    amqpChannel.on('close', recreateChannel);
    amqpChannel.on('error', recreateChannel);

    amqpIntervalId = clearInterval(amqpIntervalId);

    while (reqQueue.length > 0) {
      reqQueue.shift()();
    }

    return amqpChannel;
  })
  .catch(function (_err) {
    logger.log('error', '[AMQP] Producer ', _err.stack, '\n    occured while connecting');
    reconnect();
  });
};

var recreateChannel = function() {
  if (!amqpIntervalId) {
    amqpIntervalId = setInterval(createChannel, 1000);
  }
};

var reconnect  = function() {
  if (!amqpIntervalId) {
    amqpIntervalId = setInterval(connect, 1000);
  }
};

var disconnect = function() {
  if (amqpConnection && amqpChannel) {
    amqpChannel.close();
    amqpConnection.close();
  }
};

var produce = function(_queue, _msg, _options) {
  if (!_msg) return;

  if (typeof _msg === 'object') {
    _msg = JSON.stringify(_msg);
  }

  if (!connected) {
    reqQueue.push(function () {
      produce(_queue, _msg, _options);
    });

    if (!connecting) {
      connect();
    }
  } else {
    logger.log('info', '[AMQP] Producer populate msg:', _msg, _queue);

    _options = _options || { persistent: true, durable: false };
    return amqpChannel.assertQueue(_queue, _options)
    .then(function (_q) {
      amqpChannel.sendToQueue(_q.queue, new Buffer(_msg), _options);

      return _q.queue;
    });
  }
};

module.exports = function (_config) {
  config = _config;

  logger.enableDisableLog(config.isLogEnabled);

  return {
    connect: connect,
    createChannel: createChannel,
    reconnect: reconnect,
    recreateChannel: recreateChannel,
    disconnect: disconnect,
    produce: produce
  };
};
