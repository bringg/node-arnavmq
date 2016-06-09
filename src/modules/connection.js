var amqp = require('amqplib'),
  assert = require('assert');

var connections = {};

/**
 * Connect to the broker. We keep only 1 connection for each connection string provided in config, as advised by RabbitMQ
 * @return {Promise} A promise that resolve with an amqp.node connection object
 */
function getConnection() {
  let url = this.config.url;
  let hostname = this.config.hostname;

  //cache handling, if connection already opened, return it
  if (connections[url] && connections[url].conn) {
    return Promise.resolve(connections[url].conn);
  }

  //prepare the connection internal object, and reset channel if connection has been closed
  connections[url] = { conn: null, channel: null };

  return amqp.connect(url, { clientProperties: { hostname: hostname } })
    .then((conn) => {
        //on connection close, delete connection
        conn.on('close', () => { delete connections[url].conn; });
        conn.on('error', this.config.transport.error);

        connections[url].conn = conn;
        return conn;
    });
}

/**
 * Create the channel on the broker, once connection is succesfuly opened.
 * Since RabbitMQ advise to open one channel by process and node is mono-core, we keep only 1 channel for the whole connection.
 * @return {Promise} A promise that resolve with an amqp.node channel object
 */
function getChannel() {
  let url = this.config.url;
  let prefetch = this.config.prefetch;

  //cache handling, if channel already opened, return it
  if (connections[url] && connections[url].chann) {
    return Promise.resolve(connections[url].chann);
  }

  return connections[url].conn.createChannel()
    .then((channel) => {
      channel.prefetch(prefetch);

      //on error we remove the channel so the next call will recreate it (auto-reconnect are handled by connection users)
      channel.on('close', () => { delete connections[url].chann; });
      channel.on('error', this.config.transport.error);

      connections[url].chann = channel;
      return channel;
    });
}

/**
 * Connect to AMQP and create channel
 * @return {Promise} A promise that resolve with an amqp.node channel object
 */
function get() {
  return getConnection.call(this)
    .then(() => {
      return getChannel.call(this);
    });
}

/**
 * Register an event on the amqp.node channel
 * @param {string} on   the channel event name to be binded with
 * @param {function} func the callback function to execute when the event is called
 */
function addListener(on, func) {
  this.get().then((channel) => {
    channel.on(on, func);
  });
}

module.exports = (config) => {
  assert(config.hostname);
  assert(config.hostname);

  return {
    config: config,
    get: get,
    addListener: addListener
  };
};
