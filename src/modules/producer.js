const utils = require('./utils');
const uuid = require('uuid');
const parsers = require('./message-parsers');
const Deferred = require('../classes/deferred');

const ERRORS = {
  TIMEOUT: 'Timeout reached',
  BUFFER_FULL: 'Buffer is full'
};

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
    this.amqpRPCQueues = {};
    this._connection = connection;
    this.channel = null;
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
      const responsePromise = rpcQueue[correlationId];

      if (responsePromise === undefined) {
        this._connection.config.transport.error(new Error(
          `Receiving RPC message from previous session: callback no more in memory. ${queue}`
        ));

        return;
      }

      // if we found one, we execute the callback and delete it because it will never be received again anyway
      this._connection.config.transport.info('bmq:producer', `[${queue}] < answer`);

      try {
        responsePromise.resolve(parsers.in(msg));
      } catch (e) {
        responsePromise.reject(new ProducerError(e));
      } finally {
        delete rpcQueue[correlationId];
      }
    };
  }

  /**
   * Create a RPC-ready queue
   * @param  {string} queue the queue name in which we send a RPC request
   * @return {Promise}       Resolves when answer response queue is ready to receive messages
   */
  createRpcQueue(queue) {
    this.amqpRPCQueues[queue] = this.amqpRPCQueues[queue] || {};

    const rpcQueue = this.amqpRPCQueues[queue];
    if (rpcQueue.queue) return Promise.resolve(rpcQueue.queue);

    // we create the callback queue using base queue name + appending config hostname and :res for clarity
    // ie. if hostname is gateway-http and queue is service-oauth, response queue will be service-oauth:gateway-http:res
    // it is important to have different hostname or no hostname on each module sending message or there will be conflicts
    const resQueue = `${queue}:${this._connection.config.hostname}:${process.pid}:res`;
    rpcQueue.queue = this._connection.get().then(channel =>
      channel.assertQueue(resQueue, { durable: true, exclusive: true })
        .then((q) => {
          rpcQueue.queue = q.queue;

          // if channel is closed, we want to make sure we cleanup the queue so future calls will recreate it
          this._connection.addListener('close', () => {
            delete rpcQueue.queue;
            this.createRpcQueue(queue);
          });

          return channel.consume(q.queue, this.maybeAnswer(queue), { noAck: true });
        })
        .then(() => rpcQueue.queue)
      )
      .catch(() => {
        delete rpcQueue.queue;
        return utils.timeoutPromise(this._connection.config.timeout).then(() =>
          this.createRpcQueue(queue)
        );
      });

    return rpcQueue.queue;
  }

  publishOrSendToQueue(queue, msg, options) {
    if (!options.routingKey) {
      return this.channel.sendToQueue(queue, msg, options);
    }
    return this.channel.publish(queue, options.routingKey, msg, options);
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
    setTimeout(() => {
      const rpcCallback = producer.amqpRPCQueues[queue][corrId];
      if (rpcCallback) {
        rpcCallback.reject(new Error(ERRORS.TIMEOUT));
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
  checkRpc(queue, msg, options) {
    // messages are persistent
    options.persistent = true;

    if (options.rpc) {
      return this.createRpcQueue(queue)
      .then(() => {
        // generates a correlationId (random uuid) so we know which callback to execute on received response
        const corrId = uuid.v4();
        options.correlationId = corrId;
        // reply to us if you receive this message!
        options.replyTo = this.amqpRPCQueues[queue].queue;

        this.publishOrSendToQueue(queue, msg, options);
        // defered promise that will resolve when response is received
        const responsePromise = new Deferred();
        this.amqpRPCQueues[queue][corrId] = responsePromise;

        //  Using given timeout or default one
        const timeout = options.timeout || this._connection.config.rpcTimeout || 0;
        if (timeout > 0) {
          this.prepareTimeoutRpc(queue, corrId, timeout);
        }

        return responsePromise.promise;
      });
    }

    return this.publishOrSendToQueue(queue, msg, options);
  }

  /**
   * @deprecated Use publish instead
   * Ensure channel exists and send message using `checkRpc`
   * @param  {string} queue   The destination queue on which we want to send a message
   * @param  {any} msg     Anything serializable/bufferable
   * @param  {object} options message options (persistent, durable, rpc, etc.)
   * @return {Promise}         checkRpc response
   */
   /* eslint prefer-rest-params: off */
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
  /* eslint no-param-reassign: "off" */
  publish(queue, msg, options) {
    // default options are persistent and durable because we do not want to miss any outgoing message
    // unless user specify it
    const settings = Object.assign({ persistent: true, durable: true }, options);

    let message = msg;
    if (Array.isArray(msg)) {
      message = Object.assign([], msg);
    } else if (typeof(msg) !== 'string') {
      message = Object.assign({}, msg);
    }

    return this._connection.get()
    .then((channel) => {
      this.channel = channel;

      // undefined can't be serialized/buffered :p
      if (!message) message = null;

      this._connection.config.transport.info('bmq:producer', `[${queue}] > `, msg);

      return this.checkRpc(queue, parsers.out(message, settings), settings);
    })
    .catch((err) => {
      if (err instanceof ProducerError || [ERRORS.TIMEOUT, ERRORS.BUFFER_FULL].includes(err.message)) {
        throw err;
      }

      // add timeout between retries because we don't want to overflow the CPU
      this._connection.config.transport.error('bmq:producer', err);
      return utils.timeoutPromise(this._connection.config.timeout)
      .then(() => this.publish(queue, message, settings));
    });
  }
}

/* eslint no-unused-expressions: "off" */
/* eslint no-sequences: "off" */
/* eslint arrow-body-style: "off" */
module.exports = Producer;
