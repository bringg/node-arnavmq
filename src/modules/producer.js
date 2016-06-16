var utils = require('./utils'),
  uuid = require('node-uuid'),
  parsers = require('./message-parsers');

var amqpRPCQueues = {};

/**
 * Create a RPC-ready queue
 * @param  {string} queue the queue name in which we send a RPC request
 * @return {Promise}       Resolves when answer response queue is ready to receive messages
 */
function createRpcQueue(queue) {
  if (!amqpRPCQueues[queue]) {
    amqpRPCQueues[queue] = {};
  }

  let rpcQueue = amqpRPCQueues[queue];
  if (rpcQueue.queue) return Promise.resolve(rpcQueue.queue);

  //we create the callback queue using base queue name + appending config hostname and :res for clarity
  //ie. if hostname is gateway-http and queue is service-oauth, response queue will be service-oauth:gateway-http:res
  //it is important to have different hostname or no hostname on each module sending message or there will be conflicts
  var resQueue = queue + ':' + this.conn.config.hostname + ':res';
  rpcQueue.queue = this.conn.get().then((channel) => {
    return channel.assertQueue(resQueue, { durable: true, exclusive: true })
      .then((_queue) => {
        rpcQueue.queue = _queue.queue;

        //if channel is closed, we want to make sure we cleanup the queue so future calls will recreate it
        this.conn.addListener('close', () => { delete rpcQueue.queue; createRpcQueue.call(this, queue); });

        return channel.consume(_queue.queue, maybeAnswer.call(this, queue), { noAck: true });
      })
      .then(() => rpcQueue.queue);
    })
    .catch(() => {
      delete rpcQueue.queue;
      return utils.timeoutPromise(this.conn.config.timeout).then(() => {
        return createRpcQueue.call(this, queue);
      });
    });

  return rpcQueue.queue;
}

/**
 * Get a function to execute on channel consumer incoming message is received
 * @param  {string} queue name of the queue where messages are SENT
 * @return {function}       function executed by an amqp.node channel consume callback method
 */
function maybeAnswer(queue) {
  var rpcQueue = amqpRPCQueues[queue];

  return (msg) => {
    //check the correlation ID sent by the initial message using RPC
    var corrId = msg.properties.correlationId;

    try {
      //if we found one, we execute the callback and delete it because it will never be received again anyway
      rpcQueue[corrId].resolve(parsers.in(msg));
      this.conn.config.transport.info('bmq:producer', '[' + queue + '] < answer');
      delete rpcQueue[corrId];
    } catch(e) {
      this.conn.config.transport.error(e);
    }
  };
}

function publishOrSendToQueue(queue, msg, options) {
  if (!options.routingKey) {
    return this.channel.sendToQueue(queue, msg, options);
  } else {
    return this.channel.publish(queue, options.routingKey, msg, options);
  }
}

/**
 * Send message with or without rpc protocol, and check if RPC queues are created
 * @param  {string} queue   the queue to send `msg` on
 * @param  {any} msg     string, object, number.. anything bufferable/serializable
 * @param  {object} options contain rpc property (if true, enable rpc for this message)
 * @return {Promise}         Resolves when message is correctly sent, or when response is received when rpc is enabled
 */
function checkRpc (queue, msg, options) {
  //messages are persistent
  options.persistent = true;

  if (options.rpc) {
    return createRpcQueue.call(this, queue)
    .then(() => {
      //generates a correlationId (random uuid) so we know which callback to execute on received response
      var corrId = uuid.v4();
      options.correlationId = corrId;
      //reply to us if you receive this message!
      options.replyTo = amqpRPCQueues[queue].queue;

      publishOrSendToQueue.call(this, queue, msg, options);

      //defered promise that will resolve when response is received
      amqpRPCQueues[queue][corrId] = Promise.defer();
      return amqpRPCQueues[queue][corrId].promise;
    });
  }

  return publishOrSendToQueue.call(this, queue, msg, options);
}

/**
 * Ensure channel exists and send message using `checkRpc`
 * @param  {string} queue   The destination queue on which we want to send a message
 * @param  {any} msg     Anything serializable/bufferable
 * @param  {object} options message options (persistent, durable, rpc, etc.)
 * @return {Promise}         checkRpc response
 */
function produce(queue, msg, options) {
  //default options are persistent and durable because we do not want to miss any outgoing message
  //unless user specify it
  options = Object.assign({ persistent: true, durable: true }, options);

  return this.conn.get()
  .then((_channel) => {
    this.channel = _channel;

    //undefined can't be serialized/buffered :p
    if (!msg) msg = null;

    this.conn.config.transport.info('bmq:producer', '[' + queue + '] > ', msg);

    return checkRpc.call(this, queue, parsers.out(msg, options), options);
  })
  .catch((err) => {
    //add timeout between retries because we don't want to overflow the CPU
    this.conn.config.transport.error('bmq:producer', err);
    return utils.timeoutPromise(this.conn.config.timeout)
    .then(() => {
      return produce.call(this, queue, msg, options);
    });
  });
}

module.exports = function(conn) {
  return { conn, produce };
};
