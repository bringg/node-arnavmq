const BaseHooks = require('./base_hooks');

class ConnectionHooks extends BaseHooks {
  constructor(hooks) {
    super();

    if (!hooks) {
      return;
    }
    if (hooks.afterConnect) {
      this.afterConnect(hooks.afterConnect);
    }
    if (hooks.beforeConnect) {
      this.beforeConnect(hooks.beforeConnect);
    }
  }

  beforeConnect(callback) {
    return this._on(ConnectionHooks.afterConnectEvent, callback);
  }

  removeBeforeConnect(callback) {
    this._off(ConnectionHooks.afterConnectEvent, callback);
  }

  afterConnect(callback) {
    return this._on(ConnectionHooks.afterConnectEvent, callback);
  }

  removeAfterConnect(callback) {
    this._off(ConnectionHooks.afterConnectEvent, callback);
  }
}

ConnectionHooks.beforeConnectEvent = 'connection.beforeConnect';
ConnectionHooks.afterConnectEvent = 'connection.afterConnect';

module.exports = ConnectionHooks;
