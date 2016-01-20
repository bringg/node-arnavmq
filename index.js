
var defaultConfig = {
  isLogEnabled: true,
  amqpUrl: process.env.AMQP_URL || 'amqp://localhost',
  prefetch: process.env.AMQP_PREFETCH || 1,
  isRequeueEnabled: true
};

module.exports = function(config) {
  return {
    producer: require('./lib/producer')(config || defaultConfig),
    consumer: require('./lib/consumer')(config || defaultConfig)
  };
};
