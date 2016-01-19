var winston = require('winston');
var amqp = require('./amqp-layer')();

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
        channel = _channel;
        connected = true;

        while (reqQueue.length > 0) {
          reqQueue.pop()();
        }
      });
    }
  } else {
    channel.sendToQueue(_queue, new Buffer(_msg), { persistent: true });
  }
};

module.exports = function (_config) {
  /**
   * amqpUrl
   * prefetch
   * noAck
   * durable
   */
  config = _config || {};
  return {
    produce: produce
  };
};
