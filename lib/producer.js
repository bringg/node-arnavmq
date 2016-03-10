/**
 * @namespace Consumer
 */
var amqp = require('amqplib'),
  utils = require('./helpers/utils'),
  uuid = require('node-uuid'),
  parsers = require('./helpers/message-parsers');

var amqpConnection, amqpChannel, amqpUrl, amqpIntervalId, amqpConfig, amqpPrefetch, amqpState;
var amqpConnPool = [];
var amqpProductions = [];
var amqpRPCQueues = {};
var amqpReconnection = false;
var amqpStates = {
  DISCONNECTED: -1,
  CONNECTING: 0,
  CONNECTED: 1
};

var connect = function (url) {
  return new Promise(function (_resolve) {
    if (amqpState === amqpStates.DISCONNECTED) {
      amqpState = amqpStates.CONNECTING;

      amqpUrl = utils.getValidUrl([amqpUrl, url, amqpConfig.amqpUrl, process.env.AMQP_URL, 'amqp://localhost']);

      amqp.connect(amqpUrl, { clientProperties: { hostname: process.env.HOSTNAME } })
      .then(function (_connection) {
        amqpConnection = _connection;
        Logger.info('[BMQ-PRODUCER] Is trying to connect');

        amqpIntervalId = clearInterval(amqpIntervalId);

        amqpConnection.on('close', reconnect);
        amqpConnection.on('error', reconnect);

        return amqpConnection.createChannel();
      })
      .then(function (_channel) {
        amqpChannel = _channel;
        amqpChannel.prefetch(amqpConfig.prefetch);
        Logger.info('[BMQ-PRODUCER] Is now connected and ready to produce messages');

        amqpState = amqpStates.CONNECTED;

        amqpIntervalId = clearInterval(amqpIntervalId);

        amqpChannel.on('close', reconnect);
        amqpChannel.on('error', reconnect);

        while (amqpConnPool.length > 0) {
          amqpConnPool.shift()(amqpChannel);
        }

        while (amqpProductions.length > 0) {
          var prod = amqpProductions.shift();
          produce(prod.queue, prod.msg, prod.options);
        }

        _resolve(amqpChannel);
      })
      .catch(reconnect);
    } else if (amqpState === amqpStates.CONNECTING) {
      amqpConnPool.push(_resolve);
    } else {
      _resolve(amqpChannel);
    }
  });
};

var reconnect = function(err) {
  if (err) Logger.error('[BMQ-CONSUMER]', err);

  amqpIntervalId = (!amqpIntervalId) ? clearInterval(amqpIntervalId) : amqpIntervalId;
  Logger.info('[BMQ-CONSUMER] Try to reconnect');
  amqpState = amqpStates.DISCONNECTED;
  amqpReconnection = true;
  amqpIntervalId = setInterval(connect, 1000);
};

var createRpcQueue = function(queue) {
  if (amqpRPCQueues[queue].queue && !amqpReconnection) return Promise.resolve();

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

    if (!amqpChannel || !amqpConnection) return;

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
  if (amqpState !== amqpStates.CONNECTED) {
    utils.pushIfNotExist('producer', amqpProductions, { queue: queue, options: options, msg: msg });
    return connect()
    .then(function() {
      var prod = amqpProductions.shift();
      return produce(prod.queue, prod.msg, prod.options);
    });
  }

  if (!msg) return;

  options = options || { persistent: true, durable: true };

  Logger.info('[BMQ-PRODUCER][' + queue + '] > ', msg);

  msg = parsers.out(msg, options);

  return Promise.resolve(checkRpc(queue, msg, options));
};

module.exports = function (config) {
  amqpConfig = config;
  amqpState = amqpStates.DISCONNECTED;
  amqpPrefetch = amqpConfig.amqpPrefetch || process.env.AMQP_PREFETCH || 1;
  amqpPrefetch = (typeof amqpPrefetch !== 'number') ? parseInt(amqpPrefetch) : amqpPrefetch;

  return {
    connect: connect,
    produce: produce
  };
};
