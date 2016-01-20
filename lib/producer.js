var amqp = require('./amqp-layer')();
var logger = require('../helpers/logger')(true);

var channel, config;
var connected = connecting = false;
var reqQueue = [];

var connect = function(_amqpUrl) {
  connecting = true;

  return amqp.connect(_amqpUrl || config.amqpUrl)
  .then(function (_channel) {
    logger.log('info', '[AMQP] Producer is now connected and ready to produce messages');
    channel = _channel;
    connected = true;

    while (reqQueue.length > 0) {
      reqQueue.pop()();
    }
  })
  .catch(function (_err) {
    logger.log('error', '[AMQP] Producer ', _err.stack, '\n    occured while connecting');
    amqp.reconnect();
  });
};

var produce = function(_queue, _msg) {
  if (!_msg) return;

  if (typeof _msg === 'object') {
    _msg = JSON.stringify(_msg);
  }

  if (!connected) {
    reqQueue.push(function () {
      produce(_queue, _msg);
    });

    if (!connecting) {
      connect();
    }
  } else {
    logger.log('info', '[AMQP] Producer populate msg:', _msg);

    return Promise.resolve(_msg)
    .then(function () {
      channel.sendToQueue(_queue, new Buffer(_msg), { persistent: true });
    });
  }
};

module.exports = function (_config) {
  config = _config;

  logger.enableDisableLog(config.isLogEnabled);

  return {
    connect: connect,
    disconnect: amqp.disconnect,
    produce: produce
  };
};
