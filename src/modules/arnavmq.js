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
   * Graceful shutdown: cancel consumers -> drain in-flight handlers (rejecting+requeueing any
   * still running past the timeout) -> reject pending RPC waiters -> close the connection.
   * Idempotent - every step it delegates to (consumer.stop(), producer.stop(), connection.close())
   * is itself idempotent, so repeated calls are cheap no-ops rather than re-running the sequence.
   *
   * The connection is deliberately kept open through the cancel/drain step: `checkRpc` needs it to
   * reply, and handlers may still `produce()`/`publish()` as part of their work while draining.
   * `connection.close()` (the last step) is the first point at which produce()/publish() starts
   * failing with `ConnectionClosedError`.
   * @param {object} [options]
   * @param {number} [options.timeout] Drain budget in ms, passed through to consumer.stop().
   *   Defaults to the `shutdownTimeout` config value (30000ms).
   * @return {Promise<{drained: boolean, abandoned: Record<string, number>}>} The drain outcome:
   *   `drained` is false when the timeout elapsed and messages had to be abandoned, and `abandoned`
   *   maps queue name to how many messages were abandoned on it (`{}` on a clean drain). Surfaced so
   *   callers can log/emit a shutdown metric; ignoring the return value is perfectly fine.
   */
  async close(options = {}) {
    const timeout = options.timeout ?? this.connection.config?.shutdownTimeout;

    const { drained, abandoned } = await this.consumer.stop({ timeout });
    this.producer.stop();
    await this.connection.close();

    return { drained, abandoned };
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
    cancel: instance.consumer.cancel.bind(instance.consumer),
    stop: instance.consumer.stop.bind(instance.consumer),
    drain: instance.consumer.drain.bind(instance.consumer),
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
