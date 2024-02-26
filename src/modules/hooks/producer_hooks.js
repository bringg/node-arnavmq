const BaseHooks = require('./base_hooks');

class ProducerHooks extends BaseHooks {
  /**
   * Registers callback/callbacks to be invoked before producer publishes a message.
   * The callback is invoked with 'this' set to the producer instance, and a single "payload" argument of the following shape:
   * - queue - The queue or exchange to publish to.
   * - message - The message send, before serialization.
   * - parsedMessage - The serialized message buffer
   * - properties - The publish properties and options. If a "routingKey" is specified, it serves as the queue while the "queue" option represents the exchange instead. Otherwise the default exchange is used.
   * - currentRetry - The current retry attempt number
   * The hook callback can return `false` in order to cancel publication and jump right to the "after publish" hook.
   * @param {Function | Function[]} callback A callback or callbacks array to register.
   */
  beforeProduce(callback) {
    this._on(ProducerHooks.beforeProduce, callback);
  }

  /** Removes a callback or callback array from the hook. */
  removeBeforeProduce(callback) {
    this._off(ProducerHooks.beforeProduce, callback);
  }

  /**
   * Registers callback/callbacks to be invoked after producer finished publishing a message.
   * The callback is invoked with 'this' set to the producer instance, and a single "payload" argument of the following shape:
   * - queue - The queue or exchange to publish to.
   * - message - The message send, before serialization.
   * - parsedMessage - The serialized message buffer
   * - properties - The publish properties and options. If a "routingKey" is specified, it serves as the queue while the "queue" option represents the exchange instead. Otherwise the default exchange is used.
   * - currentRetry - The current retry attempt number.
   * - result - The value return from publication. If rpc, will be the deserialized object.
   * - error - The error object in case the publication failed, or received an erroneous RPC response.
   * - shouldRetry - If received an error, 'true' if the publication will be retried (if retry configured).
   * In case the hook callback was called with an error, it can return `false` in order to abort any further publish retries (if retry is configured).
   * @param {Function | Function[]} callback A callback or callbacks array to register.
   */
  afterProduce(callback) {
    this._on(ProducerHooks.afterProduce, callback);
  }

  /** Removes a callback or callback array from the hook. */
  removeAfterProduce(callback) {
    this._off(ProducerHooks.afterProduce, callback);
  }
}

ProducerHooks.beforeProduce = 'producer.beforeProduce';
ProducerHooks.afterProduce = 'producer.afterProduce';

module.exports = ProducerHooks;
