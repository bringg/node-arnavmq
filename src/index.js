const uuid = require('uuid');
const utils = require('./modules/utils');
const connection = require('./modules/connection');

/* eslint global-require: "off" */
module.exports = (config) => {
  let configuration = { ...config };

  configuration = {
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
    hostname: process.env.HOSTNAME || process.env.USER || uuid.v4(),

    // the transport to use to debug. if provided, arnavmq will show some logs
    transport: utils.emptyLogger,

    ...configuration
  };

  configuration.prefetch = parseInt(configuration.prefetch, 10) || 0;
  return require('./modules/arnavmq')(connection(configuration));
};
