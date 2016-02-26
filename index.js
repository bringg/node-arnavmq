require('./lib/boot/logger');

var defaultConfig = {
  amqpUrl: 'amqp://localhost',
  amqpPrefetch: process.env.AMQP_PREFETCH || 1,
  amqpRequeue: true
};

module.exports = function(config) {
  for (var key in config) {
    if (config.hasOwnProperty(key) && defaultConfig.hasOwnProperty(key)) {
      defaultConfig[key] = config[key];
    }
  }

  return {
    producer: require('./lib/producer')(defaultConfig),
    consumer: require('./lib/consumer')(defaultConfig)
  };
};
