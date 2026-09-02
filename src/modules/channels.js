const { logger } = require('./logger');
const { withTimeout } = require('./utils');

const DEFAULT_CHANNEL = 'DEFAULT_CHANNEL';

// Cap on how long `closeAll()` waits for one channel's `Channel.Close-Ok`. The barrier is
// best-effort: the caller tears the connection down either way, so a broker that stops answering
// must not be able to hang the process's shutdown.
const CLOSE_CHANNEL_TIMEOUT_MS = 5000;

/**
 * Gracefully close one cached channel, bounded by `CLOSE_CHANNEL_TIMEOUT_MS`. Never rejects - see
 * `Channels.closeAll()`, its only caller.
 * @param {string} key The channel cache key, for logging.
 * @param {{chann: Promise}} entry The channel cache entry.
 * @return {Promise<void>}
 */
async function closeChannel(key, entry) {
  try {
    await withTimeout(
      (async () => {
        const channel = await entry.chann;
        await channel.close();
      })(),
      CLOSE_CHANNEL_TIMEOUT_MS,
      `channel "${key}" to close`,
    );
  } catch (error) {
    logger.warn({
      message: `Failed to gracefully close channel [${key}] before closing the connection - [${error.message}]`,
      error,
    });
  }
}

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

  async get(queue, config) {
    const defaultPrefetch = this._config.prefetch;
    const requestedPrefetch = config.prefetch || defaultPrefetch;
    if (typeof requestedPrefetch === 'number' && requestedPrefetch !== defaultPrefetch) {
      return await this._get(queue, config);
    }

    return await this.defaultChannel();
  }

  async defaultChannel() {
    return await this._get(DEFAULT_CHANNEL, { prefetch: this._config.prefetch });
  }

  /**
   * Creates or returns an existing channel by it's key and config.
   * @return {Promise} A promise that resolve with an amqp.node channel object
   */
  async _get(key, config = {}) {
    const existingChannel = this._channels.get(key);

    if (existingChannel) {
      if (!isSameConfig(existingChannel.config, config)) {
        throw new ChannelAlreadyExistsError(key, config);
      }

      return await existingChannel.chann;
    }

    const channelPromise = this._initNewChannel(key, config);
    this._channels.set(key, { chann: channelPromise, config });

    return await channelPromise;
  }

  /**
   * Gracefully close every cached channel, waiting for the broker to confirm each close, and empty
   * the cache. Never rejects: each channel is closed independently and its failure only logged, so
   * one bad channel can neither stop the others from closing nor stop the caller from proceeding.
   *
   * This exists as a synchronization barrier for connection teardown, not as cleanup.
   * `channel.ack()`/`channel.reject()` are fire-and-forget in AMQP 0-9-1 - there is no ack-ok frame
   * - so a handler's `ack()` returning only means the frame was written to the socket, not that the
   * broker processed it. `Channel.Close` *does* round-trip (amqplib resolves `close()` on
   * `Channel.Close-Ok`), and a broker processes one channel's frames in order, so once this
   * resolves every frame already *written* to the socket - the acks included - is guaranteed to have
   * been processed.
   *
   * Written, not merely requested: acks and rejects go out through amqplib's `sendImmediately`, so
   * they are genuinely ordered ahead of the `Channel.Close`. A synchronous method does not
   * necessarily - `sendOrEnqueue` parks it in the channel's `pending` list whenever another RPC is
   * still awaiting its reply, `Channel.Close` then jumps that list (it is `sendImmediately` too),
   * and `toClosed()` -> `_rejectPending()` discards whatever was parked with "Channel ended, no
   * reply will be forthcoming". So a `basic.cancel` that had been queued behind another RPC can be
   * dropped here - which is where `_cancelSubscription`'s "Failed to cancel consumer" log comes
   * from in that case: local frame dropping, not a broker refusal.
   *
   * Terminal: only call this when nothing in the process will ask for a channel again (see
   * `Connection.close()`, which is terminal for the process, and is the only caller).
   * @return {Promise<void>}
   */
  async closeAll() {
    const entries = [...this._channels.entries()];
    this._channels.clear();

    await Promise.all(entries.map(([key, entry]) => closeChannel(key, entry)));
  }

  async _initNewChannel(key, config) {
    let channel;
    try {
      channel = await this._connection.createChannel();

      channel.on('close', () => {
        this._channels.delete(key);
      });
      channel.on('error', (error) => {
        logger.error({
          message: `Got channel error [${error.message}] for [${key}]`,
          error,
        });
      });

      await channel.prefetch(config.prefetch);

      return channel;
    } catch (error) {
      this._channels.delete(key);
      logger.error({
        message: `Failed to create channel for [${key}] - [${error.message}]`,
        error,
      });

      if (channel) {
        try {
          await channel.close();
        } catch (closeError) {
          logger.error({
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
