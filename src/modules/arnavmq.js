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

function buildReturnObject(inst) {
  const consumer = {
    consume: inst.consume.bind(inst),
    subscribe: inst.subscribe.bind(inst),
  };

  const producer = {
    produce: inst.produce.bind(inst),
    publish: inst.publish.bind(inst),
  };

  return {
    connection: inst.connection,
    consume: consumer.consume,
    subscribe: consumer.subscribe,
    produce: producer.produce,
    publish: producer.publish,
    consumer,
    producer,
    hooks: {
      connection: inst.connection.hooks,
      consumer: inst.consumer.hooks,
      producer: inst.producer.hooks,
    },
  };
}

let instance;
module.exports = (connection) => {
  assert(instance || connection, 'ArnavMQ can not be initialized because connection does not exist');

  if (!instance) {
    instance = new ArnavMQ(connection);
  } else {
    instance.connection = connection;
  }

  return buildReturnObject(instance);
};

module.exports.createFresh = (connection) => buildReturnObject(new ArnavMQ(connection));
