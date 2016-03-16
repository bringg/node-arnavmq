/**
 * @namespace Consumer
 */
var amqp = require('amqplib'),
  utils = require('./helpers/utils'),
  uuid = require('node-uuid'),
  parsers = require('./helpers/message-parsers');

var amqpConnection, amqpChannel, amqpUrl, amqpConfig;
var amqpRPCQueues = {};

var amqpConnectionPromise = [];

var connect = function () {
  // console.log('amqpConnection:', amqpConnection);
  // console.log('amqpConnectionPromise:', amqpConnectionPromise);

  if (!amqpConnection) {
    amqpConnectionPromise = Promise.defer();
    amqpConnection = amqpConnectionPromise.promise;

    amqpUrl = utils.getValidUrl([amqpUrl, amqpConfig.amqpUrl, process.env.AMQP_URL, 'amqp://localhost']);

    return amqp.connect(amqpUrl, { clientProperties: { hostname: process.env.HOSTNAME } })
    .then(function (_connection) {
      // amqpConnectionPromise.resolve(_connection);
      amqpConnection = _connection;

      Logger.info('[BMQ-PRODUCER] Is trying to connect');

      amqpConnection.on('close', function (err) {
        if (err) Logger.error('[BMQ-PRODUCER]', err);
        amqpConnection = null;
      });

      amqpConnection.on('error', function (err) {
        Logger.error('[BMQ-PRODUCER]', err);
      });

      return amqpConnection;
    });
  } else {
    return Promise.resolve(amqpConnection);
  }
};

var amqpChannelPromise;

var createChannel = function () {
  if (!amqpChannel) {
    amqpChannelPromise = Promise.defer();
    amqpChannel = amqpChannelPromise.promise;
    return amqpConnection.createChannel()
    .then(function (_channel) {
      _channel.prefetch(amqpConfig.amqpPrefetch);

      // while (amqpConnectionPromise.length) {
      //   amqpConnectionPromise.shift().resolve(_channel);
      // }

      amqpChannelPromise.resolve(_channel);
      amqpChannel = _channel;

      Logger.info('[BMQ-PRODUCER] Is now connected and ready to produce messages');

      amqpChannel.on('close', function (err) {
        if (err) Logger.error('[BMQ-PRODUCER]', err);
        amqpChannel = null;
      });

      amqpChannel.on('error', function (err) {
        Logger.error('[BMQ-PRODUCER]', err);
      });

      return amqpChannel;
    });
  } else {
    return Promise.resolve(amqpChannel);
  }
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
  return connect()
  .then(createChannel)
  .then(function () {
    if (!msg) return;

    options = options || { persistent: true, durable: true };

    Logger.info('[BMQ-PRODUCER][' + queue + '] > ', msg);

    return checkRpc(queue, parsers.out(msg, options), options);
  })
  .catch(function (err) {
    Logger.error('[BMQ-PRODUCER]', err);

    amqpConnection = null;
    amqpChannel = null;
    return produce(queue, msg, options);
  });
};

module.exports = function (config) {
  amqpConfig = config;

  return { produce: produce };
};
