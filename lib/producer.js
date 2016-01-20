var amqp = require('./amqp-layer')();
var logger = require('../helpers/logger')(true);

var channel, reqQueue, connected, connecting, config;
connected = connecting = false;
reqQueue = [];

var produce = function(_queue, _msg) {
  if (!_msg) return;

  if (typeof _msg === 'object') {
    _msg = JSON.stringify(_msg);
  }

  if (!connected) {
    reqQueue.push(function () {
      produce(_queue, _msg);
    });

    if (!connecting) {
      connecting = true;

      amqp.connect(config.amqpUrl)
      .then(function (_channel) {
        logger.log('info', '[AMQP] Producer is now connected and ready to produce messages');
        channel = _channel;
        connected = true;

        while (reqQueue.length > 0) {
          reqQueue.pop()();
        }
      })
      .catch(function (_err) {
        logger.log('error', '[AMQP] Producer ', _err.stack, '\n    occured while connecting');
        amqp.reconnect();
      });
    }
  } else {
    logger.log('info', '[AMQP] Producer populate msg:', _msg);
    channel.sendToQueue(_queue, new Buffer(_msg), { persistent: true });
  }
};

module.exports = function (_config) {
  config = _config;

  logger.enableDisableLog(config.isLogEnabled);

  return {
    produce: produce
  };
};
