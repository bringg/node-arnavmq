const amqp = require('amqplib');
const assert = require('assert');
const { Channels } = require('./channels');
const packageVersion = require('../../package.json').version;

class Connection {
  constructor(config) {
    this._config = config;

    this._connection = null; // Promise of amqp connection
    this._channels = null;
    this.startedAt = new Date().toISOString();
  }

  /**
   * Connect to the broker. We keep only 1 connection for each connection string provided in config, as advised by RabbitMQ
   * @return {Promise} A promise that resolve with an amqp.node connection object
   */
  async getConnection() {
    try {
      // cache handling, if connection already opened, return it
      if (this._connection) {
        return this._connection;
      }

      // prepare the connection internal object, and reset channel if connection has been closed
      const connection = await amqp.connect(this._config.host, {
        clientProperties: {
          hostname: this._config.hostname,
          arnavmq: packageVersion,
          startedAt: this.startedAt,
          connectedAt: new Date().toISOString(),
        },
      });

      this._channels = new Channels(connection, this._config);
      // on connection close, delete connection
      connection.on('close', () => {
        this._connection = null;
        this._channels = null;
      });
      connection.on('error', this._onError.bind(this));

      this._connection = connection;
      return connection;
    } catch (error) {
      this._connection = null;
      this._channels = null;
      throw error;
    }
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
    await this.getConnection();
    return this._channels.get(queue, config);
  }

  async getDefaultChannel() {
    await this.getConnection();
    return this._channels.defaultChannel();
  }

  /**
   * Register an event on the default amqp.node channel
   * @param {string} on     the channel event name to be bound with
   * @param {function} func the callback function to execute when the event is called
   */
  async addListener(on, func) {
    const channel = await this.getDefaultChannel();
    channel.on(on, func);
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
