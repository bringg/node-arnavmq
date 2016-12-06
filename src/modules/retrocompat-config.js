const { logger } = require('@dialonce/boot')();
// deprecated configuration property names
/* eslint global-require: "off" */
function oldConfigNames(config) {
  const configuration = Object.assign({}, config);
  if (configuration.amqpUrl) {
    configuration.host = configuration.amqpUrl;
  }

  if (configuration.amqpPrefetch) {
    configuration.prefetch = configuration.amqpPrefetch;
  }

  if (configuration.amqpRequeue) {
    configuration.requeue = configuration.amqpRequeue;
  }

  if (configuration.amqpTimeout) {
    configuration.timeout = configuration.amqpTimeout;
  }
  return configuration;
}

// deprecated env vars to configure the module
function envVars(config) {
  const configuration = Object.assign({}, config);
  if (process.env.AMQP_URL) {
    configuration.host = process.env.AMQP_URL;
  }

  if (process.env.LOCAL_QUEUE) {
    configuration.consumerSuffix = process.env.LOCAL_QUEUE;
  }

  if (process.env.AMQP_DEBUG) {
    try {
      configuration.transport = logger;
    } catch (e) {
      configuration.transport = console;
    }
  }
  return configuration;
}

/**
 * Retrocompatibility module to keep backward compat over configuration / env vars
 * @param  {object} config A BunnyMQ configuration object
 * @return {object}        Updated config object
 */
module.exports = (config) => {
  let configuration = Object.assign({}, config);
  configuration = envVars(configuration);
  configuration = oldConfigNames(configuration);

  return configuration;
};
