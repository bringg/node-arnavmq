const pDefer = require('p-defer');
const utils = require('./utils');
const parsers = require('./message-parsers');
const { ProducerHooks } = require('./hooks');
const { logger } = require('./logger');
const { ConnectionClosedError } = require('./connection');

const ERRORS = {
  TIMEOUT: 'Timeout reached',
  REPLY_CONSUMER_CANCELLED: 'RPC reply consumer was cancelled by the broker',
};

const loggerAlias = 'arnav_mq:producer';

/**
 * @typedef {Object} RpcWaiter
 * @property {import('p-defer').DeferredPromise} responsePromise
 * @property {NodeJS.Timeout|null} timeoutId
 */

/**
 * @typedef {Object} ReplyQueueSetup
 * @property {string} [name] the reply queue name, once it is declared and consumed
 * @property {Set<import('p-defer').DeferredPromise<string>>} waiters RPCs waiting for it
 */

/**
 * @typedef {Object.<string, RpcWaiter>} RpcQueue Correlation ID -> waiter, plus a
 *   `replyQueue` bookkeeping key for the reply queue's setup (not a waiter).
 * @property {ReplyQueueSetup} [replyQueue]
 */

class ProducerError extends Error {
  constructor({ name, message }) {
    super(message);

    this.name = name;
    this.message = message;

    Error.captureStackTrace(this, this.constructor);
  }
}

class Producer {
  /**
   * @param {import('./connection').Connection} connection
   */
  constructor(connection) {
    /** @type {import('./connection').Connection} */
    this._connection = connection;
    /** @type {ProducerHooks} */
    this.hooks = new ProducerHooks();

    /**
     * Map of rpc queues
     *
     * [queue: string] -> [correlationId: string] -> {responsePromise, timeoutId}, plus the
     * `replyQueue` setup - see `RpcQueue`
     * @type {Object.<string, RpcQueue>}
     */
    this.amqpRPCQueues = {};

    // Bound once so `_initializeRpcQueue` can remove-then-add it and stay at one listener.
    /** @type {() => void} */
    this._onChannelClose = this._onChannelClose.bind(this);
  }

  /**
   * Default channel 'close' listener. The reply queues were consumed on that channel, so pending
   * RPC requests may never get an answer: reject them now instead of letting them wait out
   * `rpcTimeout` (or forever with `rpcTimeout: 0`). Dropping the registry makes the next RPC set the
   * reply queue up again.
   *
   * Fires on `close()`, on a connection lost on its own, and on the broker closing the channel. The
   * rejection's `origin` is 'shutdown' after `close()`, 'unexpected' otherwise.
   * @private
   */
  _onChannelClose() {
    const queues = this.amqpRPCQueues;
    this.amqpRPCQueues = {};

    this._discardWaiters(Object.values(queues), 'on channel close');
  }

  /**
   * Reject every waiter in `rpcQueues` with `ConnectionClosedError`, clear their timers, and
   * warn-log how many were discarded.
   * @private
   * @param {RpcQueue[]} rpcQueues
   * @param {string} why ends the log message
   * @param {string} [message] the rejection's message; 'Connection is closed' by default
   */
  _discardWaiters(rpcQueues, why, message = undefined) {
    const origin = this._connection.isClosed ? 'shutdown' : 'unexpected';
    let discardedCount = 0;

    rpcQueues.forEach((rpcQueue) => {
      Object.entries(rpcQueue).forEach(([key, waiter]) => {
        // `replyQueue` is bookkeeping for the reply queue itself, not a correlationId waiter.
        if (key === 'replyQueue') {
          return;
        }

        discardedCount += 1;
        clearTimeout(waiter.timeoutId);
        waiter.responsePromise.reject(new ConnectionClosedError(origin, message));
      });
    });

    if (discardedCount > 0) {
      logger.warn({
        message: `${loggerAlias} discarded ${discardedCount} pending RPC ${
          discardedCount === 1 ? 'request' : 'requests'
        } ${why} (${origin})`,
        params: { discardedCount, origin },
      });
    }
  }

  set connection(value) {
    this._connection = value;
  }

  get connection() {
    return this._connection;
  }

  /**
   * Get a function to execute on channel consumer incoming message is received
   * @param  {string} queue name of the queue where messages are SENT
   * @return {function}       function executed by an amqp.node channel consume callback method
   */
  maybeAnswer(queue) {
    const rpcQueue = this.amqpRPCQueues[queue];

    return (msg) => {
      // null: the broker cancelled the consumer, for instance because the queue was deleted. Reject
      // the pending requests and drop the entry, so the next RPC sets the reply queue up again.
      // Skipped if a channel close already swept the entry.
      if (msg === null) {
        if (this.amqpRPCQueues[queue] === rpcQueue) {
          delete this.amqpRPCQueues[queue];
          this._discardWaiters(
            [rpcQueue],
            `after the broker cancelled the reply consumer for ${queue}`,
            ERRORS.REPLY_CONSUMER_CANCELLED,
          );
        }
        return;
      }

      // check the correlation ID sent by the initial message using RPC
      const { correlationId } = msg.properties;
      const waiter = rpcQueue[correlationId];

      // On timeout the waiter is deleted, so we need to handle the race when the response arrives too late.
      if (waiter === undefined) {
        const error = new Error(`Receiving RPC message from previous session: callback no more in memory. ${queue}`);
        logger.warn({
          message: `${loggerAlias} ${error.message}`,
          error,
          params: { queue, correlationId },
        });

        return;
      }

      // if we found one, we execute the callback and delete it because it will never be received again anyway
      logger.debug({
        message: `${loggerAlias} [${queue}] < answer`,
        params: { queue },
      });

      try {
        waiter.responsePromise.resolve(parsers.in(msg));
      } catch (e) {
        waiter.responsePromise.reject(new ProducerError(e));
      } finally {
        clearTimeout(waiter.timeoutId);
        delete rpcQueue[correlationId];
      }
    };
  }

  /**
   * Create a RPC-ready queue. All RPCs to `queue` share one setup. A caller that times out is
   * removed from its `waiters`, so nothing of it stays attached to a setup that keeps failing.
   * @param  {string} queue the queue name in which we send a RPC request
   * @param  {number} [timeout] ms to wait; 0 (the default) means no limit
   * @return {Promise<string>} Resolves with the reply queue name once it is ready to receive
   *   messages. Rejects with `ConnectionClosedError` once the connection is closed, or with the RPC
   *   timeout error when `timeout` elapses first.
   */
  async createRpcQueue(queue, timeout = 0) {
    this.amqpRPCQueues[queue] ??= {};
    this.amqpRPCQueues[queue].replyQueue ??= this._startReplyQueueSetup(queue);
    const setup = this.amqpRPCQueues[queue].replyQueue;
    if (setup.name) {
      return setup.name;
    }

    const waiter = pDefer();
    setup.waiters.add(waiter);
    let timeoutId;
    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        setup.waiters.delete(waiter);
        waiter.reject(new Error(ERRORS.TIMEOUT));
      }, timeout);
    }
    try {
      return await waiter.promise;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Start setting up the reply queue for `queue`. Its waiters are settled when the setup finishes.
   * @private
   * @param {string} queue the queue name in which we send a RPC request
   * @return {ReplyQueueSetup}
   */
  _startReplyQueueSetup(queue) {
    /** @type {ReplyQueueSetup} */
    const setup = { name: undefined, waiters: new Set() };
    const settleWaiters = (settle) => {
      setup.waiters.forEach(settle);
      setup.waiters.clear();
    };

    this._initializeRpcQueue(queue).then(
      (name) => {
        setup.name = name;
        settleWaiters((waiter) => waiter.resolve(name));
      },
      (error) => settleWaiters((waiter) => waiter.reject(error)),
    );
    return setup;
  }

  /**
   * The reply-queue name for `sourceQueue`: `<sourceQueue>:<hostname>:<pid>:<connection id>:res`.
   * The connection id changes on reconnect, and the name with it. This avoids RESOURCE_LOCKED when
   * the broker still considers the old connection's queue to exist.
   * @private
   * @param {string} sourceQueue the queue in which we send RPC requests
   * @return {string}
   */
  _replyQueueName(sourceQueue) {
    return `${sourceQueue}:${this._connection.config.hostname}:${process.pid}:${this._connection.connectionId}:res`;
  }

  /**
   * Declare and consume the reply queue for `sourceQueue`, retrying every `config.timeout` ms until
   * it works or the connection is closed.
   * @private
   * @param {string} sourceQueue the queue in which we send RPC requests
   * @return {Promise<string>} the reply queue name. Rejects with `ConnectionClosedError` once the
   *   connection is closed.
   */
  async _initializeRpcQueue(sourceQueue) {
    const rpcQueue = this.amqpRPCQueues[sourceQueue];

    while (this.amqpRPCQueues[sourceQueue] === rpcQueue) {
      try {
        const channel = await this._connection.getDefaultChannel();
        // Named after the channel is open, so the name is for the connection the channel is on.
        const resQueue = this._replyQueueName(sourceQueue);
        await channel.assertQueue(resQueue, { durable: true, exclusive: true });

        // Remove-then-add holds this at exactly one listener on the channel no matter how many RPC
        // queues get initialized on it, and re-arms it on the fresh channel after a reconnect.
        channel.removeListener('close', this._onChannelClose);
        channel.addListener('close', this._onChannelClose);

        await channel.consume(resQueue, this.maybeAnswer(sourceQueue), {
          noAck: true,
        });
        return resQueue;
      } catch (error) {
        if (error instanceof ConnectionClosedError || this._connection.isClosed) {
          delete rpcQueue.replyQueue;
          throw new ConnectionClosedError();
        }

        logger.warn({
          message: `${loggerAlias} failed to set up RPC reply queue for ${sourceQueue}, retrying in ${this._connection.config.timeout}ms: ${error.message}`,
          error,
          params: { queue: sourceQueue },
        });
        await utils.timeoutPromise(this._connection.config.timeout);
      }
    }

    // A channel close swept the registry meanwhile: join the current setup rather than run a second one.
    return await this.createRpcQueue(sourceQueue);
  }

  async publishOrSendToQueue(queue, msg, options) {
    const channel = await this._connection.getDefaultChannel();
    return this._publishOn(channel, queue, msg, options);
  }

  /**
   * Publish `msg` on `channel`, through the default exchange or to `queue` as an exchange with
   * `options.routingKey`. Synchronous, so `checkRpc` can check the reply queue and publish with
   * nothing in between.
   * @private
   * @param {import('amqplib').Channel} channel
   * @param {string} queue
   * @param {Buffer} msg
   * @param {object} options
   * @return {boolean}
   */
  _publishOn(channel, queue, msg, options) {
    if (!options.routingKey) {
      return channel.sendToQueue(queue, msg, options);
    }
    return channel.publish(queue, options.routingKey, msg, options);
  }

  /**
   * Start a timer to reject the pending RPC call if no answer is received within the given timeout
   * @param  {string} queue  The queue where the RPC request was sent
   * @param  {string} corrId The RPC correlation ID
   * @param  {number} time    The timeout in ms to wait for an answer before triggering the rejection
   * @return {void}         Nothing
   */
  prepareTimeoutRpc(queue, corrId, time) {
    const producer = this;
    // `?.` because a channel close or a cancelled reply consumer drops the whole per-queue entry,
    // and the waiter in it has then already been rejected with ConnectionClosedError.
    let waiter = producer.amqpRPCQueues[queue]?.[corrId];
    if (!waiter) {
      return;
    }

    waiter.timeoutId = setTimeout(() => {
      waiter = producer.amqpRPCQueues[queue]?.[corrId];
      if (waiter) {
        waiter.responsePromise.reject(new Error(ERRORS.TIMEOUT));
        delete producer.amqpRPCQueues[queue][corrId];
      }
    }, time);
  }

  /**
   * Send message with or without rpc protocol, and check if RPC queues are created
   * @param  {string} queue   the queue to send `msg` on
   * @param  {any} msg     string, object, number.. anything bufferable/serializable
   * @param  {object} options contain rpc property (if true, enable rpc for this message)
   * @return {Promise}         Resolves when message is correctly sent, or when response is received when rpc is enabled
   */
  async checkRpc(queue, msg, options) {
    // messages are persistent
    options.persistent = true;

    if (options.rpc) {
      // Given timeout or the default one. It covers the reply-queue setup too. `Number()`, since
      // callers also pass it as a string.
      const timeout = Number(options.timeout || this._connection.config.rpcTimeout || 0);
      const deadline = Date.now() + timeout;
      // generates a correlationId (random uuid) so we know which callback to execute on received response
      options.correlationId = utils.getCorrelationId(options);

      // A channel close during the awaits below may reset the reply queue: set it up again, within
      // the same deadline, so the request never names a reply queue nothing consumes. Nothing awaits
      // between the check and the publish.
      let channel;
      let rpcQueue;
      do {
        // At least 1 ms, since createRpcQueue waits as long as it takes on 0.
        const setupTimeout = timeout > 0 ? Math.max(deadline - Date.now(), 1) : 0;
        // reply to us if you receive this message!
        options.replyTo = await this.createRpcQueue(queue, setupTimeout);
        channel = await this._connection.getDefaultChannel();
        rpcQueue = this.amqpRPCQueues[queue];
      } while (rpcQueue?.replyQueue?.name !== options.replyTo);

      // deferred promise that will resolve when response is received
      const responsePromise = pDefer();
      rpcQueue[options.correlationId] = { responsePromise, timeoutId: null };

      try {
        this._publishOn(channel, queue, msg, options);
      } catch (error) {
        // The request never made it out, so no response can ever arrive to settle this waiter, and
        // prepareTimeoutRpc() below was never reached - nothing else will ever clear it. Left in
        // the registry it leaks until the channel closes.
        delete rpcQueue[options.correlationId];
        throw error;
      }

      // Whatever is left of the timeout after the setup and the publish above.
      if (timeout > 0) {
        this.prepareTimeoutRpc(queue, options.correlationId, Math.max(deadline - Date.now(), 0));
      }

      return await responsePromise.promise;
    }

    return await this.publishOrSendToQueue(queue, msg, options);
  }

  /**
   * @deprecated Use publish instead
   * Ensure channel exists and send message using `checkRpc`
   * @param  {string} queue   The destination queue on which we want to send a message
   * @param  {any} msg     Anything serializable/bufferable
   * @param  {object} options message options (persistent, durable, rpc, etc.)
   * @return {Promise}         checkRpc response
   */
  produce(queue, msg, options) {
    return this.publish(queue, msg, options);
  }

  /**
   * Ensure channel exists and send message using `checkRpc`
   * @param  {string} queue   The destination queue on which we want to send a message
   * @param  {string|object} msg     Anything serializable/bufferable
   * @param  {object} options message options (persistent, durable, rpc, etc.)
   * @return {Promise}         checkRpc response
   */
  async publish(queue, msg, options) {
    // default options are persistent and durable because we do not want to miss any outgoing message
    // unless user specify it
    const settings = { persistent: true, durable: true, ...options };

    let message = msg;
    if (Array.isArray(msg)) {
      message = Object.assign([], msg);
    } else if (typeof msg !== 'string') {
      message = { ...msg };
    }

    return await this._sendToQueue(queue, message, settings, 0);
  }

  async _sendToQueue(queue, message, settings, currentRetryNumber) {
    // undefined can't be serialized/buffered :p
    if (!message) {
      // eslint-disable-next-line no-param-reassign
      message = null;
    }

    logger.debug({
      message: `${loggerAlias} [${queue}] > ${message}`,
      params: { queue, message },
    });
    const parsedMessage = parsers.out(message, settings);
    if (settings.rpc) {
      // Set correlation id before the trigger, so we have it on the payload going for it.
      settings.correlationId = utils.getCorrelationId(settings);
    }
    try {
      // Make sure we have an initialized connection before triggering the hook.
      await this._connection.getConnection();
      await this.hooks.trigger(this, ProducerHooks.beforeProduce, {
        queue,
        message,
        parsedMessage,
        properties: settings,
        currentRetry: currentRetryNumber,
      });

      const result = await this.checkRpc(queue, parsedMessage, settings);

      await this.hooks.trigger(this, ProducerHooks.afterProduce, {
        queue,
        message,
        parsedMessage,
        properties: settings,
        currentRetry: currentRetryNumber,
        result,
        error: result && result.error ? result.error : undefined,
      });
      return result;
    } catch (error) {
      const shouldRetry = this._shouldRetry(error, currentRetryNumber);
      await this.hooks.trigger(this, ProducerHooks.afterProduce, {
        queue,
        message,
        parsedMessage,
        properties: settings,
        currentRetry: currentRetryNumber,
        shouldRetry,
        error,
      });
      if (!shouldRetry) {
        throw error;
      }

      // add timeout between retries because we don't want to overflow the CPU
      logger.error({
        message: `${loggerAlias} Failed sending message to queue ${queue}: ${error.message}`,
        error,
        params: { queue, message },
      });
      await utils.timeoutPromise(this._connection.config.timeout);
      return await this._sendToQueue(queue, message, settings, currentRetryNumber + 1);
    }
  }

  _shouldRetry(error, currentRetryNumber) {
    if (error instanceof ProducerError || error instanceof ConnectionClosedError || error.message === ERRORS.TIMEOUT) {
      return false;
    }
    const maxRetries = this._connection.config.producerMaxRetries;
    if (maxRetries < 0) {
      // Retry indefinitely...
      return true;
    }

    return currentRetryNumber < maxRetries;
  }
}

module.exports = Producer;
