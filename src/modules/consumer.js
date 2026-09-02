const { ChannelAlreadyExistsError } = require('./channels');
const { ConnectionClosedError } = require('./connection');
const { ConsumerHooks } = require('./hooks');
const parsers = require('./message-parsers');
const utils = require('./utils');
const { logger } = require('./logger');

const loggerAlias = 'arnav_mq:consumer';

// How often `_drain()` polls `inFlight()` while waiting for in-flight handlers to finish.
const DRAIN_POLL_INTERVAL_MS = 50;

class Consumer {
  constructor(connection) {
    this._connection = connection;
    this._configuration = this._connection.config;
    this.hooks = new ConsumerHooks();

    // One record per subscribe() call, NOT per queue - two subscribe() calls on the same queue with
    // different callbacks are legal, and each gets its own consumerTag.
    this._subscriptions = [];
    // Memoized stop() promise - the same idiom as Connection._closePromise, and doubling as the
    // "shutting down" flag that `_isLive` reads. It has to be memoized regardless: without it a
    // concurrent close() re-runs _cancelAll() and sends basic.cancel for a tag already cancelled,
    // and the obvious alternatives (an early return on `cancelled`, clearing consumerTag) both
    // break _consumeQueue's deferred re-cancel for a subscription cancelled mid-flight.
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
    return !this._stopPromise && !subscription.cancelled && !this._connection.isClosed;
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
   * @return {Promise<boolean>}  Resolves `true` once the broker has confirmed the consumer
   *   (basic.consume-ok), or `false` if the subscription was cancelled before that. Failures that
   *   may still clear - the channel cannot be opened, the queue cannot be declared as asked - are
   *   retried behind `config.timeout` rather than resolved, so this stays pending while a queue is
   *   undeclarable and never reports success for a subscription that is not consuming.
   *   Rejects with `ConnectionClosedError` if the connection has already been closed.
   */
  consume(queue, options, callback) {
    return this.subscribe(queue, options, callback);
  }

  async subscribe(queue, options, callback) {
    // Shutdown is terminal for the process, and both this consumer and the connection hand back the
    // same memoized instance on a repeat require+configure - so a subscribe after it can never
    // start consuming. Rejecting keeps that consistent with `publish()`, which already fails with
    // ConnectionClosedError; resolving `false` here (as this used to) let a service boot
    // "successfully", report healthy, and consume nothing for the rest of its life.
    if (this._stopPromise || this._connection.isClosed) {
      throw new ConnectionClosedError();
    }

    const resolved = this._resolveSubscribeArgs(options, callback);

    const subscription = {
      queue,
      options: resolved.options,
      callback: resolved.callback,
      channel: null,
      consumerTag: null,
      onChannelClose: null,
      cancelled: false,
      inFlightCount: 0, // handlers currently running, not yet acked/rejected.
    };
    this._subscriptions.push(subscription);

    return await this._subscribe(subscription);
  }

  /**
   * Resolves subscribe()'s two call shapes - `(queue, options, callback)` and `(queue, callback)` -
   * and fills in the defaults, including the channel prefetch.
   * @param {object|Function} options
   * @param {Function} callback
   * @private
   * @return {{options: object, callback: Function}}
   */
  _resolveSubscribeArgs(options, callback) {
    const defaults = {
      persistent: true,
      durable: true,
      channel: {
        prefetch: this._configuration.prefetch,
      },
    };

    if (typeof options === 'function') {
      return { options: defaults, callback: options };
    }

    return {
      options: {
        ...defaults,
        ...options,
        channel: {
          ...defaults.channel,
          ...(options.channel || {}),
        },
      },
      callback,
    };
  }

  async _subscribe(subscription) {
    if (!this._isLive(subscription)) {
      return false;
    }

    const { queue } = subscription;

    const channel = await this._initializeChannel(subscription);
    if (!channel || !(await this._assertQueue(channel, subscription))) {
      return await this._retrySubscribe(subscription);
    }

    logger.debug({
      message: `${loggerAlias} init ${queue}`,
      params: { queue },
    });

    if (!this._isLive(subscription)) {
      return false;
    }

    if (!(await this._consumeQueue(channel, subscription))) {
      // No retry from here, unlike the failures above: a refused basic.consume (an exclusive-consumer
      // conflict, ACCESS_REFUSED on the consume itself) is about this consumer rather than the
      // channel, so the caller gets an honest `false` instead of this hammering the broker. If the
      // channel died with it, its own 'close' still drives a resubscribe - behind the backoff now.
      return false;
    }

    // A cancel() that landed *inside* _consumeQueue() might have already been carried out on the broker in a race
    return this._isLive(subscription);
  }

  /**
   * Declare the queue this subscription consumes from.
   *
   * A refusal is not cosmetic: the broker answers a bad declaration (PRECONDITION_FAILED from
   * changed queue arguments, ACCESS_REFUSED) with a channel-level error, which kills the channel -
   * so consuming on it afterwards cannot work either. Reporting the failure is what routes the
   * subscription to `_retrySubscribe()` instead of letting it fall through to a dead
   * `basic.consume` and then report success.
   * @private
   * @return {Promise<boolean>} Whether the queue is declared and the channel still usable.
   */
  async _assertQueue(channel, subscription) {
    const { queue, options } = subscription;
    // consumer gets a suffix if one is set on the configuration, to suffix all queues names
    // ex: service-something with suffix :ci becomes service-suffix:ci etc.
    const suffixedQueue = `${queue}${this._connection.config.consumerSuffix || ''}`;

    try {
      await channel.assertQueue(suffixedQueue, options);
      return true;
    } catch (error) {
      logger.error({
        message: `${loggerAlias} Failed to assert queue ${queue}: ${error.message}`,
        error,
        params: { queue },
      });
      return false;
    }
  }

  /**
   * Wait out the configured backoff, then start the whole subscribe over.
   *
   * Reached when there is no usable channel to consume on at all - none could be opened, or the
   * queue could not be declared as asked, which is a channel-level error and kills the channel with
   * it. Retrying is the only thing that can ever make such a subscription live, so this keeps going
   * for as long as it takes and `subscribe()` stays pending: a service awaiting it does not come up,
   * rather than reporting ready while consuming nothing.
   *
   * This is the only retry driver for a subscription that never reached a consumerTag (see
   * `_initializeChannel`'s close listener), which is what bounds it. Previously only a channel that
   * failed to *open* was delayed here: an `assertQueue` that killed the channel fell through to a
   * dead `basic.consume`, and the channel's own 'close' then resubscribed with no delay at all -
   * a fresh channel per broker round-trip, for as long as the queue stayed undeclarable.
   * @private
   * @return {Promise<boolean>}
   */
  async _retrySubscribe(subscription) {
    await utils.timeoutPromise(this._connection.config.timeout);
    if (!this._isLive(subscription)) {
      return false;
    }
    return await this._subscribe(subscription);
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
        // Only a subscription that got as far as consuming resubscribes from here. Without a
        // consumerTag this close is the *setup* failing - a queue that cannot be declared as asked
        // is answered with a channel-level error, which kills the channel and lands straight back
        // here - and that case belongs to `_retrySubscribe`, which owns the backoff. Letting both
        // drive it would put two retry loops on one subscription, each opening a channel whose
        // death starts another, doubling every cycle. A genuine reconnect has a tag and is
        // unaffected: it still resubscribes immediately.
        if (!subscription.consumerTag) {
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

  /**
   * Register the delivery callback with the broker.
   * @private
   * @return {Promise<boolean>} Whether the broker confirmed the consumer (basic.consume-ok).
   */
  async _consumeQueue(channel, subscription) {
    const { queue } = subscription;

    try {
      const { consumerTag } = await channel.consume(queue, (msg) => this._onDelivery(channel, subscription, msg), {
        noAck: false,
      });
      subscription.consumerTag = consumerTag;

      if (!this._isLive(subscription)) {
        await this._cancelSubscription(subscription);
      }
      return true;
    } catch (error) {
      logger.error({
        message: `${loggerAlias} Failed to start consuming from queue ${queue}: ${error.message}`,
        error,
        params: { queue },
      });
      return false;
    }
  }

  /**
   * amqplib's delivery callback for one subscription: the only place `inFlightCount` moves, so
   * every delivery this consumer accepts is visible to `inFlight()`/`_drain()` for exactly as long
   * as its handler runs.
   * @private
   */
  async _onDelivery(channel, subscription, msg) {
    const { queue } = subscription;

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
      await this._rejectAfterShutdown(channel, subscription, msg);
      return;
    }

    subscription.inFlightCount += 1;
    try {
      await this._processMessage(channel, subscription, msg);
    } finally {
      subscription.inFlightCount -= 1;
      this._removeIfDone(subscription);
    }
  }

  /**
   * Hand a delivery back to the broker untouched. Reached for a message the broker had already
   * buffered to us before cancel-ok landed (prefetch > 1): running the handler would block
   * `_drain()`/`stop()`/`close()` on work that was never going to be allowed to finish here.
   *
   * Emits the same before/after pair as any other delivery, so this does not become a delivery the
   * per-message instrumentation never hears about - during a rolling deploy that is up to
   * `prefetch` messages per consumer, and without the events a caller's received and completed
   * counters silently disagree by exactly that many. `afterProcessMessageEvent` carries
   * `requeued: true` to distinguish it from a message that was actually processed.
   *
   * Both events, not just the after one: instrumentation typically *starts* its span in the before
   * hook and stores it on the message, and the after hook ends whatever it finds there - so an
   * after event on its own does nothing at all, and the requeued delivery stays untraced. The
   * before hook also wraps `action.callback`, which is never invoked here; that is safe as long as
   * the span is ended from the after hook rather than from inside the wrapper, and it matches the
   * shape the hook already documents for a `beforeProcessMessage` that skips processing.
   * `action.content` is absent, since nothing is deserialized on this path.
   *
   * Not counted in `inFlightCount`: the reject is already on the wire before the after hook runs,
   * so the message is safely back with the broker and the drain has nothing left to wait for. A
   * slow hook can be cut off by the connection close that follows.
   * @private
   * @return {Promise<void>}
   */
  async _rejectAfterShutdown(channel, subscription, msg) {
    const { queue, callback } = subscription;

    await this.hooks.trigger(this, ConsumerHooks.beforeProcessMessageEvent, {
      queue,
      action: { message: msg, content: undefined, callback },
    });

    let rejectError;
    try {
      channel.reject(msg, true);
    } catch (error) {
      rejectError = error;
      logger.error({
        message: `${loggerAlias} Failed to reject message received after shutdown on queue ${queue}: ${error.message}`,
        error,
        params: { queue },
      });
    }

    await this.hooks.trigger(this, ConsumerHooks.afterProcessMessageEvent, {
      queue,
      message: msg,
      requeued: true,
      rejectError,
    });
  }

  /**
   * Parse one delivery, run the subscription's callback, reply to it if it was an RPC request, and
   * settle it with the broker - an ack on success, a reject on any failure above.
   * @private
   * @return {Promise<void>}
   */
  async _processMessage(channel, subscription, msg) {
    const { queue, callback } = subscription;
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
      // A parsing error is never requeued - a redelivery of the same bytes fails identically.
      // Anything else follows the configured requeue behavior.
      const shouldRequeue = error instanceof SyntaxError ? false : this._connection.config.requeue;

      await this._rejectMessageAfterProcess(channel, subscription, msg, body, shouldRequeue, error);
      return;
    }

    await this._ackMessageAfterProcess(channel, queue, msg, body);
  }

  /** @private */
  async _ackMessageAfterProcess(channel, queue, msg, parsedBody) {
    let ackError;
    try {
      channel.ack(msg);
    } catch (error) {
      ackError = error;

      logger.error({
        message: `${loggerAlias} Failed to ack message after processing finished on queue ${queue}: ${ackError.message}`,
        error: ackError,
        params: { queue },
      });
    }

    await this.hooks.trigger(this, ConsumerHooks.afterProcessMessageEvent, {
      queue,
      message: msg,
      content: parsedBody,
      ackError,
    });
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
   * Cancels every subscription across every queue. Only ever reached through `stop()`, which has
   * already set `_stopPromise` - so no subscription, existing or created later, resubscribes or
   * retries afterward.
   * @private
   * @return {Promise<void>}
   */
  async _cancelAll() {
    await Promise.all(this._subscriptions.map((sub) => this._cancelSubscription(sub)));
  }

  /** @private */
  async _cancelSubscription(subscription) {
    subscription.cancelled = true;
    if (subscription.onChannelClose) {
      // Guarded because removeListener() rejects an undefined listener - there is none to remove
      // until _initializeChannel has attached one.
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
   * Polling is safe only because this is unreachable except through `stop()`, which cancels first:
   * once cancelled, a delivery the broker had already buffered takes the reject path without ever
   * incrementing, so `inFlight()` is monotonically non-increasing by the time this runs and any
   * observed zero is final. On a live, uncancelled subscription it would exit on the first poll
   * that happened to land between two deliveries - which is why it is private and paired.
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
   *
   * `_stopPromise` is also what `_isLive` reads, so nothing here may consult `_isLive` before the
   * assignment below completes - the steps' own synchronous prefixes run first, as the right-hand
   * side of it.
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
