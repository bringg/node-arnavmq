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
}

let instance;
module.exports.ArnavMQ = ArnavMQ;
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
    consumer,
    producer,
    hooks,
  };
};
