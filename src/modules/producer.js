const pDefer = require('p-defer');
const utils = require('./utils');
const parsers = require('./message-parsers');
const { ProducerHooks } = require('./hooks');
const { logger } = require('./logger');
const { ConnectionClosedError } = require('./connection');

const ERRORS = {
  TIMEOUT: 'Timeout reached',
};

const loggerAlias = 'arnav_mq:producer';

class ProducerError extends Error {
  constructor({ name, message }) {
    super(message);

    this.name = name;
    this.message = message;

    Error.captureStackTrace(this, this.constructor);
  }
}

class Producer {
  constructor(connection) {
    this._connection = connection;
    this.hooks = new ProducerHooks();

    /**
     * Map of rpc queues
     *
     * [queue: string] -> [correlationId: string] -> {responsePromise, timeoutId}
     */
    this.amqpRPCQueues = {};

    // Bound once so `_initializeRpcQueue` can remove-then-add it and stay at one listener.
    this._onChannelClose = this._onChannelClose.bind(this);
  }

  /**
   * Every pending RPC request has become unanswerable: the reply queue was exclusive to the
   * connection that just went away, and each request was published carrying that queue's name as
   * its replyTo, so no answer can ever arrive - not on a reconnect either. Reject the waiters now
   * so callers fail fast instead of hanging out `rpcTimeout` for an answer that is not coming (and
   * forever with `rpcTimeout: 0`, which arms no timer at all), and clear their timers so none keeps
   * the process alive past shutdown. Dropping the whole registry also discards the dead reply-queue
   * bookkeeping, so the next RPC publish rebuilds it.
   *
   * Fires on every teardown path: `Channels.closeAll()` during a graceful `close()`, and amqplib's
   * `Connection.toClosed()` -> `_closeChannels()` for a channel wedged past closeAll's cap or a
   * socket that died on its own.
   * @private
   */
  _onChannelClose() {
    const queues = this.amqpRPCQueues;
    this.amqpRPCQueues = {};

    Object.values(queues).forEach((rpcQueue) => {
      Object.entries(rpcQueue).forEach(([key, waiter]) => {
        // `resQueuePromise` is bookkeeping for the queue itself, not a correlationId waiter.
        if (key === 'resQueuePromise') {
          return;
        }

        clearTimeout(waiter.timeoutId);
        waiter.responsePromise.reject(new ConnectionClosedError());
      });
    });
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
   * Create a RPC-ready queue
   * @param  {string} queue the queue name in which we send a RPC request
   * @return {Promise}       Resolves with the the response queue name when the answer response queue is ready to receive messages
   */
  async createRpcQueue(queue) {
    this.amqpRPCQueues[queue] = this.amqpRPCQueues[queue] || {};

    const rpcData = this.amqpRPCQueues[queue];
    if (rpcData.resQueuePromise) {
      return await rpcData.resQueuePromise;
    }

    rpcData.resQueuePromise = this._initializeRpcQueue(queue);
    return await rpcData.resQueuePromise;
  }

  async _initializeRpcQueue(sourceQueue) {
    const rpcQueue = this.amqpRPCQueues[sourceQueue];

    // we create the callback queue using base queue name + appending config hostname and :res for clarity
    // ie. if hostname is gateway-http and queue is service-oauth, response queue will be service-oauth:gateway-http:res
    // it is important to have different hostname or no hostname on each module sending message or there will be conflicts
    const resQueue = `${sourceQueue}:${this._connection.config.hostname}:${process.pid}:res`;
    try {
      const channel = await this._connection.getDefaultChannel();
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
      delete rpcQueue.resQueuePromise;

      if (error instanceof ConnectionClosedError) {
        logger.warn({
          message: `${loggerAlias} not reinitializing RPC queue for ${sourceQueue}: connection is closed`,
        });
        return undefined;
      }

      await utils.timeoutPromise(this._connection.config.timeout);
      return await this.createRpcQueue(sourceQueue);
    }
  }

  async publishOrSendToQueue(queue, msg, options) {
    const channel = await this._connection.getDefaultChannel();

    if (!options.routingKey) {
      return await channel.sendToQueue(queue, msg, options);
    }
    return await channel.publish(queue, options.routingKey, msg, options);
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
    // `?.` because the channel-close sweep drops the whole per-queue entry: a close landing while
    // the request was still being published leaves nothing here, and the waiter it would have timed
    // out has already been rejected with ConnectionClosedError.
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
      // generates a correlationId (random uuid) so we know which callback to execute on received response
      options.correlationId = utils.getCorrelationId(options);
      // reply to us if you receive this message! Taken from the return value rather than read back
      // out of `amqpRPCQueues`, which a channel close landing in this very window would have swept.
      options.replyTo = await this.createRpcQueue(queue);

      // deferred promise that will resolve when response is received
      const responsePromise = pDefer();
      // A channel close can reject this deferred while the publish below is still a round-trip in
      // flight - i.e. before the `await responsePromise.promise` at the end of this function has
      // attached a handler. A rejection left unhandled across a full turn of the loop trips Node's
      // unhandled-rejection detection, and under the default `--unhandled-rejections=throw` that
      // kills the process. This no-op catch attaches to a derived promise, so the rejection still
      // reaches the caller below unchanged.
      responsePromise.promise.catch(() => {});
      // `??=` for the same reason: the sweep drops the whole per-queue entry, so a close landing
      // between the two awaits above leaves nothing to index. Registering the waiter into a fresh
      // entry keeps the publish below on its normal path - it fails against the dead channel with a
      // retryable error, so `_sendToQueue` reconnects and republishes rather than losing the request.
      this.amqpRPCQueues[queue] ??= {};
      this.amqpRPCQueues[queue][options.correlationId] = { responsePromise, timeoutId: null };

      try {
        await this.publishOrSendToQueue(queue, msg, options);
      } catch (error) {
        // The request never made it out, so no response can ever arrive to settle this waiter, and
        // prepareTimeoutRpc() below was never reached - nothing else will ever clear it. Left in
        // the registry it leaks until the channel closes.
        delete this.amqpRPCQueues[queue]?.[options.correlationId];
        throw error;
      }

      // Using given timeout or default one
      const timeout = options.timeout || this._connection.config.rpcTimeout || 0;
      if (timeout > 0) {
        this.prepareTimeoutRpc(queue, options.correlationId, timeout);
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
