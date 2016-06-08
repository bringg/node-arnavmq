/**
 * @namespace Consumer
 */
var parsers = require('./message-parsers'),
  utils = require('./utils');

function checkRpc (msg, queue) {
  return (_content) => {
    if (msg.properties.replyTo) {
      var options = { correlationId: msg.properties.correlationId };
      this.conn.config.transport.info('bmq:consumer', '[' + queue + '][' + msg.properties.replyTo + '] >', _content);
      this.channel.sendToQueue(msg.properties.replyTo, parsers.out(_content, options), options);
    }

    return msg;
  };
}

function consume (queue, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = { persistent: true, durable: true };
  }

  queue += this.conn.config.consumerSuffix;

  return this.conn.get()
  .then((_channel) => {
    this.channel = _channel;

    this.channel.addListener('close', () => {
      consume.call(this, queue, options, callback);
    });

    return this.channel.assertQueue(queue, options)
    .then((_queue) => {

      this.conn.config.transport.info('bmq:consumer', 'init', _queue.queue);

      this.channel.consume(_queue.queue, (_msg) => {
        this.conn.config.transport.info('bmq:consumer', '[' + _queue.queue + '] < ' + _msg.content.toString());

        Promise.resolve(parsers.in(_msg))
        .then(callback)
        .then(checkRpc.call(this, _msg, _queue.queue))
        .then(() => {
          this.channel.ack(_msg);
        })
        .catch((_err) => {
          this.conn.config.transport.error('bmq:consumer', _err);
          this.channel.reject(_msg, this.conn.config.requeue);
        });
      }, { noAck: false });

      return true;
    });
  })
  .catch(() => {
    utils.timeoutPromise(this.conn.config.timeout)
      .then(() => {
        consume.call(this, queue, options, callback);
      });
  });
}

module.exports = function(_conn) {
  return {
    conn: _conn,
    consume: consume
  };
};
