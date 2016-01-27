/**
 * @namespace Consumer
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
 * Create tcp coonection between Consumer and rabbitmq server
 * @memberOf Consumer
 * @param  {String} _amqpUrl - amqp url used to connect to rabbitmq server
 * @return {Promise} - channel
 */
var connect = function(_amqpUrl) {
  if (connected) {
    return Promise.resolve(amqpChannel);
  }

  if (connecting) {
    var deferred = new Promise(function(resolve) { resolve(); });
    reqQueue.push(deferred);
    return deferred;
  }

  connecting = true;

  amqpUrl = utils.getValidUrl([amqpUrl, _amqpUrl, config.amqpUrl, process.env.AMQP_URL, 'amqp://localhost' ]);

  return amqp.connect(amqpUrl)
  .then(function (_connection) {
    amqpConnection = _connection;

    amqpConnection.on('close', reconnect);
    amqpConnection.on('error', reconnect);
    amqpIntervalId = clearInterval(amqpIntervalId);

    return createChannel();
  })
  .catch(function (_err) {
    Logger.error('[AMQP] Consumer ', _err.stack, '\n    occured while connecting');
    reconnect();
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
    Logger.info('[AMQP] Consumer is now connected and ready to consume messages');


    amqpChannel = _amqpChannel;
    amqpChannel.prefetch(config.prefetch || process.env.AMQP_PREFETCH);

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
      Logger.info('[AMQP] Consumer is now disconnected');
    });
  }
};

function checkRpc(_msg, _queue) {
  return function(content) {
    if (content !== undefined && _msg.properties.replyTo) {
      var options = { correlationId: _msg.properties.correlationId };
      Logger.info('[MQ-C][' + _queue + '] > ', content);
      amqpChannel.sendToQueue(_msg.properties.replyTo, parsers.out(content, options), options);
    }

    return _msg;
  };
}

/**
 * Consume message from queue
 * @memberOf Consumer
 * @param {String} _queue - queue name
 * @param {String} _options - options
 * @param {String} _callback - callback to call after receiving msg
 * @return {Promise} queue
 */
var consume = function(_queue, _options, _callback) {
  if (!connected) {
    return connect().then(function() {
      return consume(_queue, _options, _callback);
    });
  }

  if (typeof _options === 'function') {
    _callback = _options;
    _options = { persistent: true, durable: true };
  }

  _queue += (process.env.LOCAL_QUEUE ? process.env.LOCAL_QUEUE : '');

  return amqpChannel.assertQueue(_queue, _options)
    .then(function (_q) {
      amqpChannel.consume(_q.queue, function(msg) {
        Logger.info('[MQ-C][' + _queue + '] < ' + msg.content.toString());

        Promise.resolve(parsers.in(msg))
        .then(_callback)
        .then(checkRpc(msg, _queue))
        .then(function() {
          amqpChannel.ack(msg);
        })
        .catch(function(e) {
          Logger.error('[AMQP] Consumer error one queue: ' + _queue, e);
          amqpChannel.reject(msg, config.isRequeueEnabled);
        });
      }, { noAck: false });

      return true;
    });
};

module.exports = function (_config) {
  config = _config;

  return {
    connect: connect,
    disconnect: disconnect,
    consume: consume
  };
};
