'use strict';

/**
 * @namespace Consumer
 */
var amqp = require('amqplib'),
  utils = require('./helpers/utils'),
  parsers = require('./helpers/message-parsers');

var amqpConnection, amqpChannel, amqpConfig;
var amqpReconnect = false;
var amqpQueues = [];

/**
 * Connect method used to connect the global connection object, when disconnected (not set). To be used inside a promise chain.
 * @return {Promise} When not connected, connects and returns a promise that resolve with the amqp connection object as parameter
 * @return {object} When connected, return the amqp connection object directly
 *
 * @example
 * return Promise.resolve()
 *   .then(connect)
 *   .then((conn) => {
 *     //conn is an amqp connection object
 *   });
 */
var connect = () => {
  if (!amqpConnection) {
    amqpChannel = null;
    amqpConnection = new Promise((resolve, reject) => {
      let amqpUrl = utils.getValidUrl([amqpConfig.amqpUrl, process.env.AMQP_URL, 'amqp://localhost']);

      amqp.connect(amqpUrl, { clientProperties: { hostname: process.env.HOSTNAME } })
      .then((_connection) => {

        _connection.on('close', (err) => {
          Logger.error(err);
          amqpConnection = null;
          amqpChannel = null;
        });

        _connection.on('error', Logger.error);

        amqpConnection = _connection;
        resolve(amqpConnection);
      })
      .catch((err) => {
        amqpConnection = null;
        reject(err);
      });
    });
  }

  return amqpConnection;
};

/**
 * createChannel method used to create a channel once connected. To be used inside a promise chain.
 * @return {Promise} When channel not created, returns a promise that resolve with the amqp channel object as parameter once channel is created
 * @return {object} When channel is created, return the channel object directly
 * 
 * @example
 * return Promise.resolve()
 *   .then(connect)
 *   .then(createChannel)
 *   .then((channel) => {
 *     //channel is an amqp channel object
 *   });
 */
var createChannel = () => {
  if (!amqpChannel) {
    amqpChannel = new Promise((resolve, reject) => {
      amqpConnection.createChannel()
        .then((_channel) => {
          _channel.prefetch(amqpConfig.amqpPrefetch);

          Logger.info('[BMQ-CONSUMER] Is now connected and ready to consume messages');

          _channel.on('close', (err) => {
            if (err) Logger.error('ERROR:', err);
            amqpChannel = null;
          });

          _channel.on('error', Logger.error);

          amqpChannel = _channel;
          resolve(amqpChannel);

          if (amqpReconnect) {
            amqpReconnect = false;
            for (var i = 0, l = amqpQueues.length; i < l; ++i) {
              consume(amqpQueues[i].queue, amqpQueues[i].options, amqpQueues[i].callback);
            }
          }
        })
        .catch((err) => {
          amqpChannel = null;
          reject(err);
        });
    });
  }

  return amqpChannel;
};

var checkRpc = (msg, queue) => {
  return function (_content) {
    if (_content !== undefined && msg.properties.replyTo) {
      var options = { correlationId: msg.properties.correlationId };
      Logger.info('[BMQ-CONSUMER][' + queue + '][' + msg.properties.replyTo + '] >', _content);
      amqpChannel.sendToQueue(msg.properties.replyTo, parsers.out(_content, options), options);
    }

    return msg;
  };
};

var consume = (queue, options, callback) => {
  if (typeof options === 'function') {
    callback = options;
    options = { persistent: true, durable: true };
  }

  queue += (process.env.LOCAL_QUEUE) ? process.env.LOCAL_QUEUE : '';


  return Promise.resolve()
  .then(connect)
  .then(createChannel)
  .then(() => {
    return amqpChannel.assertQueue(queue, options)
    .then((_queue) => {
      utils.pushIfNotExist(amqpQueues, { queue: queue, options: options, callback: callback });

      Logger.info('[BMQ-CONSUMER] Consume from queue:', _queue.queue);
      amqpChannel.consume(_queue.queue, (_msg) => {
        Logger.info('[BMQ-CONSUMER][' + _queue.queue + '] < ' + _msg.content.toString());

        Promise.resolve(parsers.in(_msg))
        .then(callback)
        .then(checkRpc(_msg, _queue.queue))
        .then(function () {
          amqpChannel.ack(_msg);
        })
        .catch((_err) => {
          Logger.error('[BMQ-CONSUMER] Error on queue: ' + _queue.queue, _err);
          amqpChannel.reject(_msg, amqpConfig.amqpRequeue);
        });
      }, { noAck: false });

      return true;
    });
  })
  .catch((err) => {
    Logger.error('[BMQ-CONSUMER]', err);
    return utils.timeoutPromise(amqpConfig.amqpTimeout)
    .then(() => {
      amqpReconnect = true;
      return consume(queue, options, callback);
    });
  });
};

module.exports = (config) => {
  amqpConfig = config;
  return { consume: consume };
};
