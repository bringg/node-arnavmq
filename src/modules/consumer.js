var parsers = require('./message-parsers'),
  utils = require('./utils');

/**
 * Get a function to execute on incoming messages to handle RPC
 * @param  {any} msg   An amqp.node message object
 * @param  {string} queue The initial queue on which the handler received the message
 * @return {function}       a function to use in a chaining on incoming messages
 */
function checkRpc (msg, queue) {
  /**
   * When message contains a replyTo property, we try to send the answer back
   * @param  {any} _content the received message:
   * @return {any}          object, string, number... the current received message
   */
  return (_content) => {
    if (msg.properties.replyTo) {
      var options = { correlationId: msg.properties.correlationId };
      this.conn.config.transport.info('bmq:consumer', '[' + queue + '][' + msg.properties.replyTo + '] >', _content);
      this.channel.sendToQueue(msg.properties.replyTo, parsers.out(_content, options), options);
    }

    return msg;
  };
}

/**
 * Create a durable queue on RabbitMQ and consumes messages from it - executing a callback function.
 * Automaticaly answers with the callback response (can be a Promise)
 * @param  {string}   queue    The RabbitMQ queue name
 * @param  {object}   options  (Optional) Options for the queue (durable, persistent, etc.)
 * @param  {Function} callback Callback function executed when a message is received on the queue name, can return a promise
 * @return {Promise}           A promise that resolves when connection is established and consumer is ready
 */
function consume (queue, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    //default message options
    options = { persistent: true, durable: true };
  }

  //consumer gets a suffix if one is set on the configuration, to suffix all queues names
  //ex: service-something with suffix :ci becomes service-suffix:ci etc.
  queue += this.conn.config.consumerSuffix;

  return this.conn.get()
  .then((_channel) => {
    this.channel = _channel;

    //when channel is closed, we want to be sure we recreate the queue ASAP so we trigger a reconnect by recreating the consumer
    this.channel.addListener('close', () => {
      consume.call(this, queue, options, callback);
    });

    return this.channel.assertQueue(queue, options)
    .then((_queue) => {

      this.conn.config.transport.info('bmq:consumer', 'init', _queue.queue);

      this.channel.consume(_queue.queue, (_msg) => {
        this.conn.config.transport.info('bmq:consumer', '[' + _queue.queue + '] < ' + _msg.content.toString());

        //main answer management chaining
        //receive message, parse it, execute callback, check if should answer, ack/reject message
        Promise.resolve(parsers.in(_msg))
        .then(callback)
        .then(checkRpc.call(this, _msg, _queue.queue))
        .then(() => {
          this.channel.ack(_msg);
        })
        .catch((_err) => {
          //if something bad happened in the callback, reject the message so we can requeue it (or not)
          this.conn.config.transport.error('bmq:consumer', _err);
          this.channel.reject(_msg, this.conn.config.requeue);
        });
      }, { noAck: false });

      return true;
    });
  })
  .catch(() => {
    //in case of any error creating the channel, wait for some time and then try to reconnect again (to avoid overflow)
    return utils.timeoutPromise(this.conn.config.timeout)
      .then(() => {
        return consume.call(this, queue, options, callback);
      });
  });
}

module.exports = function(_conn) {
  return {
    conn: _conn,
    consume: consume
  };
};
