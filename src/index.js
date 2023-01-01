const uuid = require('uuid');
const utils = require('./modules/utils');
const connection = require('./modules/connection');
const { ARNAVMQ_TRANSPORT_LOGGER_DEPRECATED } = require('./modules/warnings');

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
    hostname: process.env.HOSTNAME || process.env.USER || uuid.v4(),

    // Deprecated. Use 'logger' instead. The transport to use to debug. If provided, arnavmq will show some logs
    transport: utils.emptyLogger,

    /**
     * A logger object with a log function for each of the log levels ("debug", "info", "warn", or "error").
     * Each log function receives one parameter containing a log event with the following fields:
     * * message - A string message describing the event. Always present.
     * * error - An 'Error' object in case one is present.
     * * params - An optional object containing extra parameters that can provide extra context for the event.
     */
    logger: utils.emptyLogger,

    ...config
  };

  if (configuration.transport !== utils.emptyLogger) {
    utils.emitWarn(ARNAVMQ_TRANSPORT_LOGGER_DEPRECATED);
  }

  configuration.prefetch = parseInt(configuration.prefetch, 10) || 0;
  return require('./modules/arnavmq')(connection.instance(configuration));
};
