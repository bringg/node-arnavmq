var amqp = require('./amqp-layer')();
var logger = require('../helpers/logger')(true);

var channel, config;
var connected = connecting = false;
var reqQueue = [];

var connect = function(_amqpUrl) {
  connecting = true;

  return amqp.connect(_amqpUrl || config.amqpUrl)
  .then(function (_channel) {
    logger.log('info', '[AMQP] Consumer is now connected and ready to consume messages');

    channel = _channel;
    connected = true;

    while (reqQueue.length > 0) {
      reqQueue.pop()();
    }

    return channel;
  })
  .catch(function (_err) {
    logger.log('error', '[AMQP] Consumer ', _err.stack, '\n    occured while connecting');
    amqp.reconnect();
  });
};

var consume = function(_queue, _options, _callback) {
  _queue += (process.env.LOCAL_QUEUE ? process.env.LOCAL_QUEUE : '');

  if (!connected) {
    reqQueue.push(function () {
      consume(_queue, _options, _callback);
    });

    if (!connecting) {
      connect();
    }
  } else {
    var doneCallback = function (_msg) {
      var strMsg = _msg.content.toString();
      logger.log('info', '[AMQP] Consumer received msg:', strMsg);

      return Promise.resolve(strMsg)
      .then(_callback)
      .then(function (_response) {
        channel.ack(_msg);
      })
      .catch(function (_err) {
        logger.log('error', '[AMQP] Consumer ', _err.stack, '\n    occured while processing msg:', strMsg);
        if (_err) channel.reject(_msg, config.isRequeueEnabled);
      });
    };

    if (typeof _options === 'function') {
      _callback = _options;
      _options = { persistent: true, durable: false };
    }

    return channel.assertQueue(_queue, _options)
    .then(function (_q) {
      channel.prefetch(config.prefetch);
      channel.consume(_q.queue, doneCallback, { noAck: false });

      return _q.queue;
    });
  }
};

module.exports = function (_config) {
  config = _config;

  logger.enableDisableLog(config.isLogEnabled);

  return {
    connect: connect,
    disconnect:amqp.disconnect,
    consume: consume
  };
};
