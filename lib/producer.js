/**
 * @namespace Producer
 */
var amqp = require('amqplib'),
  utils = require('./helpers/utils'),
  uuid = require('node-uuid'),
  parsers = require('./helpers/message-parsers');

var config;
var connected = false;
var connecting = false;
var reqQueue = [];
var productions = [];
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
    var deferred = new Promise(function(resolve) { resolve(amqpChannel); });
    reqQueue.push(deferred);
    return deferred;
  }

  connecting = true;

  amqpUrl = utils.getValidUrl([amqpUrl, _amqpUrl, config.amqpUrl, process.env.AMQP_URL, 'amqp://localhost']);

  return amqp.connect(amqpUrl)
  .then(function (_connection) {
    amqpConnection = _connection;

    amqpIntervalId = clearInterval(amqpIntervalId);

    amqpConnection.on('close', reconnect);
    amqpConnection.on('error', reconnect);

    return createChannel();
  })
  .catch(catchError);
};

/**
 * Create channel
 * @memberOf Producer
 * @return {Promise} - channel
 */
var createChannel = function() {
  return amqpConnection.createChannel()
  .then(function (_amqpChannel) {
    Logger.info('[BMQ-PRODUCER] is now connected and ready to produce messages');

    amqpChannel = _amqpChannel;

    connected = true;
    connecting = false;

    amqpIntervalId = clearInterval(amqpIntervalId);

    amqpChannel.on('close', reconnect);
    amqpChannel.on('error', reconnect);

    while (reqQueue.length > 0) {
      Promise.resolve(reqQueue.shift());
    }

    while (productions.length > 0) {
      var prod = productions.shift();
      produce(prod.queue, prod.msg, prod.options);
    }

    return amqpChannel;
  })
  .catch(catchError);
};

/**
 * Reconnect after a timeout
 * @memberOf Producer
 * @return {Nothing}
 */
var reconnect  = function() {
  if (!amqpIntervalId) {
    Logger.info('[BMQ-PRODUCER] Try to reconnect');
    connecting = false;
    connected = false;
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
      amqpConnection = undefined;
      amqpChannel = undefined;
      rpcQueues = [];
      amqpIntervalId = clearInterval(amqpIntervalId);
      Logger.info('[BMQ-PRODUCER] is now disconnected');
    });
  }
};

var rpcQueues = {};

function catchError(err) {
  amqpIntervalId = clearInterval(amqpIntervalId);
  Logger.error('[BMQ-PRODUCER] ', err.stack, '\n    occured while connecting');
  reconnect();
}

function createRpcQueue(queue) {
  if (rpcQueues[queue].queue) return Promise.resolve();

  return amqpChannel.assertQueue('', {exclusive: true})
  .then(function(qok) { return qok.queue; })
  .then(function(_queue) {
    rpcQueues[queue].queue = _queue;
    return amqpChannel.consume(_queue, maybeAnswer(queue), {noAck: true});
  })
  .then(function() { return queue; });
}

function maybeAnswer(queue) {
  return function(msg) {
    var corrIdA = msg.properties.correlationId;
    if (rpcQueues[queue][corrIdA] !== undefined) {
      msg = parsers.in(msg);
      rpcQueues[queue][corrIdA].resolve(msg);
      Logger.info('[BMQ-PRODUCER][' + queue + '] < ', msg);
      delete rpcQueues[queue][corrIdA];
    }
  };
}

function checkRpc(queue, msg, options) {
  if (options.rpc) {
    if (!rpcQueues[queue]) {
      rpcQueues[queue] = {};
    }

    return createRpcQueue(queue)
    .then(function(){
      var corrId = uuid.v4();
      options.correlationId = corrId;
      options.replyTo = rpcQueues[queue].queue;

      amqpChannel.sendToQueue(queue, msg, options);

      rpcQueues[queue][corrId] = Promise.defer();
      return rpcQueues[queue][corrId].promise;
    });
  }

  return amqpChannel.sendToQueue(queue, msg, options);
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
  if (!connected) {
    utils.pushIfNotExist(productions, {
      queue: _queue,
      options: _options,
      msg: _msg
    });
  }

  if (!_msg) return;

  _options = _options || { persistent: true, durable: true };

  Logger.info('[BMQ-PRODUCER][' + _queue + '] > ', _msg);

  _msg = parsers.out(_msg, _options);

  return connect().then(function() {
    return checkRpc(_queue, _msg, _options);
  });
};

module.exports = function (_config) {
  config = _config;

  return {
    connect: connect,
    disconnect: disconnect,
    produce: produce
  };
};
