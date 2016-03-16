'use strict';

/**
 * @namespace Consumer
 */
var amqp = require('amqplib'),
  utils = require('./helpers/utils'),
  uuid = require('node-uuid'),
  parsers = require('./helpers/message-parsers');

var amqpConnection, amqpChannel, amqpConfig;
var amqpRPCQueues = {};

var connect = function () {
  if (!amqpConnection) {
    amqpChannel = null;
    amqpConnection = new Promise((resolve, reject) => {
      let amqpUrl = utils.getValidUrl([amqpConfig.amqpUrl, process.env.AMQP_URL, 'amqp://localhost']);

      amqp.connect(amqpUrl, { clientProperties: { hostname: process.env.HOSTNAME } })
      .then((_connection) => {

        _connection.on('close', function (err) {
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

var createChannel = function () {
  if (!amqpChannel) {
    amqpChannel = new Promise((resolve, reject) => {
      amqpConnection.createChannel()
        .then((_channel) => {
          _channel.prefetch(amqpConfig.amqpPrefetch);

          Logger.info('[BMQ-PRODUCER] Is now connected and ready to produce messages');

          _channel.on('close', function (err) {
            Logger.error(err);
            amqpChannel = null;
          });

          _channel.on('error', Logger.error);

          amqpChannel = _channel;
          resolve(amqpChannel);
        })
        .catch((err) => {
          amqpChannel = null;
          reject(err);
        });
    });
  }

  return amqpChannel;
};

var createRpcQueue = function(queue) {
  if (amqpRPCQueues[queue].queue) return Promise.resolve();

  var resQueue = queue + ':' + (process.env.HOSTNAME || uuid.v4()) + ':res';
  return amqpChannel.assertQueue(resQueue, { durable: true, exclusive: true })
  .then(function (_q) {
    amqpRPCQueues[queue].queue = _q.queue;
    return amqpChannel.consume(_q.queue, maybeAnswer(queue), { noAck: true });
  })
  .then(function() { return queue; });
};

var maybeAnswer = function(queue) {
  return function (_msg) {
    var corrIdA = _msg.properties.correlationId;
    if (amqpRPCQueues[queue][corrIdA] !== undefined) {
      _msg = parsers.in(_msg);
      amqpRPCQueues[queue][corrIdA].resolve(_msg);
      Logger.info('[BMQ-PRODUCER][' + queue + '] < ', _msg);
      delete amqpRPCQueues[queue][corrIdA];
    }
  };
};

var checkRpc = function (queue, msg, options) {
  options.persistent = true;

  if (options.rpc) {
    if (!amqpRPCQueues[queue]) {
      amqpRPCQueues[queue] = {};
    }

    return createRpcQueue(queue)
    .then(function () {
      var corrId = uuid.v4();
      options.correlationId = corrId;
      options.replyTo = amqpRPCQueues[queue].queue;

      amqpChannel.sendToQueue(queue, msg, options);

      amqpRPCQueues[queue][corrId] = Promise.defer();
      return amqpRPCQueues[queue][corrId].promise;
    });
  }

  return amqpChannel.sendToQueue(queue, msg, options);
};

var produce = function(queue, msg, options) {
  return Promise.resolve()
  .then(connect)
  .then(createChannel)
  .then(function () {
    if (!msg) return;
    options = options || { persistent: true, durable: true };

    Logger.info('[BMQ-PRODUCER][' + queue + '] > ', msg);

    return checkRpc(queue, parsers.out(msg, options), options);
  })
  .catch(function (err) {
    Logger.error('[BMQ-PRODUCER]', err);
    return produce(queue, msg, options);
  });
};

module.exports = function (config) {
  amqpConfig = config;

  return { produce: produce };
};
