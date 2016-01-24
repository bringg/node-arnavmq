/**
 * @namespace Producer
 */
var amqp = require('amqplib'),
  utils = require('./helpers/utils'),
  parsers = require('./helpers/message-parsers');

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
  }

  if (connecting) {
    var deferred = new Promise();
    reqQueue.push(deferred);
    return deferred;
  }

  connecting = true;

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
    Logger.error('[AMQP] Producer ', _err.stack, '\n    occured while connecting');
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
    Logger.info('[AMQP] Producer is now connected and ready to produce messages');

    amqpChannel = _amqpChannel;

    amqpChannel.on('close', recreateChannel);
    amqpChannel.on('error', recreateChannel);

    amqpIntervalId = clearInterval(amqpIntervalId);

    connected = true;
    connecting = false;

    while (reqQueue.length > 0) {
      reqQueue.shift()();
    }

    return amqpChannel;
  })
  .catch(function (_err) {
    Logger.error('[AMQP] Consumer ', _err.stack, '\n    occured while connecting');
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
      Logger.info('[AMQP] Producer is now disconnected');
    });
  }
};

function checkRpc(queue, msg, options) {
  return function() {
    return amqpChannel.sendToQueue(queue, msg, options);
  };
}

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

  _msg = parsers.out(_msg, _options);

  Logger.info('[AMQP] Producer send msg: ' + _msg + ' to queue: ' + _queue);
  
  return connect().then(checkRpc(_queue, _msg, _options));
};

module.exports = function (_config) {
  config = _config;

  return {
    connect: connect,
    disconnect: disconnect,
    produce: produce
  };
};
