const DEFAULT_CHANNEL = Symbol('DEFAULT_CHANNEL');

class ChannelAlreadyExistsError extends Error {
  constructor(name, config) {
    const message = `Channel "${name}" already exists with config ${JSON.stringify(config)}`;

    super(message);

    this.name = name;
    this.config = config;
    this.message = message;

    Error.captureStackTrace(this, this.constructor);
  }
}

function isSameConfig(a, b) {
  return a.prefetch === b.prefetch;
}

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
      return this._get(queue, config);
    }

    return this.defaultChannel();
  }

  defaultChannel() {
    return this._get(DEFAULT_CHANNEL, { prefetch: this._config.prefetch });
  }

  /**
   * Creates or returns an existing channel by it's key and config.
   * @return {Promise} A promise that resolve with an amqp.node channel object
   */
  async _get(key, config = {}) {
    const existingChannel = this._channels.get(key);

    if (existingChannel) {
      if (!isSameConfig(existingChannel.config, config)) {
        return Promise.reject(new ChannelAlreadyExistsError(key, config));
      }

      // cache handling, if channel already opened, return it
      return existingChannel.chann;
    }

    return this._initNewChannel(key, config);
  }

  async _initNewChannel(key, config) {
    let channel;
    try {
      channel = await this._connection.createChannel();
      channel.prefetch(config.prefetch);

      // on error we remove the channel so the next call will recreate it (auto-reconnect are handled by connection users)
      channel.on('close', () => {
        this._channels.delete(key);
      });
      channel.on('error', (error) => {
        this._config.logger.error({
          message: `Got channel error [${error.message}] for [${key}]`,
          error,
        });
      });

      this._channels.set(key, { chann: channel, config });
      return channel;
    } catch (error) {
      this._channels.delete(key);
      this._config.logger.error({
        message: `Failed to create channel for [${key}] - [${error.message}]`,
        error,
      });

      // Should not happen, but just in case
      if (channel) {
        try {
          await channel.close();
        } catch (closeError) {
          this._config.logger.error({
            message: `Failed to cleanup channel after failed initialization for [${key}] - [${closeError.message}]`,
            error: closeError,
          });
        }
      }
      throw error;
    }
  }
}

module.exports = { Channels, ChannelAlreadyExistsError };
