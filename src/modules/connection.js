const amqp = require('amqplib');
const assert = require('assert');
const packageVersion = require('../../package.json').version;

const DEFAULT_CHANNEL = 'DEFAULT_CHANNEL';

class Connection {
  constructor(config) {
    this._config = config;
    this.connections = {};
    this.startedAt = new Date().toISOString();
  }

  /**
   * Connect to the broker. We keep only 1 connection for each connection string provided in config, as advised by RabbitMQ
   * @return {Promise} A promise that resolve with an amqp.node connection object
  */
  getConnection() {
    const url = this._config.host;
    const { hostname } = this._config;
    let connection = this.connections[url];

    // cache handling, if connection already opened, return it
    if (connection && connection.conn) {
      return Promise.resolve(connection.conn);
    }
    // prepare the connection internal object, and reset channel if connection has been closed
    this.connections[url] = {
      conn: null,
      channels: { [DEFAULT_CHANNEL]: null }
    };
    connection = this.connections[url];
    connection.conn = amqp.connect(url, {
      clientProperties: {
        hostname,
        arnavmq: packageVersion,
        startedAt: this.startedAt,
        connectedAt: new Date().toISOString()
      }
    }).then((conn) => {
      // on connection close, delete connection
      conn.on('close', () => {
        delete connection.conn;
      });
      conn.on('error', this._onError.bind(this));
      connection.conn = conn;
      return conn;
    }).catch((e) => {
      connection.conn = null;
      throw e;
    });
    return connection.conn;
  }

  /**
   * Create the channel on the broker, once connection is successfuly opened.
   * Since RabbitMQ advise to open one channel by process and node is mono-core, we keep only 1 channel for the whole connection.
   * @return {Promise} A promise that resolve with an amqp.node channel object
  */
  getChannel(queue, prefetch) {
    const url = this._config.host;
    const connection = this.connections[url];

    const channelToUse = prefetch && queue ? queue : DEFAULT_CHANNEL;

    // cache handling, if channel already opened, return it
    if (connection && connection.channels[channelToUse]) {
      if (prefetch) {
        throw new Error(`Channel already exist for queue ${queue}`);
      }
      return Promise.resolve(connection.channels[channelToUse]);
    }

    connection.channels[channelToUse] = connection.conn.createChannel()
      .then((channel) => {
        channel.prefetch(prefetch || this._config.prefetch);

        // on error we remove the channel so the next call will recreate it (auto-reconnect are handled by connection users)
        channel.on('close', () => { delete connection.channels[channelToUse]; });
        channel.on('error', this._onError.bind(this));

        connection.channels[channelToUse] = channel;
        return channel;
      });
    return connection.channels[channelToUse];
  }

  /**
   * Log errors from connection/channel error events.
   * @param {Error} error
   */
  _onError(error) {
    this._config.transport.error(error);
    this._config.logger.error({
      message: error.message,
      error
    });
  }

  /**
   * Connect to AMQP and create channel
   * @return {Promise} A promise that resolve with an amqp.node channel object
   */
  get(queue, prefetch) {
    return this.getConnection().then(() => this.getChannel(queue, prefetch));
  }

  /**
   * Register an event on the amqp.node channel
   * @param {string} on     the channel event name to be bound with
   * @param {function} func the callback function to execute when the event is called
   */
  addListener(on, func) {
    this.get().then((channel) => {
      channel.on(on, func);
    });
  }

  get config() {
    return this._config;
  }

  set config(value) {
    this._config = value;
  }
}

let instance;

module.exports.DEFAULT_CHANNEL = DEFAULT_CHANNEL;
module.exports = (config) => {
  assert(instance || config, 'Connection can not be created because config does not exist');
  assert(config.hostname);
  if (!instance) {
    instance = new Connection(config);
  } else {
    instance.config = config;
  }
  return instance;
};
