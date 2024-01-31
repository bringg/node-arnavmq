module.exports = class BaseHooks {
  constructor() {
    this._events = {};
  }

  _on(event, callback) {
    if (Array.isArray(callback)) {
      this._manyOn(event, callback);
      return;
    }

    if (!this._events[event]) {
      this._events[event] = new Set();
    }
    this._events[event].add(callback);
  }

  _manyOn(event, callbacks) {
    if (!this._events[event]) {
      this._events[event] = new Set();
    }
    callbacks.forEach((callback) => this._events[event].add(callback));
  }

  _off(event, callback) {
    if (Array.isArray(callback)) {
      this._manyOff(event, callback);
      return;
    }

    if (!this._events[event]) {
      return;
    }
    this._events[event].delete(callback);
  }

  _manyOff(event, callbacks) {
    if (!this._events[event]) {
      return;
    }
    callbacks.forEach((callback) => this._events[event].delete(callback));
  }

  async trigger(source, eventName, payload) {
    if (!this._events[eventName]) {
      return;
    }

    // This rule intends to restrict it for arrays, but this is a Set which doesn't have a '.map' function to use instead.
    // eslint-disable-next-line no-restricted-syntax
    for (const callback of this._events[eventName]) {
      await callback.call(source, payload);
    }
  }
};
