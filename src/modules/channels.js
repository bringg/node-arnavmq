const pDefer = require('p-defer');
const { logger } = require('./logger');

const DEFAULT_CHANNEL = 'DEFAULT_CHANNEL';

// Cap on how long `closeAll()` waits for one channel's `Channel.Close-Ok`. The barrier is
// best-effort: the caller tears the connection down either way, so a broker that stops answering
// must not be able to hang the process's shutdown.
const CLOSE_CHANNEL_TIMEOUT_MS = 5000;

/**
 * Resolves with `promise`, or rejects once `timeoutMs` elapses - whichever happens first.
 * A rejection handler is attached to `promise` up front so that if it loses the race and rejects
 * later, that rejection is already handled instead of surfacing as an unhandled rejection.
 * @param {Promise} promise
 * @param {number} timeoutMs
 * @param {string} what Described in the timeout error message.
 * @return {Promise}
 */
function withTimeout(promise, timeoutMs, what) {
  const deferredTimeout = pDefer();
  const timeoutId = setTimeout(
    () => deferredTimeout.reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`)),
    timeoutMs,
  );

  promise.catch(() => {});

  return Promise.race([promise, deferredTimeout.promise]).finally(() => clearTimeout(timeoutId));
}

/**
 * Gracefully close one cached channel, bounded by `CLOSE_CHANNEL_TIMEOUT_MS`. Never rejects - see
 * `Channels.closeAll()`, its only caller.
 * @param {string} key The channel cache key, for logging.
 * @param {{chann: Promise}} entry The channel cache entry.
 * @return {Promise<void>}
 */
async function closeChannel(key, entry) {
  try {
    // The cap covers `entry.chann` too, not just `close()`. A cache entry can still be pending when
    // shutdown starts - a channel allocated moments earlier whose `Channel.Open-Ok` or `Basic.Qos-Ok`
    // never arrived from a broker that has stopped answering but whose TCP connection is still up -
    // and awaiting that unbounded would hang `connection.close()` just as an unbounded `close()`
    // would, leaving only amqplib's 60s heartbeat monitor to break the deadlock (longer than a
    // typical 30s terminationGracePeriod, so: SIGKILL, the exact outcome this cap exists to avoid).
    await withTimeout(
      (async () => {
        const channel = await entry.chann;
        await channel.close();
      })(),
      CLOSE_CHANNEL_TIMEOUT_MS,
      `channel "${key}" to close`,
    );
  } catch (error) {
    // Expected and harmless when the channel never opened, or the broker/an earlier error already
    // closed it - there is nothing left to flush on it either way. Only worth noting because a
    // channel we failed to flush is one whose last acks may still lose the race against the
    // broker's requeue-on-disconnect cleanup.
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
   * resolves every frame previously written on those channels - the acks included - is guaranteed
   * to have been processed.
   *
   * Terminal: only call this when nothing in the process will ask for a channel again (see
   * `Connection.close()`, which is terminal for the process, and is the only caller).
   * @return {Promise<void>}
   */
  async closeAll() {
    // Snapshot and empty the cache up front: each channel's own 'close' listener below deletes its
    // own entry while we await, and nothing should be handed a channel we are midway through
    // closing.
    const entries = [...this._channels.entries()];
    this._channels.clear();

    await Promise.all(entries.map(([key, entry]) => closeChannel(key, entry)));
  }

  async _initNewChannel(key, config) {
    let channel;
    try {
      channel = await this._connection.createChannel();

      // Both listeners go on before the first await below, and must stay that way. amqplib routes a
      // server-sent `Channel.Close` through `safeEmit(channel, 'error', ...)`, which *rethrows* when
      // nothing is listening for 'error' (or 'handler-error') - and that throw unwinds out of
      // amqplib's frame-processing callback into an uncaught exception that kills the process. Any
      // await between `createChannel()` resolving and this point is a window where a broker-side
      // channel close crashes us.
      channel.on('close', () => {
        this._channels.delete(key);
      });
      channel.on('error', (error) => {
        logger.error({
          message: `Got channel error [${error.message}] for [${key}]`,
          error,
        });
      });

      // Awaited, not fire-and-forget: `prefetch()` is a `basic.qos` RPC, and closing a channel with
      // an RPC still outstanding rejects that RPC ("Channel ended, no reply will be forthcoming").
      // Unawaited that lands as an unhandled rejection - which `Channels.closeAll()` on shutdown
      // makes reachable for a channel created moments before close(). Awaiting also means a failed
      // qos surfaces through the catch below instead of silently leaving the channel misconfigured.
      // The 'close' listener above may fire during this await and delete this key; the catch below
      // deletes it too, which is idempotent.
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
