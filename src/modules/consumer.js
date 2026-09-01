const { ChannelAlreadyExistsError } = require('./channels');
const { ConsumerHooks } = require('./hooks');
const parsers = require('./message-parsers');
const utils = require('./utils');
const { logger } = require('./logger');

const loggerAlias = 'arnav_mq:consumer';

// How often `drain()` polls `inFlight()` while waiting for in-flight handlers to finish.
const DRAIN_POLL_INTERVAL_MS = 50;

class Consumer {
  constructor(connection) {
    this._connection = connection;
    this._configuration = this._connection.config;
    this.hooks = new ConsumerHooks();

    // Subscription registry, keyed by an incrementing id (NOT queue name - two consume() calls on
    // the same queue with different callbacks are legal, and queue-keying would silently drop a
    // consumerTag).
    this._subscriptions = [];
    // Set by _cancelAll()/stop(): stops resubscribe/retry for every subscription, existing and future.
    this._shuttingDown = false;
    // Memoized stop() promise, so repeated calls share one in-flight shutdown instead of racing.
    this._stopPromise = null;
  }

  set connection(value) {
    this._connection = value;
    this._configuration = value.config;
  }

  get connection() {
    return this._connection;
  }

  /**
   * Whether a subscription is still eligible to (re)subscribe/consume - i.e. neither the consumer
   * as a whole nor this particular subscription has been told to shut down, and the underlying
   * connection isn't terminally closed (checked directly so this holds even for a caller that
   * closes the connection without going through `arnavmq.close()`'s consumer.stop() first).
   * @param {object} subscription
   * @return {boolean}
   */
  _isLive(subscription) {
    return !this._shuttingDown && !subscription.cancelled && !this._connection.isClosed;
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

    const subscription = {
      queue,
      options,
      callback,
      channel: null,
      consumerTag: null,
      onChannelClose: null,
      cancelled: false,
      inFlightCount: 0, // handlers currently running, not yet acked/rejected.
    };
    this._subscriptions.push(subscription);

    return await this._subscribe(subscription);
  }

  async _subscribe(subscription) {
    if (!this._isLive(subscription)) {
      return false;
    }

    const { queue, options } = subscription;

    // consumer gets a suffix if one is set on the configuration, to suffix all queues names
    // ex: service-something with suffix :ci becomes service-suffix:ci etc.
    const suffixedQueue = `${queue}${this._connection.config.consumerSuffix || ''}`;

    const channel = await this._initializeChannel(subscription);
    if (!channel) {
      // in case of any error creating the channel, wait for some time and then try to reconnect again (to avoid overflow)
      await utils.timeoutPromise(this._connection.config.timeout);
      if (!this._isLive(subscription)) {
        return false;
      }
      return await this._subscribe(subscription);
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

    if (!this._isLive(subscription)) {
      return false;
    }

    await this._consumeQueue(channel, subscription);

    // A cancel() that landed *inside* _consumeQueue() might have already been carried out on the broker in a race
    return this._isLive(subscription);
  }

  async _initializeChannel(subscription) {
    const { queue, options } = subscription;
    let channel;
    try {
      channel = await this._connection.getChannel(queue, options.channel || {});

      //If the channel is reused, it could already have a listener. Remove it to avoid multiple listeners on the same channel.
      subscription.channel?.removeListener('close', subscription.onChannelClose);

      const onChannelClose = () => {
        if (!this._isLive(subscription)) {
          return;
        }
        this._subscribe(subscription);
      };
      channel.addListener('close', onChannelClose);
      subscription.channel = channel;
      subscription.onChannelClose = onChannelClose;

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

  async _consumeQueue(channel, subscription) {
    const { queue, callback } = subscription;

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

      if (!this._isLive(subscription)) {
        // Buffered by the broker before cancel-ok landed (prefetch > 1) - hand it straight back
        // instead of running the handler, so it can't block drain()/stop()/close() on work that
        // was never going to be allowed to finish here.
        try {
          channel.reject(msg, true);
        } catch (error) {
          logger.error({
            message: `${loggerAlias} Failed to reject message received after shutdown on queue ${queue}: ${error.message}`,
            error,
            params: { queue },
          });
        }
        return;
      }

      subscription.inFlightCount += 1;
      try {
        const messageString = msg.content.toString();
        logger.debug({
          message: `${loggerAlias} [${queue}] < ${messageString}`,
          params: { queue, message: messageString },
        });

        let body = {};
        try {
          body = parsers.in(msg);

          const action = { message: msg, content: body, callback };
          await this.hooks.trigger(this, ConsumerHooks.beforeProcessMessageEvent, {
            queue,
            action,
          });
          // Use callback from action in case it was changed/wrapped in the hook (for instance, for instrumentation)
          const res = await action.callback(body, msg.properties);

          await this.checkRpc(msg.properties, queue, res);
        } catch (error) {
          logger.error({
            message: `${loggerAlias} Failed processing message from queue ${queue}: ${error.message}`,
            error,
            params: { queue, message: messageString },
          });
          // For callback errors, use default behavior with _rejectMessageAfterProcess
          let shouldRequeue = this._connection.config.requeue;
          if (error instanceof SyntaxError) {
            // For parsing errors, reject the message and don't requeue it.
            shouldRequeue = false;
          }

          await this._rejectMessageAfterProcess(channel, subscription, msg, body, shouldRequeue, error);
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
      } finally {
        subscription.inFlightCount -= 1;
        this._removeIfDone(subscription);
      }
    };

    try {
      const { consumerTag } = await channel.consume(subscription.queue, consumeFunc, { noAck: false });
      subscription.consumerTag = consumerTag;

      if (!this._isLive(subscription)) {
        await this._cancelSubscription(subscription);
      }
    } catch (error) {
      logger.error({
        message: `${loggerAlias} Failed to start consuming from queue ${queue}: ${error.message}`,
        error,
        params: { queue },
      });
    }
  }

  /** @private */
  async _rejectMessageAfterProcess(channel, subscription, msg, parsedBody, requeue, error) {
    const { queue } = subscription;
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

  /**
   * Cancels every subscription across every queue, and marks this consumer as shutting down so
   * no subscription resubscribes/retries afterward.
   * @private
   * @return {Promise<void>}
   */
  async _cancelAll() {
    this._shuttingDown = true;
    await Promise.all(this._subscriptions.map((sub) => this._cancelSubscription(sub)));
  }

  /** @private */
  async _cancelSubscription(subscription) {
    subscription.cancelled = true;
    if (subscription.onChannelClose) {
      // Does nothing if the subscription is already cancelled
      subscription.channel?.removeListener('close', subscription.onChannelClose);
    }

    if (!subscription.channel || !subscription.consumerTag) {
      return;
    }

    try {
      await subscription.channel.cancel(subscription.consumerTag);
    } catch (error) {
      logger.error({
        message: `${loggerAlias} Failed to cancel consumer (tag: ${subscription.consumerTag}) for queue ${subscription.queue}: ${error.message}`,
        error,
        params: { queue: subscription.queue },
      });
    }

    this._removeIfDone(subscription);
  }

  /**
   * Drops a cancelled, fully-drained subscription from `_subscriptions` - otherwise repeated
   * cancel/re-subscribe cycles in a long-lived process grow the registry (and its retained
   * callbacks/options/channel references) without bound.
   * @private
   * @param {object} subscription
   */
  _removeIfDone(subscription) {
    if (!subscription.cancelled || subscription.inFlightCount > 0) {
      return;
    }

    const index = this._subscriptions.indexOf(subscription);
    if (index !== -1) {
      this._subscriptions.splice(index, 1);
    }
  }

  /**
   * Resolves once every in-flight message handler has finished (inFlight() reaches 0). Cancels
   * nothing - pair with `stop()`. No timeout: a handler that never finishes means
   * this never resolves, and shutdown is left to the process orchestrator's own kill grace period.
   *
   * Polls `inFlight()` every 50ms rather than resolving off a deferred set in the consume finally
   * block: with a shared channel and prefetch > 1, deliveries already buffered in the socket keep
   * arriving for a few ticks after cancel-ok, and a deferred would resolve on the first momentary
   * zero in between two such deliveries.
   * @private
   * @return {Promise<void>}
   */
  async _drain() {
    while (this.inFlight() > 0) {
      await utils.timeoutPromise(DRAIN_POLL_INTERVAL_MS);
    }
  }

  /**
   * _cancelAll(), then _drain(). Idempotent - repeated calls share the one in-flight shutdown
   * promise instead of running those steps more than once. Internal - not part of the object
   * arnavmq.js's factory returns publicly; call `close()` on the top-level module instead.
   * @return {Promise<void>} Resolves once every in-flight handler has finished.
   */
  async stop() {
    if (!this._stopPromise) {
      this._stopPromise = (async () => {
        await this._cancelAll();
        await this._drain();
      })();
    }

    return await this._stopPromise;
  }

  /**
   * Count of currently in-flight messages (handler running, not yet acked/rejected).
   * @return {number}
   */
  inFlight() {
    return this._subscriptions.reduce((total, sub) => total + sub.inFlightCount, 0);
  }
}

module.exports = Consumer;
