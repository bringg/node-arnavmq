'use strict';

/**
 * @namespace Consumer
 */
var amqp = require('amqplib'),
  utils = require('./helpers/utils'),
  uuid = require('node-uuid'),
  parsers = require('./helpers/message-parsers');

var amqpConnection, amqpChannel, amqpConfig;
var amqpRPCQueues = {};

/**
 * Connect method used to connect the global connection object, when disconnected (not set). To be used inside a promise chain.
 * @return {Promise} When not connected, connects and returns a promise that resolve with the amqp connection object as parameter
 * @return {object} When connected, return the amqp connection object directly
 *
 * @example
 * return Promise.resolve()
 *   .then(connect)
 *   .then((conn) => {
 *     //conn is an amqp connection object
 *   });
 */
var connect = () => {
  if (!amqpConnection) {
    //if not connected, we unset the channel because a connection loss is a channel loss
    amqpChannel = null;
    //we store a promise in the global connect object and we return it, so callers can resolve when trully connected
    amqpConnection = new Promise((resolve, reject) => {
      let amqpUrl = utils.getValidUrl([amqpConfig.amqpUrl, process.env.AMQP_URL, 'amqp://localhost']);

      amqp.connect(amqpUrl, { clientProperties: { hostname: process.env.HOSTNAME } })
      .then((_connection) => {

        //on connection close unset the amqpConnection object so we can reconnect
        _connection.on('close', (err) => {
          if (err) Logger.error('ERROR:', err);
          amqpConnection = null;
        });

        _connection.on('error', Logger.error);

        //now stores the connection object in the global var so future calls to connect can resolve immediatly with the connect object
        amqpConnection = _connection;
        //resolve the previously returned promises for producers that called the connect method before being connected
        resolve(amqpConnection);
      })
      .catch((err) => {
        //unset the connection object and reject the connection promise so all previous calls to connect will fail
        amqpConnection = null;
        reject(err);
      });
    });
  }

  //return either the connection object or the promise that will resolve once connected
  return amqpConnection;
};

/**
 * createChannel method used to create a channel once connected. To be used inside a promise chain.
 * @return {Promise} When channel not created, returns a promise that resolve with the amqp channel object as parameter once channel is created
 * @return {object} When channel is created, return the channel object directly
 * 
 * @example
 * return Promise.resolve()
 *   .then(connect)
 *   .then(createChannel)
 *   .then((channel) => {
 *     //channel is an amqp channel object
 *   });
 */
var createChannel = () => {
  if (!amqpChannel) {
    //if there is no channel created, create a promise and temporarly returns it
    amqpChannel = new Promise((resolve, reject) => {
      amqpConnection.createChannel()
        .then((_channel) => {
          _channel.prefetch(amqpConfig.amqpPrefetch);

          Logger.info('[BMQ-PRODUCER] Is now connected and ready to produce messages');

          //on connect close, unset the channel so it can be created again later. Connection may not have been closed so there is no need to unset it.
          _channel.on('close', (err) => {
            Logger.error(err);
            amqpChannel = null;
          });

          _channel.on('error', Logger.error);

          //resolve previously returned promises with the channel and store channel inside the global channel object
          amqpChannel = _channel;
          resolve(amqpChannel);
        })
        .catch((err) => {
          //if an error occured, unset the channel and reject the previously returned promises
          amqpChannel = null;
          reject(err);
        });
    });
  }

  //return either a promise when channel does not exists, or the channel object directly
  return amqpChannel;
};

var createRpcQueue = (queue) => {
  if (amqpRPCQueues[queue].queue) return Promise.resolve();

  var resQueue = queue + ':' + (process.env.HOSTNAME || uuid.v4()) + ':res';
  return amqpChannel.assertQueue(resQueue, { durable: true, exclusive: true })
  .then((_queue) => {
    amqpRPCQueues[queue].queue = _queue.queue;
    return amqpChannel.consume(_queue.queue, maybeAnswer(queue), { noAck: true });
  })
  .then(() => {
    return queue;
  });
};

var maybeAnswer = (queue) => {
  return (_msg) => {
    var corrIdA = _msg.properties.correlationId;
    if (amqpRPCQueues[queue][corrIdA] !== undefined) {
      _msg = parsers.in(_msg);
      amqpRPCQueues[queue][corrIdA].resolve(_msg);
      Logger.info('[BMQ-PRODUCER][' + queue + '] < ', _msg);
      delete amqpRPCQueues[queue][corrIdA];
    }
  };
};

var checkRpc = (queue, msg, options) => {
  options.persistent = true;

  if (options.rpc) {
    if (!amqpRPCQueues[queue]) {
      amqpRPCQueues[queue] = {};
    }

    return createRpcQueue(queue)
    .then(() => {
      var corrId = uuid.v4();
      options.correlationId = corrId;
      options.replyTo = amqpRPCQueues[queue].queue;

      amqpChannel.sendToQueue(queue, msg, options);

      amqpRPCQueues[queue][corrId] = Promise.defer();
      return amqpRPCQueues[queue][corrId].promise;
    });
  }

  return amqpChannel.sendToQueue(queue, msg, options);
};

var produce = (queue, msg, options) => {
  return Promise.resolve()
  .then(connect)
  .then(createChannel)
  .then(() => {
    if (!msg) msg = null;

    options = options || { persistent: true, durable: true };

    Logger.info('[BMQ-PRODUCER][' + queue + '] > ', msg);

    return checkRpc(queue, parsers.out(msg, options), options);
  })
  .catch((err) => {
    Logger.error('[BMQ-PRODUCER]', err);
    return utils.timeoutPromise(amqpConfig.amqpTimeout)
    .then(() => {
      return produce(queue, msg, options);
    });
  });
};

module.exports = (config) => {
  amqpConfig = config;
  return { produce: produce };
};
