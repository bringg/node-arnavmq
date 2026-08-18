const { ChannelAlreadyExistsError } = require('./channels');
const { ConsumerHooks } = require('./hooks');
const parsers = require('./message-parsers');
const utils = require('./utils');
const { logger } = require('./logger');

const loggerAlias = 'arnav_mq:consumer';

// How often `drain()` polls `inFlight()` while waiting for in-flight handlers to finish.
const DRAIN_POLL_INTERVAL_MS = 50;
// Fallback budget `drain()`/`stop()` give in-flight handlers to finish, only used if the
// `shutdownTimeout` config value (see src/index.js) is somehow unset.
const DEFAULT_DRAIN_TIMEOUT_MS = 30000;

class Consumer {
  constructor(connection) {
    this._connection = connection;
    this._configuration = this._connection.config;
    this.hooks = new ConsumerHooks();

    // Subscription registry, keyed by an incrementing id (NOT queue name - two consume() calls on
    // the same queue with different callbacks are legal, and queue-keying would silently drop a
    // consumerTag).
    this._subscriptions = [];
    // Set by cancelAll()/stop(): stops resubscribe/retry for every subscription, existing and future.
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
   * Whether stop()'s timeout path already rejected+requeued this delivery - so acking/rejecting/
   * RPC-replying to it again would double-handle a message another pod may already be processing.
   */
  _isAbandoned(subscription, msg) {
    return subscription.abandonedMessages.has(msg);
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
      inFlightMessages: new Set(), // Set<amqp.Message> - tracked so the drain/timeout path has the actual messages to reject, not just a count.
      abandonedMessages: new Set(), // Set<amqp.Message> - messages requeued by stop()'s timeout path; per-delivery guard against double ack/reject/RPC-reply.
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

    // A cancel()/cancelAll() may have landed while we were awaiting getChannel()/assertQueue() above.
    // Not required for correctness (the guard after `consumerTag` is set in `_consumeQueue` catches
    // it either way), it just skips a pointless basic.consume+basic.cancel round-trip pair.
    if (!this._isLive(subscription)) {
      return false;
    }

    await this._consumeQueue(channel, subscription);

    // A cancel() that landed *inside* _consumeQueue() has already been carried out on the broker by
    // now (see there), so this subscription never really went live - report that, the same way the
    // guards above do, instead of an unconditional `true`.
    return this._isLive(subscription);
  }

  async _initializeChannel(subscription) {
    const { queue, options } = subscription;
    let channel;
    try {
      channel = await this._connection.getChannel(queue, options.channel || {});

      // Same shared DEFAULT_CHANNEL object is reused across many subscriptions/reconnects - drop
      // this subscription's previous listener before adding a new one, or the channel accumulates one
      // 'close' listener per resubscribe and eventually hits MaxListenersExceededWarning.
      subscription.channel?.removeListener('close', subscription.onChannelClose);

      const onChannelClose = () => {
        // when channel is closed, we want to be sure we recreate the queue ASAP so we trigger a reconnect by recreating the consumer
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

      // amqplib invokes consumeFunc synchronously per delivery, so there is no window where a
      // message is "received" but untracked.
      subscription.inFlightMessages.add(msg);
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

          // Abandoned by stop()'s timeout path: it already rejected+requeued this delivery, so
          // another pod may already be replying to this RPC. Replying again would double-reply.
          if (!this._isAbandoned(subscription, msg)) {
            await this.checkRpc(msg.properties, queue, res);
          }
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

        // Abandoned by stop()'s timeout path: it already rejected this delivery on this channel.
        // Acking it too would hit amqplib's PRECONDITION_FAILED and close the (shared) channel.
        let ackError;
        if (!this._isAbandoned(subscription, msg)) {
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
        }
        await this.hooks.trigger(this, ConsumerHooks.afterProcessMessageEvent, {
          queue,
          message: msg,
          content: body,
          ackError,
        });
      } finally {
        subscription.inFlightMessages.delete(msg);
      }
    };

    try {
      const { consumerTag } = await channel.consume(subscription.queue, consumeFunc, { noAck: false });
      subscription.consumerTag = consumerTag;

      // A cancel()/cancelAll() that landed between _initializeChannel() and this point had no
      // consumerTag to cancel, so it only set `cancelled` and sent nothing to the broker. Now that
      // a real tag exists, actually cancel it - otherwise the subscription goes live despite having
      // been cancelled, and keeps consuming indefinitely on the public cancel() path.
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

    // Abandoned by stop()'s timeout path: it already rejected+requeued this delivery. Rejecting
    // again hits amqplib's PRECONDITION_FAILED (closing the shared channel), and replying again
    // to the RPC would double-reply alongside whichever pod picked up the requeued message.
    if (!this._isAbandoned(subscription, msg)) {
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
   * basic.cancel by consumerTag for every subscription on `queue`. Does NOT close the channel (it
   * is shared with other consumers and with RPC replies) and does NOT wait for in-flight handlers
   * - use `drain()`/`stop()` for that. Cancelled subscriptions are never resubscribed.
   * @param {string} queue The queue to stop consuming from.
   * @return {Promise<void>}
   */
  async cancel(queue) {
    const subscriptions = this._subscriptions.filter((sub) => sub.queue === queue);
    await Promise.all(subscriptions.map((sub) => this._cancelSubscription(sub)));
  }

  /**
   * cancel()s every subscription across every queue, and marks this consumer as shutting down so
   * no subscription resubscribes/retries afterward.
   * @return {Promise<void>}
   */
  async cancelAll() {
    this._shuttingDown = true;
    await Promise.all(this._subscriptions.map((sub) => this._cancelSubscription(sub)));
  }

  /** @private */
  async _cancelSubscription(subscription) {
    subscription.cancelled = true;

    // The resubscribe-on-close listener is dead weight once cancelled (it early-returns on the
    // `cancelled` flag above), and the channel it sits on is shared and long-lived - leaving it
    // attached leaks one listener per subscribe->cancel cycle, up to MaxListenersExceededWarning.
    // The subscription itself deliberately stays in `_subscriptions`: `_abandonInFlightMessages()` and
    // `inFlight()` still need it.
    if (subscription.onChannelClose) {
      subscription.channel?.removeListener('close', subscription.onChannelClose);
    }

    // The subscription may have no consumerTag yet - the broker was down at boot and it is sitting in
    // the retry loop, or _initializeChannel returned null. Nothing to cancel on the broker; the
    // `cancelled` flag above is what stops the pending retry from ever consuming.
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
  }

  /**
   * Resolves true once every in-flight message handler has finished (inFlight() reaches 0), or
   * false if `timeoutMs` elapses first. Cancels nothing - pair with `cancel()`/`cancelAll()`.
   *
   * Polls `inFlight()` every 50ms rather than resolving off a deferred set in the consume finally
   * block: with a shared channel and prefetch > 1, deliveries already buffered in the socket keep
   * arriving for a few ticks after cancel-ok, and a deferred would resolve on the first momentary
   * zero in between two such deliveries.
   * @param {number} [timeoutMs] How long to wait for in-flight handlers to finish. Defaults to the
   *   `shutdownTimeout` config value (30s).
   * @return {Promise<boolean>} true if drained before the timeout, false otherwise.
   */
  async drain(timeoutMs = this._configuration.shutdownTimeout ?? DEFAULT_DRAIN_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;

    while (this.inFlight() > 0) {
      if (Date.now() >= deadline) {
        return false;
      }
      await utils.timeoutPromise(DRAIN_POLL_INTERVAL_MS);
    }

    return true;
  }

  /**
   * cancelAll(), then drain(timeout). Idempotent - repeated calls share the one in-flight
   * shutdown promise instead of running cancelAll()/drain() more than once.
   *
   * If drain() times out, every message still in-flight for every subscription is rejected with
   * requeue=true (so another pod picks it up) and recorded in that subscription's
   * `abandonedMessages`, which guards the ack/reject/RPC-reply call sites the still-running
   * handler will eventually hit. The handler itself is not killed - it keeps running until the
   * process exits, its work simply duplicated elsewhere, which this system's at-least-once
   * delivery already assumes.
   * @param {object} [options]
   * @param {number} [options.timeout] Passed through to drain(). Defaults to 30s.
   * @return {Promise<{drained: boolean, abandoned: Record<string, number>}>} `drained` is true if
   *   every handler finished inside the budget, false if in-flight messages were abandoned.
   *   `abandoned` maps queue name to how many messages were abandoned on it (empty on a clean drain);
   *   callers use it to emit an abandoned-message metric.
   */
  async stop(options = {}) {
    if (!this._stopPromise) {
      this._stopPromise = this._stop(options.timeout);
    }

    return await this._stopPromise;
  }

  /** @private */
  async _stop(timeoutMs) {
    await this.cancelAll();

    const drained = await this.drain(timeoutMs);
    const abandoned = drained ? {} : this._abandonInFlightMessages();

    return { drained, abandoned };
  }

  /**
   * @private
   * @return {Record<string, number>} How many messages were abandoned per queue by this call. Queues
   *   with nothing in flight are absent, so a clean pass returns `{}`. Two subscriptions on the same
   *   queue contribute to the same entry.
   */
  _abandonInFlightMessages() {
    const abandoned = {};

    for (const subscription of this._subscriptions) {
      const { inFlightMessages, channel, queue } = subscription;
      if (inFlightMessages.size === 0) {
        continue;
      }

      const abandonedCount = inFlightMessages.size;
      abandoned[queue] = (abandoned[queue] || 0) + abandonedCount;

      for (const msg of inFlightMessages) {
        subscription.abandonedMessages.add(msg);

        if (!channel) {
          continue;
        }

        try {
          channel.reject(msg, true); // requeue -> another pod picks it up
        } catch (error) {
          logger.error({
            message: `${loggerAlias} Failed to reject abandoned in-flight message on queue ${queue}: ${error.message}`,
            error,
            params: { queue },
          });
        }
      }

      logger.warn({
        message: `${loggerAlias} Timed out waiting for in-flight handlers on queue ${queue}; abandoned and requeued ${abandonedCount} message(s)`,
        params: { queue, count: abandonedCount },
      });
    }

    return abandoned;
  }

  /**
   * Count of currently in-flight messages (handler running, not yet acked/rejected).
   * @return {number}
   */
  inFlight() {
    return this._subscriptions.reduce((total, sub) => total + sub.inFlightMessages.size, 0);
  }
}

module.exports = Consumer;
