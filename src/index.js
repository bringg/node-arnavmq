const crypto = require('crypto');
const connection = require('./modules/connection');
const { Connection } = require('./modules/connection');
const Producer = require('./modules/producer');
const Consumer = require('./modules/consumer');
const { setLogger } = require('./modules/logger');

/* eslint global-require: "off" */
module.exports = (config) => {
  const configuration = {
    // amqp connection string
    host: 'amqp://localhost',

    // number of fetched messages, at once
    prefetch: 5,

    // requeue put back message into the broker if consumer crashes/trigger exception
    requeue: true,

    // time between two reconnect (ms)
    timeout: 1000,

    // the maximum number of retries when trying to send a message before throwing error when failing. If set to '0' will not retry. If set to less then '0', will retry indefinitely.
    producerMaxRetries: -1,

    // default timeout for RPC calls. If set to '0' there will be none.
    rpcTimeout: 15000,

    // suffix all queues names
    // ex: service-something with suffix :ci becomes service-suffix:ci etc.
    consumerSuffix: '',

    // generate a hostname so we can track this connection on the broker (rabbitmq management plugin)
    hostname: process.env.HOSTNAME || process.env.USER || crypto.randomUUID(),

    ...config,
  };

  if (configuration.transport) {
    throw new Error('Using removed deprecated "transport" option. Use the "logger" option instead.');
  }

  configuration.prefetch = parseInt(configuration.prefetch, 10) || 0;

  setLogger(configuration.logger);
  delete configuration.logger;

  Object.freeze(configuration);

  return require('./modules/arnavmq')(connection(configuration));
};

module.exports.createFresh = (config) => {
  const configuration = {
    host: 'amqp://localhost',
    prefetch: 5,
    requeue: true,
    timeout: 1000,
    producerMaxRetries: -1,
    rpcTimeout: 15000,
    consumerSuffix: '',
    hostname: process.env.HOSTNAME || process.env.USER || crypto.randomUUID(),
    ...config,
  };

  if (configuration.transport) {
    throw new Error('Using removed deprecated "transport" option. Use the "logger" option instead.');
  }

  configuration.prefetch = parseInt(configuration.prefetch, 10) || 0;

  setLogger(configuration.logger);
  delete configuration.logger;

  Object.freeze(configuration);

  const conn = new Connection(configuration);
  const producer = new Producer(conn);
  const consumer = new Consumer(conn);

  return {
    connection: conn,
    consume: (queue, options, callback) => consumer.subscribe(queue, options, callback),
    subscribe: (queue, options, callback) => consumer.subscribe(queue, options, callback),
    produce: (queue, msg, options) => producer.publish(queue, msg, options),
    publish: (queue, msg, options) => producer.publish(queue, msg, options),
    consumer: {
      consume: (queue, options, callback) => consumer.subscribe(queue, options, callback),
      subscribe: (queue, options, callback) => consumer.subscribe(queue, options, callback),
    },
    producer: {
      produce: (queue, msg, options) => producer.publish(queue, msg, options),
      publish: (queue, msg, options) => producer.publish(queue, msg, options),
    },
    hooks: {
      connection: conn.hooks,
      consumer: consumer.hooks,
      producer: producer.hooks,
    },
  };
};
