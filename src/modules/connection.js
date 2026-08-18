const assert = require('assert');
const amqp = require('amqplib');
const { Channels } = require('./channels');
const { ConnectionHooks } = require('./hooks');
const packageVersion = require('../../package.json').version;
const { logger } = require('./logger');

/**
 * Log errors from connection/channel error events.
 * @param {Error} error
 */
function onConnectionError(error) {
  logger.error({
    message: error.message,
    error,
  });
}

/**
 * Thrown by `getConnection()` once `close()` has been called - the connection is terminally shut
 * down for the process and will never reconnect.
 */
class ConnectionClosedError extends Error {
  constructor(message = 'Connection is closed') {
    super(message);

    this.name = 'ConnectionClosedError';
    this.message = message;

    Error.captureStackTrace(this, this.constructor);
  }
}

class Connection {
  constructor(config) {
    this._config = config;

    this._connectionPromise = null; // Promise of amqp connection
    this._channels = null;
    this._closePromise = null;
    this.hooks = new ConnectionHooks();
    this.startedAt = new Date().toISOString();
  }

  /**
   * Whether `close()` has been called on this connection. Once true, it never goes back to false -
   * the connection is terminally shut down for the process.
   * @return {boolean}
   */
  get isClosed() {
    return !!this._closePromise;
  }

  /**
   * Connect to the broker. We keep only 1 connection for each connection string provided in config, as advised by RabbitMQ
   * @return {Promise} A promise that resolve with an amqp.node connection object
   */
  async getConnection() {
    if (this.isClosed) {
      throw new ConnectionClosedError();
    }

    // cache handling, if connection already opened, return it
    if (!this._connectionPromise) {
      this._connectionPromise = this._connect();
    }

    return await this._connectionPromise;
  }

  /**
   * Terminally close this connection for the process: gracefully close every channel (which flushes
   * any ack/reject still in flight to the broker - see `Channels.closeAll()`), then close the
   * socket. Idempotent - safe to call more than once, sequentially or concurrently; every caller
   * shares the same underlying close. Never rejects; teardown errors are logged. After this
   * resolves, `getConnection()` (and anything built on it) rejects with `ConnectionClosedError`.
   * @return {Promise<void>}
   */
  async close() {
    if (!this._closePromise) {
      this._closePromise = this._close();
    }

    return await this._closePromise;
  }

  async _close() {
    // `close()` already set `this._closePromise` (which `isClosed` reads) before calling us, so any
    // connect racing us (or starting after us) is rejected instead of handed a connection we're
    // about to tear down.

    // Don't race a connect already in progress - wait for it to settle (either way) before we
    // try to close anything.
    let connection = null;
    try {
      connection = await this._connectionPromise;
    } catch (error) {
      // The in-flight connect failed on its own; there's nothing for us to close.
      logger.debug({
        message: `Ignoring failed in-flight connection attempt while closing: ${error.message}`,
        error,
      });
      connection = null;
    }

    if (connection) {
      // Flush the channels before tearing the socket down, don't just drop them with it. A drained
      // handler's `channel.ack()` is fire-and-forget on the wire (AMQP 0-9-1 has no ack-ok frame),
      // so closing the raw connection immediately after it races that ack against the broker's own
      // "requeue everything still unacked on this connection" cleanup - and loses often enough to
      // redeliver a message that was fully processed and acked. `Channels.closeAll()` round-trips
      // with the broker per channel, which guarantees those acks were processed first.
      //
      // Read `this._channels` only after the await above: the connection's own 'close' handler
      // nulls it, and the connection may have died while we were waiting for the connect to settle.
      //
      // Closing a channel emits 'close' on it, which consumer.js listens for to resubscribe.
      // Consumer._isLive() checks `this._connection.isClosed` (set above, before this await), so
      // that listener is a no-op regardless of whether `arnavmq.close()` ran `consumer.stop()`
      // first - calling this method directly is safe even with active subscriptions.
      const channels = this._channels;
      if (channels) {
        try {
          await channels.closeAll();
        } catch (error) {
          // closeAll() already logs and swallows per channel; this is belt-and-braces so a broken
          // channel cache can never stop us from closing the socket, or make close() reject.
          logger.error({
            message: `Error closing amqp channels: ${error.message}`,
            error,
          });
        }
      }

      try {
        await connection.close();
      } catch (error) {
        logger.error({
          message: `Error closing amqp connection: ${error.message}`,
          error,
        });
      }
    }

    this._connectionPromise = null;
    this._channels = null;
  }

  async _connect() {
    try {
      await this.hooks.trigger(this, ConnectionHooks.beforeConnectEvent, { config: this._config });
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
        this._connectionPromise = null;
        this._channels = null;
      });
      connection.on('error', onConnectionError);

      await this.hooks.trigger(this, ConnectionHooks.afterConnectEvent, { config: this._config, connection });

      return connection;
    } catch (error) {
      await this.hooks.trigger(this, ConnectionHooks.afterConnectEvent, { config: this._config, error });
      this._connectionPromise = null;
      this._channels = null;
      throw error;
    }
  }

  async getChannel(queue, config) {
    await this.getConnection();
    return await this._channels.get(queue, config);
  }

  async getDefaultChannel() {
    await this.getConnection();
    return await this._channels.defaultChannel();
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

// Exposed for `instanceof` checks by consumers of the singleton (e.g. producer.js's
// reconnect-on-close listener) and for tests that need a Connection instance isolated from the
// process-wide singleton above.
module.exports.ConnectionClosedError = ConnectionClosedError;
module.exports.Connection = Connection;
