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

var consume = function(_queue, _callback) {
  _queue += (process.env.LOCAL_QUEUE ? process.env.LOCAL_QUEUE : '');

  if (!connected) {
    reqQueue.push(function () {
      consume(_queue, _callback);
    });

    if (!connecting) {
      connect();
    }
  } else {
    var done_callback = function (_msg) {
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

    channel.assertQueue(_queue, { durable: true })
    .then(function () {
      channel.prefetch(config.prefetch);
      channel.consume(_queue, done_callback, { noAck: false });
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
