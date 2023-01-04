const amqp = require('amqplib');
const assert = require('assert');
const packageVersion = require('../../package.json').version;

const DEFAULT_CHANNEL = Symbol('DEFAULT_CHANNEL');

class ChannelError extends Error {}

class ChannelAlreadyExistError extends ChannelError {}

const getChannelByQueue = (prefetch, queue) => {
  if (prefetch && queue) {
    return queue;
  }
  return DEFAULT_CHANNEL;
};

const getPrefetchFromChannelOptions = (channelOptions) => {
  if (channelOptions && channelOptions.prefetch) {
    return channelOptions.prefetch;
  }
  return null;
};

const getChannelOptions = (options) => {
  if (options) {
    return options.channel;
  }
  return undefined;
};

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
   * Create the channel on the broker, once connection is successfully opened.
   * By default, since RabbitMQ advise to open one channel by process and node is mono-core, we keep only 1 channel for the whole connection.
   * If prefetch was given in options.channel.prefetch, it create a different channels per queue with the given prefetch.
   * @return {Promise} A promise that resolve with an amqp.node channel object
  */
  getChannel(queue, options) {
    const url = this._config.host;
    const connection = this.connections[url];
    const channelOptions = getChannelOptions(options);
    const prefetch = channelOptions ? channelOptions.prefetch : undefined;
    const channelToUse = getChannelByQueue(prefetch, queue);

    // cache handling, if channel already opened, return it
    if (connection && connection.channels[channelToUse]) {
      const existingConnection = connection.channels[channelToUse];
      const existingPrefetch = existingConnection.options && existingConnection.options.prefetch ? existingConnection.options.prefetch : this._config.prefetch;
      if (prefetch && existingPrefetch !== prefetch) {
        throw new ChannelAlreadyExistError(`Channel already exist for queue ${queue} with prefetch ${existingPrefetch}`);
      }
      return Promise.resolve(connection.channels[channelToUse].channel);
    }

    const createdChannel = connection.conn.createChannel()
      .then((channel) => {
        channel.prefetch(prefetch || this._config.prefetch);

        // on error we remove the channel so the next call will recreate it (auto-reconnect are handled by connection users)
        channel.on('close', () => {
          delete connection.channels[channelToUse].channel;
          delete connection.channels[channelToUse];
        });
        channel.on('error', this._onError.bind(this));

        connection.channels[channelToUse] = { channel, options: channelOptions };
        return channel;
      });
    connection.channels[channelToUse] = { channel: createdChannel, options: channelOptions };
    return connection.channels[channelToUse].channel;
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
  get(queue, options) {
    return this.getConnection().then(() => this.getChannel(queue, options));
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

module.exports.getChannelOptions = getChannelOptions;
module.exports.getChannelToUse = (options, queue) => {
  const channelOptions = getChannelOptions(options);
  const prefetch = getPrefetchFromChannelOptions(channelOptions);
  return getChannelByQueue(prefetch, queue);
};
module.exports.ChannelAlreadyExistError = ChannelAlreadyExistError;
module.exports.DEFAULT_CHANNEL = DEFAULT_CHANNEL;
module.exports.instance = (config) => {
  assert(instance || config, 'Connection can not be created because config does not exist');
  assert(config.hostname);
  if (!instance) {
    instance = new Connection(config);
  } else {
    instance.config = config;
  }
  return instance;
};
