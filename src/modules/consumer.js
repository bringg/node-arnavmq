const { ChannelAlreadyExistsError } = require('./channels');
const parsers = require('./message-parsers');
const utils = require('./utils');

const loggerAlias = 'arnav_mq:consumer';

class Consumer {
  constructor(connection) {
    this._connection = connection;
    this._configuration = this._connection.config;
  }

  set connection(value) {
    this._connection = value;
    this._configuration = value.config;
  }

  get connection() {
    return this._connection;
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
        const options = {
          correlationId: msg.properties.correlationId,
          persistent: true,
          durable: true,
        };
        this._connection.config.transport.debug(loggerAlias, `[${queue}][${msg.properties.replyTo}] >`, content);
        this._connection.config.logger.debug({
          message: `${loggerAlias} [${queue}][${msg.properties.replyTo}] > ${content}`,
          params: { content },
        });

        return this._connection.getDefaultChannel().then((channel) => {
          return channel.sendToQueue(msg.properties.replyTo, parsers.out(content, options), options);
        });
      }

      return msg;
    };
  }

  /**
   * Create a durable queue on RabbitMQ and consumes messages from it - executing a callback function.
   * Automatically answers with the callback response (can be a Promise)
   * @param  {string}   queue    The RabbitMQ queue name
   * @param  {object}   options  (Optional) Options for the queue (durable, persistent, etc.) and channel (with prefetch, `{ channel: { prefetch: 100 } }`)
   * @param  {Function} callback Callback function executed when a message is received on the queue name, can return a promise
   * @return {Promise}           A promise that resolves when connection is established and consumer is ready
   */
  /* eslint no-param-reassign: "off" */
  consume(queue, options, callback) {
    return this.subscribe(queue, options, callback);
  }

  subscribe(queue, options, callback) {
    const defaultOptions = {
      persistent: true,
      durable: true,
      channel: {
        prefetch: this._configuration.prefetch,
      },
    };

    if (typeof options === 'function') {
      callback = options;
      options = defaultOptions;
    } else {
      options = {
        ...defaultOptions,
        ...options,
        channel: {
          ...defaultOptions.channel,
          ...(options.channel || {}),
        },
      };
    }

    // consumer gets a suffix if one is set on the configuration, to suffix all queues names
    // ex: service-something with suffix :ci becomes service-suffix:ci etc.
    const suffixedQueue = `${queue}${this._connection.config.consumerSuffix || ''}`;

    return this._connection
      .getChannel(queue, options.channel || {})
      .then((channel) => {
        // when channel is closed, we want to be sure we recreate the queue ASAP so we trigger a reconnect by recreating the consumer
        channel.addListener('close', () => {
          this.subscribe(queue, options, callback);
        });

        return channel
          .assertQueue(suffixedQueue, options)
          .then((q) => {
            this._connection.config.transport.debug(loggerAlias, 'init', q.queue);
            this._connection.config.logger.debug({
              message: `${loggerAlias} init ${q.queue}`,
              params: { queue: q.queue },
            });

            return this._consumeQueue(channel, q.queue, callback);
          })
          .catch((error) => {
            this._connection.config.transport.error(loggerAlias, error);
            this._connection.config.logger.error({
              message: `${loggerAlias} Failed to assert queue ${queue}: ${error.message}`,
              error,
              params: { queue },
            });
          });
        // in case of any error creating the channel, wait for some time and then try to reconnect again (to avoid overflow)
      })
      .catch((err) => {
        if (err instanceof ChannelAlreadyExistsError) {
          throw err;
        } else {
          return utils
            .timeoutPromise(this._connection.config.timeout)
            .then(() => this.subscribe(queue, options, callback));
        }
      });
  }

  _consumeQueue(channel, queue, callback) {
    return channel
      .consume(
        queue,
        (msg) => {
          if (!msg) {
            // When forcefully cancelled by rabbitmq, consumer would receive a null message.
            // https://amqp-node.github.io/amqplib/channel_api.html#channel_consume
            this._connection.config.transport.warn(loggerAlias, null);
            this._connection.config.logger.warn({
              message: `${loggerAlias} Consumer was cancelled by server for queue '${queue}'`,
              error: null,
              params: { queue },
            });
            return;
          }

          const messageString = msg.content.toString();
          this._connection.config.transport.debug(loggerAlias, `[${queue}] < ${messageString}`);
          this._connection.config.logger.debug({
            message: `${loggerAlias} [${queue}] < ${messageString}`,
            params: { queue, message: messageString },
          });

          // main answer management chaining
          // receive message, parse it, execute callback, check if should answer, ack/reject message
          Promise.resolve(parsers.in(msg))
            .then((body) => callback(body, msg.properties))
            .then(this.checkRpc(msg, queue))
            .then(() => {
              try {
                channel.ack(msg);
              } catch (ackError) {
                this._connection.config.transport.error(loggerAlias, ackError);
                this._connection.config.logger.error({
                  message: `${loggerAlias} Failed to ack message after processing finished on queue ${queue}: ${ackError.message}`,
                  error: ackError,
                  params: { queue },
                });
              }
            })
            .catch((error) => {
              // if something bad happened in the callback, reject the message so we can requeue it (or not)
              this._connection.config.transport.error(loggerAlias, error);
              this._connection.config.logger.error({
                message: `${loggerAlias} Failed processing message from queue ${queue}: ${error.message}`,
                error,
                params: { queue, message: messageString },
              });

              try {
                channel.reject(msg, this._connection.config.requeue);
              } catch (rejectError) {
                this._connection.config.transport.error(loggerAlias, rejectError);
                this._connection.config.logger.error({
                  message: `${loggerAlias} Failed to reject message after processing failure on queue ${queue}: ${rejectError.message}`,
                  error: rejectError,
                  params: { queue },
                });
              }
            });
        },
        { noAck: false }
      )
      .then(() => true)
      .catch((error) => {
        this._connection.config.transport.error(loggerAlias, error);
        this._connection.config.logger.error({
          message: `${loggerAlias} Failed to start consuming from queue ${queue}: ${error.message}`,
          error,
          params: { queue },
        });
      });
  }
}

/* eslint no-unused-expressions: "off" */
/* eslint no-sequences: "off" */
/* eslint arrow-body-style: "off" */
module.exports = Consumer;
