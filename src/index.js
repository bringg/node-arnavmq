require('dotenv').config({ silent: true });
const uuid = require('uuid');
const utils = require('./modules/utils');
const connection = require('./modules/connection');
const retrocompat = require('./modules/retrocompat-config');
require('@dialonce/boot')({
  LOGS_TOKEN: process.env.LOGS_TOKEN,
  BUGS_TOKEN: process.env.BUGS_TOKEN
});

require('events').EventEmitter.prototype._maxListeners = process.env.MAX_EMITTERS || 20;

/* eslint global-require: "off" */
module.exports = (config) => {
  let configuration = Object.assign({}, config);
  // we want to keep retrocompatibility with older configuration format for a while (until 3.0.0)
  // everything in here is deprecated
  configuration = retrocompat(configuration);

  configuration = Object.assign({
    host: 'amqp://localhost',
    // number of fetched messages, at once
    prefetch: 5,
    // requeue put back message into the broker if consumer crashes/trigger exception
    requeue: true,
    //  time between two reconnect (ms)
    timeout: 1000,
    //  default timeout for RPC calls. If set to '0' there will be none.
    rpcTimeout: 1000,
    consumerSuffix: '',
    // generate a hostname so we can track this connection on the broker (rabbitmq management plugin)
    hostname: process.env.HOSTNAME || process.env.USER || uuid.v4(),
    // the transport to use to debug. if provided, bunnymq will show some logs
    transport: utils.emptyLogger
  }, configuration);

  configuration.prefetch = parseInt(configuration.prefetch, 10) || 0;
  return require('./modules/bunnymq')(connection(configuration));
};
