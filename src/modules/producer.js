/**
 * @namespace Consumer
 */
var utils = require('./utils'),
  uuid = require('node-uuid'),
  parsers = require('./message-parsers');

var amqpRPCQueues = {};

function createRpcQueue(queue) {
  if (amqpRPCQueues[queue].queue) return Promise.resolve();

  var resQueue = queue + ':' + process.env.HOSTNAME + ':res';
  return this.channel.assertQueue(resQueue, { durable: true, exclusive: true })
  .then((_queue) => {
    amqpRPCQueues[queue].queue = _queue.queue;

    this.conn.addListener('close', () => {
      amqpRPCQueues[queue].queue = null;
    });

    return this.channel.consume(_queue.queue, maybeAnswer.call(this, queue), { noAck: true });
  })
  .then(() => {
    return queue;
  });
}

function maybeAnswer(queue) {
  return (_msg) => {
    var corrIdA = _msg.properties.correlationId;
    if (amqpRPCQueues[queue][corrIdA] !== undefined) {
      _msg = parsers.in(_msg);
      amqpRPCQueues[queue][corrIdA].resolve(_msg);
      this.conn.config.transport.info('amqp:producer', '[' + queue + '] < ', _msg);
      delete amqpRPCQueues[queue][corrIdA];
    }
  };
}

function checkRpc (queue, msg, options) {
  options.persistent = true;

  if (options.rpc) {
    if (!amqpRPCQueues[queue]) {
      amqpRPCQueues[queue] = {};
    }

    return createRpcQueue.call(this, queue)
    .then(() => {
      var corrId = uuid.v4();
      options.correlationId = corrId;
      options.replyTo = amqpRPCQueues[queue].queue;

      this.channel.sendToQueue(queue, msg, options);

      amqpRPCQueues[queue][corrId] = Promise.defer();
      return amqpRPCQueues[queue][corrId].promise;
    });
  }

  return this.channel.sendToQueue(queue, msg, options);
}

function produce(queue, msg, options) {
  return this.conn.get()
  .then((_channel) => {
    this.channel = _channel;

    if (!msg) msg = null;

    options = options || { persistent: true, durable: true };

    this.conn.config.transport.info('amqp:producer', '[' + queue + '] > ', msg);

    return checkRpc.call(this, queue, parsers.out(msg, options), options);
  })
  .catch((err) => {
    this.conn.config.transport.error('amqp:producer', err);
    return utils.timeoutPromise(this.conn.config.timeout)
    .then(() => {
      return produce.call(this, queue, msg, options);
    });
  });
}

module.exports = function(_conn) {
  return {
    conn: _conn,
    produce: produce
  };
};
