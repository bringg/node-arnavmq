const parsers = require('./message-parsers');
const utils = require('./utils');
const assert = require('assert');

class Consumer {
  constructor(connection) {
    this._connection = connection;
    this.channel = null;
  }

  get connection() {
    return this._connection;
  }

  set connection(value) {
    this._connection = value;
  }

  /**
   * Get a function to execute on incoming messages to handle RPC
   * @param  {any} msg   An amqp.node message object
   * @param  {string} queue The initial queue on which the handler received the message
   * @return {function}       a function to use in a chaining on incoming messages
   */
  checkRpc(msg, queue) {
    /**
     * When message contains a replyTo property, we try to send the answer back
     * @param  {any} content the received message:
     * @return {any}          object, string, number... the current received message
     */
    return (content) => {
      if (msg.properties.replyTo) {
        const options = { correlationId: msg.properties.correlationId, persistent: true, durable: true };
        this._connection.config.transport.info('bmq:consumer', `[${queue}][${msg.properties.replyTo}] >`, content);
        this.channel.sendToQueue(msg.properties.replyTo, parsers.out(content, options), options);
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
   /* eslint no-param-reassign: "off" */
  consume(queue, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      // default message options
      options = { persistent: true, durable: true };
    }

    // consumer gets a suffix if one is set on the configuration, to suffix all queues names
    // ex: service-something with suffix :ci becomes service-suffix:ci etc.
    const suffixedQueue = queue + this._connection.config.consumerSuffix;

    return this._connection.get()
    .then((channel) => {
      this.channel = channel;

      // when channel is closed, we want to be sure we recreate the queue ASAP so we trigger a reconnect by recreating the consumer
      this.channel.addListener('close', () => {
        this.consume(queue, options, callback);
      });

      return this.channel.assertQueue(suffixedQueue, options)
      .then((q) => {
        this._connection.config.transport.info('bmq:consumer', 'init', q.queue);

        this.channel.consume(q.queue, (msg) => {
          this._connection.config.transport.info('bmq:consumer', `[${q.queue}] < ${msg.content.toString()}`);

          // main answer management chaining
          // receive message, parse it, execute callback, check if should answer, ack/reject message
          Promise.resolve(parsers.in(msg))
          .then(callback)
          .then(this.checkRpc(msg, q.queue))
          .then(() => {
            this.channel.ack(msg);
          })
          .catch((err) => {
            // if something bad happened in the callback, reject the message so we can requeue it (or not)
            this._connection.config.transport.error('bmq:consumer', err);
            this.channel.reject(msg, this._connection.config.requeue);
          });
        }, { noAck: false });

        return true;
      });
    })
    .catch(() =>
      // in case of any error creating the channel, wait for some time and then try to reconnect again (to avoid overflow)
      utils.timeoutPromise(this._connection.config.timeout)
        .then(() => this.consume(queue, options, callback))
    );
  }
}

let instance;

/* eslint no-unused-expressions: "off" */
/* eslint no-sequences: "off" */
/* eslint arrow-body-style: "off" */
module.exports = (connection) => {
  assert(instance || connection, 'Consumer can not be created because connection does not exist');

  if (!instance) {
    instance = new Consumer(connection);
  } else {
    instance.connection = connection;
  }
  return instance;
};
