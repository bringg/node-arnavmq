require('./lib/boot/logger');

var defaultConfig = {
  amqpUrl: process.env.AMQP_URL,
  prefetch: process.env.AMQP_PREFETCH || 1,
  isRequeueEnabled: true
};

if (typeof defaultConfig.prefetch !== 'number') {
  console.log(defaultConfig);
  defaultConfig.prefetch = parseInt(defaultConfig.prefetch);
}

module.exports = function(config) {
  return {
    producer: require('./lib/producer')(config || defaultConfig),
    consumer: require('./lib/consumer')(config || defaultConfig)
  };
};
