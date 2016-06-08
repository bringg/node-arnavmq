var uuid = require('node-uuid'),
  utils = require('./modules/utils'),
  conn = require('./modules/connection'),
  retrocompat = require('./modules/retrocompat-config');

module.exports = function(config) {
  //we want to keep retrocompatibility with older configuration format for a while (until 3.0.0)
  //everything in here is deprecated
  retrocompat(config);

  config = utils.mergeObjects({
    host: 'amqp://localhost',
    //number of fetched messages, at once
    prefetch: 5,
    //requeue put back message into the broker if consumer crashes/trigger exception
    requeue: true,
    //time between two reconnect (ms)
    timeout: 1000,
    consumerSuffix: '',
    //generate a hostname so we can track this connection on the broker (rabbitmq management plugin)
    hostname: process.env.HOSTNAME || process.env.USER || uuid.v4(),
    //the transport to use to debug. if provided, bunnymq will show some logs
    transport: utils.emptyLogger
  }, config);

  return {
    producer: require('./modules/producer')(conn(config)),
    consumer: require('./modules/consumer')(conn(config))
  };
};
