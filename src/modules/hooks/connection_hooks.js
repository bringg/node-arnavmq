const BaseHooks = require('./base_hooks');

class ConnectionHooks extends BaseHooks {
  /**
   * Registers callback/callbacks to be invoked before creating a connection to rabbitmq.
   * The callback is invoked with 'this' set to the connection wrapper instance creating the connection, and a single "payload" argument of the following shape:
   * - config - The configuration object used for connecting.
   * @param {Function | Function[]} callback A callback or callbacks array to register.
   */
  beforeConnect(callback) {
    return this._on(ConnectionHooks.afterConnectEvent, callback);
  }

  /** Removes a callback or callback array from the hook. */
  removeBeforeConnect(callback) {
    this._off(ConnectionHooks.afterConnectEvent, callback);
  }

  /**
   * Registers callback/callbacks to be invoked before creating a connection to rabbitmq.
   * The callback is invoked with 'this' set to the connection wrapper instance creating the connection, and a single "payload" argument of the following shape:
   * - config - The configuration object used for connecting.
   * - connection - The created underlying amqplib connection.
   * - error - The error in case of connection failure.
   * @param {Function | Function[]} callback A callback or callbacks array to register.
   */
  afterConnect(callback) {
    return this._on(ConnectionHooks.afterConnectEvent, callback);
  }

  /** Removes a callback or callback array from the hook. */
  removeAfterConnect(callback) {
    this._off(ConnectionHooks.afterConnectEvent, callback);
  }
}

ConnectionHooks.beforeConnectEvent = 'connection.beforeConnect';
ConnectionHooks.afterConnectEvent = 'connection.afterConnect';

module.exports = ConnectionHooks;
