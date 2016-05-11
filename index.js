require('./lib/boot/logger');

var defaultConfig = {
  amqpUrl: process.env.AMQP_URL || 'amqp://localhost',
  amqpPrefetch: process.env.AMQP_PREFETCH || 5,
  amqpRequeue: true,
  amqpTimeout: 1000
};

module.exports = function(config) {
  for (var key in config) {
    if (config.hasOwnProperty(key) && defaultConfig.hasOwnProperty(key)) {
      defaultConfig[key] = config[key];
    }
  }

  defaultConfig.amqpPrefetch = parseInt(defaultConfig.amqpPrefetch) || 5;

  return {
    producer: require('./lib/producer')(defaultConfig),
    consumer: require('./lib/consumer')(defaultConfig)
  };
};
