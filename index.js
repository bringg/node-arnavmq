
var defaultConfig = {
  amqpUrl: process.env.AMQP_URL,
  prefetch: process.env.AMQP_PREFETCH || 1,
  isRequeueEnabled: true
};

module.exports = function(config) {
  require('./lib/boot/logger');

  if (typeof defaultConfig.prefetch !== 'number') {
    defaultConfig.prefetch = parseInt(prefetch);
  }

  return {
    producer: require('./lib/producer')(config || defaultConfig),
    consumer: require('./lib/consumer')(config || defaultConfig)
  };
};
