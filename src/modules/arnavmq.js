const assert = require('assert');
const Producer = require('./producer');
const Consumer = require('./consumer');

class ArnavMQ {
  constructor(connection) {
    this._connection = connection;
    this.producer = new Producer(connection);
    this.consumer = new Consumer(connection);
  }

  get connection() {
    return this._connection;
  }

  set connection(value) {
    this._connection = value;
    this.producer.connection = value;
    this.consumer.connection = value;
  }

  // for backward compatibility. @deprecated
  consume(queue, options, callback) {
    return this.consumer.subscribe(queue, options, callback);
  }

  subscribe(queue, options, callback) {
    return this.consumer.subscribe(queue, options, callback);
  }

  // for backward compatibility. @deprecated
  produce(queue, msg, options) {
    return this.producer.publish(queue, msg, options);
  }

  publish(queue, msg, options) {
    return this.producer.publish(queue, msg, options);
  }

  /**
   * Graceful shutdown: stop consuming -> let every in-flight handler finish (no timeout) -> close
   * the connection. Idempotent; repeated calls are cheap no-ops rather than re-running the
   * sequence.
   *
   * The connection stays open for the whole drain, so a handler can finish its work: publish
   * downstream, reply to an RPC request it had already received, or await an RPC response of its
   * own - the reply-queue consumer is not one of the subscriptions that get cancelled, so answers
   * keep arriving. Anything a handler starts is waited on too.
   *
   * There is no drain timeout: a handler that never finishes means close() never resolves - left to
   * the process orchestrator's own kill grace period rather than this library abandoning in-flight
   * work on a clock. That includes a handler awaiting an RPC response that nobody is left to send
   * (the peer is shutting down too, or is served by a consumer this process just cancelled).
   *
   * Closing the connection is what fails pending RPC waiters, via producer.js's channel-close
   * listener - so callers fail fast with `ConnectionClosedError` rather than hanging out
   * `rpcTimeout`.
   * @return {Promise<void>}
   */
  async close() {
    await this.consumer.stop();
    await this.connection.close();
  }
}

let instance;
module.exports = (connection) => {
  assert(instance || connection, 'ArnavMQ can not be initialized because connection does not exist');

  if (!instance) {
    instance = new ArnavMQ(connection);
  } else {
    instance.connection = connection;
  }

  const consumer = {
    consume: instance.consume.bind(instance),
    subscribe: instance.subscribe.bind(instance),
    inFlight: instance.consumer.inFlight.bind(instance.consumer),
  };

  const producer = {
    produce: instance.produce.bind(instance),
    publish: instance.publish.bind(instance),
  };

  const hooks = {
    connection: instance.connection.hooks,
    consumer: instance.consumer.hooks,
    producer: instance.producer.hooks,
  };

  return {
    connection: instance.connection,
    consume: consumer.consume,
    subscribe: consumer.subscribe,
    produce: producer.produce,
    publish: producer.publish,
    close: instance.close.bind(instance),
    consumer,
    producer,
    hooks,
  };
};

// Exposed for tests that need an ArnavMQ instance isolated from the process-wide singleton above
// (e.g. to exercise close() without terminally closing the connection every other spec file
// shares). Assigned after the module.exports reassignment above - assigning it before, the way
// this file previously did, gets clobbered by that reassignment and is unreachable.
module.exports.ArnavMQ = ArnavMQ;
