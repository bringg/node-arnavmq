const BaseHooks = require('./base_hooks');

class ProducerHooks extends BaseHooks {
  constructor(hooks) {
    super();

    if (!hooks) {
      return;
    }
    if (hooks.beforePublish) {
      this.beforePublish(hooks.beforePublish);
    }
    if (hooks.afterPublish) {
      this.afterPublish(hooks.afterPublish);
    }
  }

  beforePublish(callback) {
    return this._on(ProducerHooks.beforePublish, callback);
  }

  removeBeforePublish(callback) {
    this._off(ProducerHooks.beforePublish, callback);
  }

  afterPublish(callback) {
    return this._on(ProducerHooks.afterPublish, callback);
  }

  removeAfterPublish(callback) {
    this._off(ProducerHooks.afterPublish, callback);
  }
}

ProducerHooks.beforePublish = 'producer.beforePublish';
ProducerHooks.afterPublish = 'producer.afterPublish';

module.exports = ProducerHooks;
