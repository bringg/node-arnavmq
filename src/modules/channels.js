const DEFAULT_CHANNEL = Symbol('DEFAULT_CHANNEL');

class Channels {
  constructor(connection, config) {
    this._connection = connection;
    this._config = config;

    this._channels = new Map();
  }

  get(queue, config) {
    // If we don't have custom prefetch create a new channel
    const defaultPrefetch = this._config.prefetch;
    const requestedPrefetch = config.prefetch || defaultPrefetch;
    if (typeof requestedPrefetch === 'number' && requestedPrefetch !== defaultPrefetch) {
      return this._get(queue, (channel) => {
        channel.prefetch(requestedPrefetch);
      });
    }

    return this.defaultChannel();
  }

  /**
   * Create the channel on the broker, once connection is successfuly opened.
   * Since RabbitMQ advise to open one channel by process and node is mono-core, we keep only 1 channel for the whole connection.
   * @return {Promise} A promise that resolve with an amqp.node channel object
   */
  _get(key, configure) {
    let channel = this._channels.get(key);

    // cache handling, if channel already opened, return it
    if (channel) {
      return Promise.resolve(channel);
    }

    channel = this._connection.createChannel().then((_channel) => {
      configure(_channel);

      // on error we remove the channel so the next call will recreate it (auto-reconnect are handled by connection users)
      _channel.on('close', () => {
        this._channels.delete(key);
      });
      _channel.on('error', (error) => {
        this._config.logger.error({
          message: `Got channel error [${error.message}] for [${key}]`,
          error,
        });
      });

      return _channel;
    });
    this._channels.set(key, channel);
    return channel;
  }

  defaultChannel() {
    return this._get(DEFAULT_CHANNEL, (channel) => {
      const { prefetch } = this._config;
      channel.prefetch(prefetch);
    });
  }

  _onError(error) {
    this._config.logger.error({
      message: error.message,
      error,
    });
  }
}

module.exports = Channels;
