const utils = require('./utils');
const uuid = require('node-uuid');
const parsers = require('./message-parsers');
const Deferred = require('../classes/deferred');
const assert = require('assert');

const ERRORS = {
  TIMEOUT: 'Timeout reached',
  BUFFER_FULL: 'Buffer is full'
};

class Producer {
  constructor(connection) {
    this.amqpRPCQueues = {};
    this._conn = connection;
    this.channel = null;
  }

  get conn() {
    return this._conn;
  }

  set conn(value) {
    this._conn = value;
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
      const corrId = msg.properties.correlationId;

      try {
        // if we found one, we execute the callback and delete it because it will never be received again anyway
        rpcQueue[corrId].resolve(parsers.in(msg));
        this._conn.config.transport.info('bmq:producer', `[${queue}] < answer`);
        delete rpcQueue[corrId];
      } catch (e) {
        this._conn.config.transport.error(new Error(
          `Receiving RPC message from previous session: callback no more in memory. ${queue}`
        ));
      }
    };
  }

  /**
   * Create a RPC-ready queue
   * @param  {string} queue the queue name in which we send a RPC request
   * @return {Promise}       Resolves when answer response queue is ready to receive messages
   */
  createRpcQueue(queue) {
    if (!this.amqpRPCQueues[queue]) {
      this.amqpRPCQueues[queue] = {};
    }

    const rpcQueue = this.amqpRPCQueues[queue];
    if (rpcQueue.queue) return Promise.resolve(rpcQueue.queue);

    // we create the callback queue using base queue name + appending config hostname and :res for clarity
    // ie. if hostname is gateway-http and queue is service-oauth, response queue will be service-oauth:gateway-http:res
    // it is important to have different hostname or no hostname on each module sending message or there will be conflicts
    const resQueue = `${queue}:${this._conn.config.hostname}:res`;
    rpcQueue.queue = this._conn.get().then(channel =>
      channel.assertQueue(resQueue, { durable: true, exclusive: true })
        .then((q) => {
          rpcQueue.queue = q.queue;

          // if channel is closed, we want to make sure we cleanup the queue so future calls will recreate it
          this._conn.addListener('close', () => { delete rpcQueue.queue; this.createRpcQueue(queue); });

          return channel.consume(q.queue, this.maybeAnswer(queue), { noAck: true });
        })
        .then(() => rpcQueue.queue)
      )
      .catch(() => {
        delete rpcQueue.queue;
        return utils.timeoutPromise(this._conn.config.timeout).then(() =>
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
    const self = this;
    setTimeout(() => {
      const rpcCallback = self.amqpRPCQueues[queue][corrId];
      if (rpcCallback) {
        rpcCallback.reject(new Error(ERRORS.TIMEOUT));
        delete self.amqpRPCQueues[queue][corrId];
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

          if (this.publishOrSendToQueue(queue, msg, options)) {
            // defered promise that will resolve when response is received
            const responsePromise = new Deferred();
            this.amqpRPCQueues[queue][corrId] = responsePromise;
            if (options.timeout) {
              this.prepareTimeoutRpc(queue, corrId, options.timeout);
            }
            return responsePromise.promise;
          }
          return Promise.reject(ERRORS.BUFFER_FULL);
        });
    }

    return this.publishOrSendToQueue(queue, msg, options);
  }

  /**
   * Ensure channel exists and send message using `checkRpc`
   * @param  {string} queue   The destination queue on which we want to send a message
   * @param  {any} msg     Anything serializable/bufferable
   * @param  {object} options message options (persistent, durable, rpc, etc.)
   * @return {Promise}         checkRpc response
   */
  /* eslint no-param-reassign: "off" */
  produce(queue, msg, options) {
    // default options are persistent and durable because we do not want to miss any outgoing message
    // unless user specify it
    options = Object.assign({ persistent: true, durable: true }, options);
    return this._conn.get()
    .then((channel) => {
      this.channel = channel;

      // undefined can't be serialized/buffered :p
      if (!msg) msg = null;

      this._conn.config.transport.info('bmq:producer', `[${queue}] > `, msg);

      return this.checkRpc(queue, parsers.out(msg, options), options);
    })
    .catch((err) => {
      if ([ERRORS.TIMEOUT, ERRORS.BUFFER_FULL].indexOf(err.message) !== -1) {
        throw err;
      }
      // add timeout between retries because we don't want to overflow the CPU
      this._conn.config.transport.error('bmq:producer', err);
      return utils.timeoutPromise(this._conn.config.timeout)
      .then(() => this.produce(queue, msg, options));
    });
  }
}

let instance;
/* eslint no-unused-expressions: "off" */
/* eslint no-sequences: "off" */
/* eslint arrow-body-style: "off" */
module.exports = (conn) => {
  assert(instance || conn, 'Producer can not be created because connection does not exist');

  if (!instance) {
    instance = new Producer(conn);
  } else {
    instance.conn = conn;
  }
  return instance;
};
