const amqp = require('amqplib');
const assert = require('assert');
const { Channels } = require('./channels');
const packageVersion = require('../../package.json').version;

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
      return Promise.resolve(connection);
    }

    // prepare the connection internal object, and reset channel if connection has been closed
    this.connections[url] = {
      conn: null,
      // Is going to be empty until we created a connection
      channels: null,
    };
    connection = this.connections[url];
    connection.conn = amqp
      .connect(url, {
        clientProperties: {
          hostname,
          arnavmq: packageVersion,
          startedAt: this.startedAt,
          connectedAt: new Date().toISOString(),
        },
      })
      .then((conn) => {
        // on connection close, delete connection
        conn.on('close', () => {
          delete connection.conn;
        });
        conn.on('error', this._onError.bind(this));
        connection.conn = conn;
        connection.channels = new Channels(conn, this._config);
        return connection;
      })
      .catch((e) => {
        connection.conn = null;
        connection.channels = null;
        throw e;
      });

    return connection.conn;
  }

  /**
   * Log errors from connection/channel error events.
   * @param {Error} error
   */
  _onError(error) {
    this._config.transport.error(error);
    this._config.logger.error({
      message: error.message,
      error,
    });
  }

  async getChannel(queue, config) {
    const connection = await this.getConnection();
    return connection.channels.get(queue, config);
  }

  async getDefaultChannel() {
    const connection = await this.getConnection();
    return connection.channels.defaultChannel();
  }

  /**
   * Register an event on the default amqp.node channel
   * @param {string} on     the channel event name to be bound with
   * @param {function} func the callback function to execute when the event is called
   */
  addListener(on, func) {
    this.getDefaultChannel().then((channel) => {
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
