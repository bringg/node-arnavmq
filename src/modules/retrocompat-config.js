/*jshint maxcomplexity:false*/
module.exports = function(config) {
  config = config || {};

  if (config.amqpUrl) {
    config.host = config.amqpUrl;
  }

  if (config.amqpPrefetch) {
    config.prefetch = config.amqpPrefetch;
  }

  if (config.amqpRequeue) {
    config.requeue = config.amqpRequeue;
  }

  if(config.amqpTimeout) {
    config.timeout = config.amqpTimeout;
  }

  if (process.env.LOCAL_QUEUE) {
    config.consumerSuffix = process.env.LOCAL_QUEUE;
  }

  if (process.env.AMQP_DEBUG) {
    try {
      config.transport = require('winston');
    } catch(e) {
      config.transport = console;
    }
  }
};
