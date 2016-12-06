const { logger } = require('@dialonce/boot')();
// deprecated configuration property names
/* eslint no-param-reassign: "off" */
/* eslint global-require: "off" */
function oldConfigNames(config) {
  if (config.amqpUrl) {
    config.host = config.amqpUrl;
  }

  if (config.amqpPrefetch) {
    config.prefetch = config.amqpPrefetch;
  }

  if (config.amqpRequeue) {
    config.requeue = config.amqpRequeue;
  }

  if (config.amqpTimeout) {
    config.timeout = config.amqpTimeout;
  }
}

// deprecated env vars to configure the module
function envVars(config) {
  if (process.env.AMQP_URL && !config.host) {
    config.host = process.env.AMQP_URL;
  }

  if (process.env.LOCAL_QUEUE && !config.consumerSuffix) {
    config.consumerSuffix = process.env.LOCAL_QUEUE;
  }

  if (process.env.AMQP_DEBUG) {
    try {
      config.transport = logger;
    } catch (e) {
      config.transport = console;
    }
  }
}

/**
 * Retrocompatibility module to keep backward compat over configuration / env vars
 * @param  {object} config A BunnyMQ configuration object
 * @return {object}        Updated config object
 */
module.exports = (config) => {
  config = config || {};
  envVars(config);
  oldConfigNames(config);

  return config;
};
