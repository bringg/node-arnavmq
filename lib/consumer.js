var winston = require('winston');
var amqp = require('./amqp-layer')();

var channel, reqQueue, connected, connecting, config;
connected = connecting = false;
reqQueue = [];

var consume = function(_queue, _callback) {
  _queue += (process.env.LOCAL_QUEUE ? process.env.LOCAL_QUEUE : '');

  if (!connected) {
    reqQueue.push(function () {
      consume(_queue, _callback);
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
    var done_callback = function (_msg) {
      return Promise.resolve(_msg.content.toString())
      .then(_callback)
      .then(function (_response) {
        channel.ack(_msg);
      })
      .catch(function (err) {
        // if (err) channel.nack();
      });
    };

    channel.assertQueue(_queue, { durable: true })
    .then(function () {
      channel.prefetch(1);
      channel.consume(_queue, done_callback, { noAck: false });
    });
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
    consume: consume
  };
};
