var amqp = require('amqplib'),
  assert = require('assert');

var connections = {};

function getConnection() {
  let url = this.config.url;
  let hostname = this.config.hostname;

  if (connections[url] && connections[url].conn) {
    return Promise.resolve(connections[url].conn);
  }

  connections[url] = { conn: null, channel: null };

  return amqp.connect(url, { clientProperties: { hostname: hostname } })
    .then((conn) => {
        conn.on('close', () => { connections[url].conn = null; });
        conn.on('error', this.config.transport.error);

        connections[url].conn = conn;
        return conn;
    });
}

function getChannel() {
  let url = this.config.url;
  let prefetch = this.config.prefetch;

  if (connections[url] && connections[url].chann) {
    return connections[url].chann;
  }

  return connections[url].conn.createChannel()
    .then((channel) => {
      channel.prefetch(prefetch);

      channel.on('close', () => { connections[url].chann = null; });
      channel.on('error', this.config.transport.error);

      connections[url].chann = channel;
      return channel;
    });
}

function get() {
  return getConnection.call(this)
    .then(() => {
      return getChannel.call(this);
    });
}

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
