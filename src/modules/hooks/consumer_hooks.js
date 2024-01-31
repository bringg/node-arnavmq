const BaseHooks = require('./base_hooks');

class ConsumerHooks extends BaseHooks {
  constructor(hooks) {
    super();

    if (!hooks) {
      return;
    }
    if (hooks.beforeProcessMessage) {
      this.beforeProcessMessage(hooks.beforeProcessMessage);
    }
    if (hooks.afterProcessMessage) {
      this.afterProcessMessage(hooks.afterProcessMessage);
    }
    if (hooks.beforeRpcReply) {
      this.beforeRpcReply(hooks.beforeRpcReply);
    }
    if (hooks.afterRpcReply) {
      this.afterRpcReply(hooks.afterRpcReply);
    }
  }

  beforeProcessMessage(callback) {
    return this._on(ConsumerHooks.beforeProcessMessageEvent, callback);
  }

  removeBeforeProcessMessage(callback) {
    this._off(ConsumerHooks.beforeProcessMessageEvent, callback);
  }

  afterProcessMessage(callback) {
    return this._on(ConsumerHooks.afterProcessMessageEvent, callback);
  }

  removeAfterProcessMessage(callback) {
    this._off(ConsumerHooks.afterProcessMessageEvent, callback);
  }

  beforeRpcReply(callback) {
    return this._on(ConsumerHooks.beforeRpcReplyEvent, callback);
  }

  removeBeforeRpcReply(callback) {
    this._off(ConsumerHooks.beforeRpcReplyEvent, callback);
  }

  afterRpcReply(callback) {
    return this._on(ConsumerHooks.afterRpcReplyEvent, callback);
  }

  removeAfterRpcReply(callback) {
    this._off(ConsumerHooks.afterRpcReplyEvent, callback);
  }
}

ConsumerHooks.beforeProcessMessageEvent = 'consumer.beforeProcessMessage';
ConsumerHooks.afterProcessMessageEvent = 'consumer.afterProcessMessageEvent';
ConsumerHooks.beforeRpcReplyEvent = 'consumer.beforeRpcReply';
ConsumerHooks.afterRpcReplyEvent = 'consumer.afterRpcReply';

module.exports = ConsumerHooks;
