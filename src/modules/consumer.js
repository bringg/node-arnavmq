const { ChannelAlreadyExistsError } = require('./channels');
const { ConsumerHooks } = require('./hooks');
const parsers = require('./message-parsers');
const utils = require('./utils');
const { logger } = require('./logger');

const loggerAlias = 'arnav_mq:consumer';

class Consumer {
  constructor(connection) {
    this._connection = connection;
    this._configuration = this._connection.config;
    this.hooks = new ConsumerHooks();
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
   * @param  {any} messageProperties   An amqp.node message properties object, containing the rpc settings
   * @param  {string} queue The initial queue on which the handler received the message
   * @param  {any} reply the received message to reply the rpc if needed:
   * @return {any}       object, string, number... the current received message
   */
  async checkRpc(messageProperties, queue, reply) {
    if (!messageProperties.replyTo) {
      return messageProperties;
    }

    const options = {
      correlationId: messageProperties.correlationId,
      persistent: true,
      durable: true,
    };
    const serializedReply = parsers.out(reply, options);
    await this.hooks.trigger(this, ConsumerHooks.beforeRpcReplyEvent, {
      receiveProperties: messageProperties,
      replyProperties: options,
      queue,
      reply,
      serializedReply,
      error: reply && reply.error ? reply.error : undefined,
    });
    logger.debug({
      message: `${loggerAlias} [${queue}][${messageProperties.replyTo}] > ${reply}`,
      params: { content: reply },
    });

    let written = false;
    let error;
    try {
      const defaultChannel = await this._connection.getDefaultChannel();
      written = defaultChannel.sendToQueue(messageProperties.replyTo, serializedReply, options);
      return written;
    } catch (err) {
      error = err;
      throw err;
    } finally {
      await this.hooks.trigger(this, ConsumerHooks.afterRpcReplyEvent, {
        receiveProperties: messageProperties,
        queue,
        reply,
        serializedReply,
        replyProperties: options,
        error,
        written,
      });
    }
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

  async subscribe(queue, options, callback) {
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

    const channel = await this._initializeChannel(queue, options || {}, callback);
    if (!channel) {
      // in case of any error creating the channel, wait for some time and then try to reconnect again (to avoid overflow)
      await utils.timeoutPromise(this._connection.config.timeout);
      return await this.subscribe(queue, options, callback);
    }

    try {
      await channel.assertQueue(suffixedQueue, options);
    } catch (error) {
      logger.error({
        message: `${loggerAlias} Failed to assert queue ${queue}: ${error.message}`,
        error,
        params: { queue },
      });
    }

    logger.debug({
      message: `${loggerAlias} init ${queue}`,
      params: { queue },
    });

    await this._consumeQueue(channel, queue, callback, options);
    return true;
  }

  async _initializeChannel(queue, options, callback) {
    let channel;
    try {
      channel = await this._connection.getChannel(queue, options.channel || {});
      // when channel is closed, we want to be sure we recreate the queue ASAP so we trigger a reconnect by recreating the consumer
      channel.addListener('close', () => {
        this.subscribe(queue, options, callback);
      });
      return channel;
    } catch (err) {
      if (err instanceof ChannelAlreadyExistsError) {
        throw err;
      }

      if (channel) {
        try {
          // Just in the odd chance the channel was open but the listener failed.
          await channel.close();
        } catch (closeError) {
          logger.error({
            message: `${loggerAlias} Failed to close channel after initialization error ${queue}: ${closeError.message}`,
            error: closeError,
            params: { queue },
          });
        }
      }
      return null;
    }
  }

  async _consumeQueue(channel, queue, callback, options) {
    const consumeFunc = async (msg) => {
      if (!msg) {
        // When forcefully cancelled by rabbitmq, consumer would receive a null message.
        // https://amqp-node.github.io/amqplib/channel_api.html#channel_consume
        logger.warn({
          message: `${loggerAlias} Consumer was cancelled by server for queue '${queue}'`,
          error: null,
          params: { queue },
        });
        return;
      }

      const messageString = msg.content.toString();
      logger.debug({
        message: `${loggerAlias} [${queue}] < ${messageString}`,
        params: { queue, message: messageString },
      });

      // main answer management chaining
      // receive message, parse it, execute callback, check if should answer, ack/reject message
      let body;
      try {
        body = parsers.in(msg);
      } catch (parseError) {
        // Handle message parsing errors (invalid JSON, etc.)
        if (options.onParseError) {
          // Let client decide how to handle parse errors (ACK/NACK)
          // Note: Client MUST call either actions.ack() or actions.nack()
          // to prevent message from being stuck in unacknowledged state
          await options.onParseError(parseError, msg, {
            ack: () => channel.ack(msg),
            nack: (requeue = true) => channel.nack(msg, false, requeue)
          });
        } else {
          // Default behavior: NACK with configured requeue setting (backwards compatible)
          logger.error({
            message: `${loggerAlias} Failed to parse message from queue ${queue}: ${parseError.message}`,
            error: parseError,
            params: { queue, message: messageString },
          });
          throw parseError;
        }
      }

      try {
        const action = { message: msg, content: body, callback };
        await this.hooks.trigger(this, ConsumerHooks.beforeProcessMessageEvent, {
          queue,
          action,
        });
        // Use callback from action in case it was changed/wrapped in the hook (for instance, for instrumentation)
        const res = await action.callback(body, msg.properties);
        await this.checkRpc(msg.properties, queue, res);
      } catch (error) {
        // if something bad happened in the callback, reject the message so we can requeue it (or not)
        logger.error({
          message: `${loggerAlias} Failed processing message from queue ${queue}: ${error.message}`,
          error,
          params: { queue, message: messageString },
        });

        await this._rejectMessageAfterProcess(channel, queue, msg, body, this._connection.config.requeue, error);
        return;
      }

      let ackError;
      try {
        channel.ack(msg);
      } catch (err) {
        ackError = err;

        logger.error({
          message: `${loggerAlias} Failed to ack message after processing finished on queue ${queue}: ${ackError.message}`,
          error: ackError,
          params: { queue },
        });
      }
      await this.hooks.trigger(this, ConsumerHooks.afterProcessMessageEvent, {
        queue,
        message: msg,
        content: body,
        ackError,
      });
    };

    try {
      await channel.consume(queue, consumeFunc, { noAck: false });
    } catch (error) {
      logger.error({
        message: `${loggerAlias} Failed to start consuming from queue ${queue}: ${error.message}`,
        error,
        params: { queue },
      });
    }
  }

  /** @private */
  async _rejectMessageAfterProcess(channel, queue, msg, parsedBody, requeue, error) {
    let rejectError;
    try {
      channel.reject(msg, requeue);

      if (!requeue) {
        // If not requeued and message will be removed from the queue, return rpc error response if needed.
        await this.checkRpc(msg.properties, queue, error instanceof Error ? { error } : undefined);
      }
    } catch (err) {
      rejectError = err;
      logger.error({
        message: `${loggerAlias} Failed to reject message after processing failure on queue ${queue}: ${rejectError.message}`,
        error: rejectError,
        params: { queue },
      });
    }

    await this.hooks.trigger(this, ConsumerHooks.afterProcessMessageEvent, {
      queue,
      message: msg,
      content: parsedBody,
      error,
      rejectError,
    });
  }
}

module.exports = Consumer;
