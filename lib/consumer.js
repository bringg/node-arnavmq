/**
 * @namespace Consumer
 */
var amqp = require('amqplib'),
  utils = require('./helpers/utils'),
  parsers = require('./helpers/message-parsers');

var amqpConnection, amqpChannel, amqpUrl, amqpIntervalId, amqpConfig, amqpPrefetch, amqpState;
var amqpConnPool = [];
var amqpConsumptions = [];
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
        Logger.info('[BMQ-CONSUMER] Is trying to connect');

        amqpIntervalId = clearInterval(amqpIntervalId);

        amqpConnection.on('close', reconnect);
        amqpConnection.on('error', reconnect);

        return amqpConnection.createChannel();
      })
      .then(function (_channel) {
        amqpChannel = _channel;
        amqpChannel.prefetch(amqpConfig.amqpPrefetch);

        Logger.info('[BMQ-CONSUMER] Is now connected and ready to consume messages');

        amqpState = amqpStates.CONNECTED;

        amqpIntervalId = clearInterval(amqpIntervalId);

        amqpChannel.on('close', reconnect);
        amqpChannel.on('error', reconnect);

        while (amqpConnPool.length > 0) {
          amqpConnPool.shift()(amqpChannel);
        }

        if (amqpReconnection) {
          amqpReconnection = false;
          for (var i = 0, l = amqpConsumptions.length; i < l; ++i) {
            consume(amqpConsumptions[i].queue, amqpConsumptions[i].options, amqpConsumptions[i].callback);
          }
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

var checkRpc = function(msg, queue) {
  return function (_content) {
    if (_content !== undefined && msg.properties.replyTo) {
      var options = { correlationId: msg.properties.correlationId };
      Logger.info('[BMQ-CONSUMER][' + queue + '][' + msg.properties.replyTo + '] >', _content);
      amqpChannel.sendToQueue(msg.properties.replyTo, parsers.out(_content, options), options);
    }

    return msg;
  };
};

var consume = function(queue, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = { persistent: true, durable: true };
  }

  utils.pushIfNotExist('consumer', amqpConsumptions, { queue: queue, options: options, callback: callback });

  if (amqpState !== amqpStates.CONNECTED) {
    return connect()
    .then(function() {
      return consume(queue, options, callback);
    });
  }

  queue += (process.env.LOCAL_QUEUE) ? process.env.LOCAL_QUEUE : '';

  return amqpChannel.assertQueue(queue, options)
  .then(function (_q) {
    Logger.info('[BMQ-CONSUMER] Consume from queue:', _q.queue);
    amqpChannel.consume(_q.queue, function (_msg) {
      Logger.info('[BMQ-CONSUMER][' + _q.queue + '] < ' + _msg.content.toString());

      Promise.resolve(parsers.in(_msg))
      .then(callback)
      .then(checkRpc(_msg, _q.queue))
      .then(function () {
        amqpChannel.ack(_msg);
      })
      .catch(function (_err) {
        Logger.error('[BMQ-CONSUMER] Error on queue: ' + _q.queue, _err);
        amqpChannel.reject(_msg, amqpConfig.amqpRequeue);
      });
    }, { noAck: false });

    return true;
  });
};

module.exports = function (config) {
  amqpConfig = config;
  amqpState = amqpStates.DISCONNECTED;

  return {
    connect: connect,
    consume: consume
  };
};
