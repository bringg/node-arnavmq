declare class BaseHooks {
  /**
   * A map between an event name to a set of callbacks registered for it.
   * Function shape varies between different events.
   * @private
   */
  private _events: Map<string, Set<Function>>;
  /**
   * Registers a callback or array of callbacks to an event.
   * Callback function shape may vary according to the event type.
   * Upon a hook trigger, the callbacks for it will be invoked one by one, but without a particular order.
   * The user who registers the callback has the responsibility to handle any error inside of it. Throwing an error inside a callback will propagate it outside to the top level, aborting the process that triggered it.
   * @param {string} event The event name to register.
   * @param {(Function|Function[])} callback A callback or array of callbacks to register for the event.
   * @protected
   */
  protected _on(event: string, callback: Function | Function[]): void;
  /**
   * Registers a number of callbacks for an event.
   * @param {string} event The event name to register.
   * @param {Function|Function[]} callbacks A callback array register for the event.
   * @private
   */
  private _manyOn;
  /**
   * Unregister a callback or array of callbacks from an event.
   * Callbacks must be a reference to the same callbacks that registered.
   * @param {string} event The event to unregister.
   * @param {(Function|Function[])} callback A callback or array of callbacks to unregistered from the event.
   * @protected
   */
  protected _off(event: string, callback: Function | Function[]): void;
  /**
   * Unregister a number of callbacks from an event.
   * @param {string} event The event to unregister.
   * @param {Function[]} callbacks A callback array to unregistered from the event.
   * @private
   */
  private _manyOff;
  /**
   * Trigger an event, calling all callbacks registered to it with the given payload.
   * @param source The class/object that triggered the event. Will be bound as the 'this' argument of the callbacks.
   * @param eventName The name of the event to trigger.
   * @param payload The event to pass to the registered callbacks as an argument.
   * @public
   */
  public trigger(source: unknown, eventName: string, payload: unknown): Promise<void>;
  /** @private */
  private _getCallbacks;
}

export = BaseHooks;
