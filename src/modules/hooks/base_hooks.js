const { logger } = require('../logger');

async function runHook(source, eventName, payload, callback) {
  const logParams = { hook: eventName, payload, callbackName: callback.name };
  try {
    await callback.call(source, payload);
    logger.debug({
      message: `arnav_mq:hooks A '${eventName}' finished execution.`,
      params: logParams,
    });
  } catch (error) {
    logger.error({
      message: `arnav_mq:hooks Execution of '${eventName}' hook caused an error: ${error.message}`,
      error,
      params: logParams,
    });
  }

  return true;
}

module.exports = class BaseHooks {
  constructor() {
    /**
     * @type {Map.<string, Set.<Function>>} A map between an event name to a set of callbacks registered for it.
     * Function shape varies between different events.
     * @private
     */
    this._events = new Map();
  }

  /**
   * Registers a callback or array of callbacks to an event.
   * Callback function shape may vary according to the event type.
   * Upon a hook trigger, the callbacks for it will be invoked one by one, but without a particular order.
   * The user who registers the callback has the responsibility to handle any error inside of it. Throwing an error inside a callback will propagate it outside to the top level, aborting the process that triggered it.
   * @param {string} event The event name to register.
   * @param {(Function|Function[])} callback A callback or array of callbacks to register for the event.
   * @protected
   */
  _on(event, callback) {
    if (Array.isArray(callback)) {
      this._manyOn(event, callback);
      return;
    }

    this._getCallbacks(event).add(callback);
  }

  /**
   * Registers a number of callbacks for an event.
   * @param {string} event The event name to register.
   * @param {Function|Function[]} callbacks A callback array register for the event.
   * @private
   */
  _manyOn(event, callbacks) {
    const registered = this._getCallbacks(event);
    callbacks.forEach((callback) => registered.add(callback));
  }

  /**
   * Unregister a callback or array of callbacks from an event.
   * Callbacks must be a reference to the same callbacks that registered.
   * @param {string} event The event to unregister.
   * @param {(Function|Function[])} callback A callback or array of callbacks to unregistered from the event.
   * @protected
   */
  _off(event, callback) {
    if (Array.isArray(callback)) {
      this._manyOff(event, callback);
      return;
    }

    this._getCallbacks(event).delete(callback);
  }

  /**
   * Unregister a number of callbacks from an event.
   * @param {string} event The event to unregister.
   * @param {Function[]} callbacks A callback array to unregistered from the event.
   * @private
   */
  _manyOff(event, callbacks) {
    const registered = this._getCallbacks(event);
    if (!registered.size) {
      return;
    }
    callbacks.forEach((callback) => registered.delete(callback));
  }

  /**
   * Trigger an event, calling all callbacks registered to it with the given payload.
   * @param {*} source The class/object that triggered the event. Will be bound as the 'this' argument of the callbacks.
   * @param {string} eventName The name of the event to trigger.
   * @param {*} payload The event to pass to the registered callbacks as an argument.
   * @public
   */
  async trigger(source, eventName, payload) {
    const callbacks = this._getCallbacks(eventName);
    if (!callbacks.size) {
      return;
    }

    const hookPromises = [];
    // This rule intends to restrict it for arrays, but this is a Set which doesn't have a '.map' function to use instead.
    // eslint-disable-next-line no-restricted-syntax
    for (const callback of callbacks) {
      hookPromises.push(runHook(source, eventName, payload, callback));
    }
    await Promise.all(hookPromises);
  }

  /** @private */
  _getCallbacks(event) {
    let callbacks = this._events.get(event);
    if (!callbacks) {
      callbacks = new Set();
      this._events.set(event, callbacks);
    }
    return callbacks;
  }
};
