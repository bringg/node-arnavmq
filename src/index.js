var uuid = require('node-uuid'),
  utils = require('./modules/utils'),
  conn = require('./modules/connection'),
  retrocompat = require('./modules/retrocompat-config');

module.exports = function(_config) {
  retrocompat(_config);

  var config = utils.mergeObjects({
    host: 'amqp://localhost',
    prefetch: 5,
    requeue: true,
    timeout: 1000,
    consumerSuffix: '',
    hostname: process.env.HOSTNAME || process.env.USER || uuid.v4(),
    transport: utils.emptyLogger
  }, _config);

  return {
    producer: require('./modules/producer')(conn(config)),
    consumer: require('./modules/consumer')(conn(config))
  };
};
