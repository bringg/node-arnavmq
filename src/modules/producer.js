const pDefer = require('p-defer');
const utils = require('./utils');
const parsers = require('./message-parsers');
const { ProducerHooks } = require('./hooks');
const { logger } = require('./logger');
const { ConnectionClosedError } = require('./connection');

const ERRORS = {
  TIMEOUT: 'Timeout reached',
  REPLY_CONSUMER_RESET: 'RPC reply consumer was reset before the request was published',
};

/**
 * RabbitMQ's Direct Reply-to pseudo-queue. Consuming it (no-ack) on a channel lets requests published on
 * that same channel carry it as `replyTo`; the broker rewrites it to `amq.rabbitmq.reply-to.<suffix>`
 * and routes replies straight back to the channel, with no queue to declare.
 * https://www.rabbitmq.com/docs/direct-reply-to
 */
const DIRECT_REPLY_TO = 'amq.rabbitmq.reply-to';

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
  /**
   * @param {import('./connection').Connection} connection
   */
  constructor(connection) {
    /** @type {import('./connection').Connection} */
    this._connection = connection;
    /** @type {ProducerHooks} */
    this.hooks = new ProducerHooks();

    /**
     * Pending RPC requests by correlation ID, across every target queue: all replies arrive on the
     * one Direct Reply-to consumer, which tells them apart by correlation ID only.
     * @type {Map<string, import('p-defer').DeferredPromise<unknown>>}
     */
    this._rpcRequests = new Map();

    /**
     * The Direct Reply-to consumer on the default channel, set up by the first RPC on that channel.
     * @type {{channel: import('amqplib').Channel, ready: Promise<void>}|null}
     */
    this._replyConsumer = null;

    /**
     * The last channel given a 'close' listener, so a consumer set up again on the same channel
     * (after a broker cancel) doesn't add a second one. A closed channel is never handed out again.
     * @type {import('amqplib').Channel|null}
     */
    this._watchedChannel = null;
  }

  set connection(value) {
    this._connection = value;
  }

  get connection() {
    return this._connection;
  }

  /**
   * The default channel, with the Direct Reply-to consumer on it. The consumer is set up once per
   * channel and shared by concurrent callers; a failed setup is not kept, so the next RPC tries again.
   * @private
   * @return {Promise<import('amqplib').Channel>}
   */
  async _getReplyChannel() {
    const channel = await this._connection.getDefaultChannel();

    let replyConsumer = this._replyConsumer;
    if (replyConsumer?.channel !== channel) {
      replyConsumer = { channel, ready: this._consumeReplies(channel) };
      this._replyConsumer = replyConsumer;
      replyConsumer.ready.catch(() => {
        if (this._replyConsumer === replyConsumer) {
          this._replyConsumer = null;
        }
      });
    }

    await replyConsumer.ready;
    return channel;
  }

  /**
   * Consume Direct Reply-to replies on `channel`, and watch it for close.
   * @private
   * @param {import('amqplib').Channel} channel
   * @return {Promise<void>}
   */
  async _consumeReplies(channel) {
    if (this._watchedChannel !== channel) {
      this._watchedChannel = channel;
      channel.once('close', () => this._resetReplyConsumer(channel, 'on channel close'));
    }
    await channel.consume(DIRECT_REPLY_TO, (msg) => this._onReply(channel, msg), { noAck: true });
  }

  /**
   * The reply consumer on `channel` is gone (the channel closed, or the broker cancelled it). Forget
   * it so the next RPC sets it up again, and reject the pending requests: they were all published on
   * `channel`, so none can get a reply any more.
   * @private
   * @param {import('amqplib').Channel} channel
   * @param {string} why ends the log message
   */
  _resetReplyConsumer(channel, why) {
    if (this._replyConsumer?.channel === channel) {
      this._replyConsumer = null;
    }
    this._discardRequests(why);
  }

  /**
   * Delivery callback of the Direct Reply-to consumer.
   * @private
   * @param {import('amqplib').Channel} channel
   * @param {import('amqplib').Message|null} msg
   */
  _onReply(channel, msg) {
    if (msg === null) {
      // The broker cancelled the consumer. The channel stays open, but no reply can reach it.
      this._resetReplyConsumer(channel, 'after the broker cancelled the reply consumer');
      return;
    }

    const { correlationId } = msg.properties;
    const request = this._rpcRequests.get(correlationId);
    if (request === undefined) {
      logger.warn({
        message: `${loggerAlias} Received an RPC reply with no pending request (timed out, or from a previous session)`,
        params: { correlationId },
      });
      return;
    }

    logger.debug({
      message: `${loggerAlias} < answer`,
      params: { correlationId },
    });

    try {
      request.resolve(parsers.in(msg));
    } catch (e) {
      request.reject(new ProducerError(e));
    }
  }

  /**
   * Reject every pending RPC request with `ConnectionClosedError`, instead of letting them wait out
   * `rpcTimeout` (or forever with `rpcTimeout: 0`). The rejection's `origin` is 'shutdown' after
   * `close()`, 'unexpected' otherwise.
   * @private
   * @param {string} why ends the log message
   */
  _discardRequests(why) {
    const requests = [...this._rpcRequests.values()];
    this._rpcRequests.clear();
    if (requests.length === 0) {
      return;
    }

    const origin = this._connection.isClosed ? 'shutdown' : 'unexpected';
    requests.forEach((request) => request.reject(new ConnectionClosedError(origin)));
    logger.warn({
      message: `${loggerAlias} discarded ${requests.length} pending RPC ${
        requests.length === 1 ? 'request' : 'requests'
      } ${why} (${origin})`,
      params: { discardedCount: requests.length, origin },
    });
  }

  /**
   * `promise`, rejected with the RPC timeout error if `deadline` passes first.
   * @private
   * @param {Promise<T>} promise
   * @param {number|null} deadline epoch ms; null means no limit
   * @return {Promise<T>}
   * @template T
   */
  _beforeDeadline(promise, deadline) {
    if (deadline === null) {
      return promise;
    }
    return utils.withTimeout(
      promise,
      Math.max(deadline - Date.now(), 0),
      'an RPC reply',
      () => new Error(ERRORS.TIMEOUT),
    );
  }

  async publishOrSendToQueue(queue, msg, options) {
    const channel = await this._connection.getDefaultChannel();
    return this._publishOn(channel, queue, msg, options);
  }

  /**
   * Publish `msg` on `channel`, through the default exchange or to `queue` as an exchange with
   * `options.routingKey`.
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
   * Send message with or without rpc protocol
   * @param  {string} queue   the queue to send `msg` on
   * @param  {any} msg     string, object, number.. anything bufferable/serializable
   * @param  {object} options contain rpc property (if true, enable rpc for this message)
   * @return {Promise}         Resolves when message is correctly sent, or when response is received when rpc is enabled
   */
  async checkRpc(queue, msg, options) {
    // messages are persistent
    options.persistent = true;

    if (!options.rpc) {
      return await this.publishOrSendToQueue(queue, msg, options);
    }

    // Given timeout or the default one, covering the reply consumer setup too. `Number()`, since
    // callers also pass it as a string.
    const timeout = Number(options.timeout || this._connection.config.rpcTimeout || 0);
    const deadline = timeout > 0 ? Date.now() + timeout : null;
    // generates a correlationId (random uuid) so we know which callback to execute on received response
    options.correlationId = utils.getCorrelationId(options);
    // reply to us if you receive this message!
    options.replyTo = DIRECT_REPLY_TO;
    const { correlationId } = options;

    const channel = await this._beforeDeadline(this._getReplyChannel(), deadline);

    if (this._replyConsumer?.channel !== channel) {
      // The consumer went away while we waited (broker cancel, channel closed). A request with the
      // Direct Reply-to replyTo on a channel without the consumer is a channel error, which would
      // close the default channel for every subscription on it. Retryable: the next attempt sets it up.
      throw new Error(ERRORS.REPLY_CONSUMER_RESET);
    }

    // All replies share one consumer, so a correlation ID already pending would be answered with
    // the other request's reply.
    if (this._rpcRequests.has(correlationId)) {
      throw new ProducerError({
        name: 'Error',
        message: `An RPC request with correlationId ${correlationId} is already pending`,
      });
    }

    // Nothing is awaited between registering the request and awaiting its reply, so nothing can
    // reject it unobserved. A channel that closed meanwhile makes the publish throw, which is retryable.
    const request = pDefer();
    this._rpcRequests.set(correlationId, request);
    try {
      this._publishOn(channel, queue, msg, options);
      return await this._beforeDeadline(request.promise, deadline);
    } finally {
      if (this._rpcRequests.get(correlationId) === request) {
        this._rpcRequests.delete(correlationId);
      }
    }
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
      // Set correlation id and replyTo before the trigger, so we have them on the payload going for it.
      settings.correlationId = utils.getCorrelationId(settings);
      settings.replyTo = DIRECT_REPLY_TO;
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
