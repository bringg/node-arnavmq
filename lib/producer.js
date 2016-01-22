/**
 * @namespace Producer
 */
var amqp = require('amqplib');
var logger = require('../helpers/logger')(true);
var utils = require('../helpers/utils');

var config;
var connected = false;
var connecting = false;
var reqQueue = [];
var amqpUrl, amqpConnection, amqpChannel, amqpIntervalId;

/**
 * Create tcp coonection between producer and rabbitmq server
 * @memberOf Producer
 * @param  {String} _amqpUrl - amqp url used to connect to rabbitmq server
 * @return {Promise} - channel
 */
var connect = function(_amqpUrl) {
  if (connected) {
    return Promise.resolve(amqpChannel);
  } else if (connecting) {
    return createChannel();
  }

  amqpUrl = utils.getValidUrl([amqpUrl, _amqpUrl, config.amqpUrl, process.env.AMQP_URL ]);

  return amqp.connect(amqpUrl)
  .then(function (_connection) {
    amqpConnection = _connection;

    amqpConnection.on('close', reconnect);
    amqpConnection.on('error', reconnect);
    amqpIntervalId = clearInterval(amqpIntervalId);

    return createChannel();
  })
  .catch(function (_err) {
    logger.log('error', '[AMQP] Producer ', _err.stack, '\n    occured while connecting');
    reconnect();
  });
};

/**
 * Create channel
 * @memberOf Producer
 * @return {Promise} - channel
 */
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
    logger.log('error', '[AMQP] Consumer ', _err.stack, '\n    occured while connecting');
    recreateChannel();
  });
};

/**
 * Recreate a channel after a timeout
 * @memberOf Producer
 * @return {Nothing}
 */
var recreateChannel = function() {
  if (!amqpIntervalId) {
    amqpIntervalId = setInterval(createChannel, 1000);
  }
};

/**
 * Reconnect after a timeout
 * @memberOf Producer
 * @return {Nothing}
 */
var reconnect  = function() {
  if (!amqpIntervalId) {
    amqpIntervalId = setInterval(connect, 1000);
  }
};

/**
 * Disconnect from server
 * @memberOf Producer
 * @return {Promise}
 */
var disconnect = function() {
  if (amqpConnection && amqpChannel) {
    return amqpChannel.close()
    .then(function () {
      return amqpConnection.close();
    })
    .then(function () {
      connecting = false;
      connected = false;
      reqQueue = [];
      amqpUrl = undefined;
      amqpConnection = undefined;
      amqpChannel = undefined;
      amqpIntervalId = clearInterval(amqpIntervalId);
      logger.log('info', '[AMQP] Producer is now disconnected');
    });
  }
};

/**
 * Send message to queue
 * @memberOf Producer
 * @param {String} _queue - queue name
 * @param {String} _msg - message to send
 * @param {String} _options - options
 * @return {Promise} queue
 */
var produce = function(_queue, _msg, _options) {
  if (!_msg) return;

  _options = _options || { persistent: true, durable: true };

  if (typeof _msg === 'object') {
    _msg = JSON.stringify(_msg);
    _options.contentType = 'application/json';
  }

  /* jshint unused: false */
  return new Promise(function (resolve, reject) {
    if (!connected) {
      reqQueue.push(function () {
        resolve(produce(_queue, _msg, _options));
      });

      if (!connecting) {
        connect();
      }
    } else {
      logger.log('info', '[AMQP] Producer send msg: ' + _msg + ' to queue: ' + _queue);


      amqpChannel.assertQueue(_queue, _options)
      .then(function (_q) {
        return resolve(amqpChannel.sendToQueue(_q.queue, new Buffer(_msg), _options));
      });
    }
  });
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
