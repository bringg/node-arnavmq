/**
 * @namespace Consumer
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
 * Create tcp coonection between Consumer and rabbitmq server
 * @memberOf Consumer
 * @param  {String} _amqpUrl - amqp url used to connect to rabbitmq server
 * @return {Promise} - channel
 */
var connect = function(_amqpUrl) {
  if (connecting) {
    return Promise.resolve(amqpChannel);
  }

  connecting = true;
  amqpUrl = amqpUrl || _amqpUrl || config.amqpUrl || process.env.AMQP_URL || 'amqp://localhost';

  return amqp.connect(amqpUrl)
  .then(function (_connection) {
    amqpConnection = _connection;

    amqpConnection.on('close', reconnect);
    amqpConnection.on('error', reconnect);

    amqpIntervalId = clearInterval(amqpIntervalId);

    return createChannel();
  });
};

/**
 * Create channel
 * @memberOf Consumer
 * @return {Promise} - channel
 */
var createChannel = function() {
  return amqpConnection.createChannel()
  .then(function (_amqpChannel) {
    logger.log('info', '[AMQP] Consumer is now connected and ready to consume messages');

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
    reconnect();
  });
};

/**
 * Recreate a channel after a timeout
 * @memberOf Consumer
 * @return {Nothing}
 */
var recreateChannel = function() {
  if (!amqpIntervalId) {
    amqpIntervalId = setInterval(createChannel, 1000);
  }
};

/**
 * Reconnect after a timeout
 * @memberOf Consumer
 * @return {Nothing}
 */
var reconnect  = function() {
  if (!amqpIntervalId) {
    amqpIntervalId = setInterval(connect, 1000);
  }
};

/**
 * Disconnect from server
 * @memberOf Consumer
 * @return {Nothing}
 */
var disconnect = function() {
  if (amqpConnection && amqpChannel) {
    amqpChannel.close();
    amqpConnection.close();
  }
};

/**
 * Consume message from queue
 * @memberOf Consumer
 * @param {String} _queue - queue name
 * @param {String} _options - options
 * @param {String} _callback - callback to call after receiving msg
 * @return {Promise} queue
 */
var consume = function(_queue, _options, _callback) {
  _queue += (process.env.LOCAL_QUEUE ? process.env.LOCAL_QUEUE : '');

  if (!connected) {
    reqQueue.push(function () {
      consume(_queue, _options, _callback);
    });

    if (!connecting) {
      connect();
    }
  } else {
    var doneCallback = function (_msg) {
      var strMsg = _msg.content.toString();
      logger.log('info', '[AMQP] Consumer received msg: ' + strMsg +  ' from queue: ' + _queue);

      return Promise.resolve(strMsg)
      .then(_callback)
      .then(function () {
        amqpChannel.ack(_msg);
      })
      .catch(function (_err) {
        logger.log('error', '[AMQP] Consumer ', _err.stack, '\n    occured while processing msg:', strMsg);
        if (_err) amqpChannel.reject(_msg, config.isRequeueEnabled);
      });
    };

    if (typeof _options === 'function') {
      _callback = _options;
      _options = { persistent: true, durable: true };
    }

    return amqpChannel.assertQueue(_queue, _options)
    .then(function (_q) {
      amqpChannel.prefetch(config.prefetch);
      amqpChannel.consume(_q.queue, doneCallback, { noAck: false });

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
    consume: consume
  };
};
