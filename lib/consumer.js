/**
 * @namespace Consumer
 */
var amqp = require('amqplib');
var utils = require('./helpers/utils');

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

    connected = true;
    amqpChannel = _amqpChannel;
    amqpChannel.prefetch(config.prefetch || process.env.AMQP_PREFETCH);

    amqpChannel.on('close', recreateChannel);
    amqpChannel.on('error', recreateChannel);

    amqpIntervalId = clearInterval(amqpIntervalId);

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

/**
 * Consume message from queue
 * @memberOf Consumer
 * @param {String} _queue - queue name
 * @param {String} _options - options
 * @param {String} _callback - callback to call after receiving msg
 * @return {Promise} queue
 */
var consume = function(_queue, _options, _callback) {

  /* jshint unused: false */
  return new Promise(function (resolve, reject) {
    if (!connected) {
      reqQueue.push(function () {
        resolve(consume(_queue, _options, _callback));
      });

      if (!connecting) {
        connecting = true;
        connect();
      }
    } else {
      var doneCallback = function (_msg) {
        Logger.info('[AMQP] Consumer received msg: ' + _msg.content.toString() +  ' from queue: ' + _queue);

        return Promise.resolve(_msg)
        .then(utils.parseMsg)
        .then(_callback)
        .then(function (response) {
          if (response && msg.properties.replyTo) {
            var options = { correlationId: msg.properties.correlationId };
            response = utils.parseOutMsg(response, options);
            amqpChannel.sendToQueue(msg.properties.replyTo, response, options);
          }
          amqpChannel.ack(_msg);
          resolve(true);
        })
        .catch(function (_err) {
          if (_err) {
            Logger.error('[AMQP] Consumer ', _err.stack, '\n    occured while processing msg:', _msg.content.toString());
            amqpChannel.reject(_msg, config.isRequeueEnabled);
            resolve(false);
          }
        });
      };

      if (typeof _options === 'function') {
        _callback = _options;
        _options = { persistent: true, durable: true };
      }

      _queue += (process.env.LOCAL_QUEUE ? process.env.LOCAL_QUEUE : '');

      amqpChannel.assertQueue(_queue, _options)
      .then(function (_q) {
        amqpChannel.consume(_q.queue, doneCallback, { noAck: false });
      });
    }
  });
};

module.exports = function (_config) {
  config = _config;

  return {
    connect: connect,
    createChannel: createChannel,
    reconnect: reconnect,
    recreateChannel: recreateChannel,
    disconnect: disconnect,
    consume: consume
  };
};
