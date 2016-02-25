/**
 * @namespace Consumer
 */
var amqp = require('amqplib'),
  utils = require('./helpers/utils'),
  parsers = require('./helpers/message-parsers');

var config;
var connected = false;
var connecting = false;
var reconnection = false;
var reqQueue = [];
var consumptions = [];
var amqpUrl, amqpConnection, amqpChannel, amqpIntervalId;

function init() {
  connected = false;
  connecting = false;
  reconnection = false;
  reqQueue = [];
  consumptions = [];
  amqpUrl = undefined;
  amqpConnection = undefined;
  amqpChannel = undefined;
  amqpIntervalId = clearInterval(amqpIntervalId);
}


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

  amqpUrl = utils.getValidUrl([amqpUrl, _amqpUrl, config.amqpUrl, process.env.AMQP_URL, 'amqp://localhost']);

  return amqp.connect(amqpUrl)
  .then(function (_connection) {
    amqpConnection = _connection;

    amqpIntervalId = clearInterval(amqpIntervalId);

    amqpConnection.on('close', catchError);
    amqpConnection.on('error', catchError);

    return createChannel();
  })
  .catch(catchError);
};

/**
 * Create channel
 * @memberOf Consumer
 * @return {Promise} - channel
 */
var createChannel = function() {
  return amqpConnection.createChannel()
  .then(function (_amqpChannel) {
    Logger.info('[BMQ-CONSUMER] is now connected and ready to consume messages');

    amqpChannel = _amqpChannel;
    amqpChannel.prefetch(config.prefetch || process.env.AMQP_PREFETCH);

    connected = true;
    connecting = false;

    amqpIntervalId = clearInterval(amqpIntervalId);

    amqpChannel.on('close', catchError);
    amqpChannel.on('error', catchError);

    while (reqQueue.length > 0) {
      Promise.resolve(reqQueue.shift());
    }

    if (reconnection) {
      reconnection = false;
      for (var i = 0, l = consumptions.length; i < l; ++i) {
        consume(consumptions[i].queue, consumptions[i].options, consumptions[i].callback);
      }
    }

    return amqpChannel;
  })
  .catch(catchError);
};

/**
 * Reconnect after a timeout
 * @memberOf Consumer
 * @return {Nothing}
 */
var reconnect = function() {
  if (!amqpIntervalId) {
    Logger.info('[BMQ-CONSUMER] Try to reconnect');
    connecting = false;
    connected = false;
    reconnection = true;
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
      init();
      Logger.info('[BMQ-CONSUMER] is now disconnected');
    });
  }
};

function catchError(err) {
  if (err) Logger.error('[BMQ-CONSUMER] ', err.stack, '\n    occured while connecting');
  amqpIntervalId = clearInterval(amqpIntervalId);
  reconnect();
}

function checkRpc(_msg, _queue) {
  return function(content) {
    if (content !== undefined && _msg.properties.replyTo) {
      var options = { correlationId: _msg.properties.correlationId };
      Logger.info('[BMQ-CONSUMER][' + _queue + '][' + _msg.properties.replyTo + '] > ', content);
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
  if (typeof _options === 'function') {
    _callback = _options;
    _options = { persistent: true, durable: true };
  }

  utils.pushIfNotExist('consumer', consumptions, {
    queue: _queue,
    options: _options,
    callback: _callback
  });

  if (!connected) {
    return connect().then(function() {
      return consume(_queue, _options, _callback);
    });
  }

  _queue += (process.env.LOCAL_QUEUE ? process.env.LOCAL_QUEUE : '');

  return amqpChannel.assertQueue(_queue, _options)
  .then(function (_q) {
    Logger.info('[BMQ-CONSUMER] Consume from queue:', _queue);
    amqpChannel.consume(_q.queue, function(msg) {
      Logger.info('[BMQ-CONSUMER][' + _queue + '] < ' + msg.content.toString());

      Promise.resolve(parsers.in(msg))
      .then(_callback)
      .then(checkRpc(msg, _queue))
      .then(function() {
        amqpChannel.ack(msg);
      })
      .catch(function (e) {
        Logger.error('[BMQ-CONSUMER] error on queue: ' + _queue, e);
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
