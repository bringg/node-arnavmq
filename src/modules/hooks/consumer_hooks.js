const BaseHooks = require('./base_hooks');

class ConsumerHooks extends BaseHooks {
  /**
   * Registers callback/callbacks to be invoked before consumer starts processing a received message.
   * The callback is invoked with 'this' set to the consumer instance, and a single "payload" argument of the following shape:
   * - queue - The queue or exchange to publish to.
   * - message - The raw amqplib message.
   * - content - The deserialized message content.
   * The hook callback can return `false` in order to skip the message processing, rejecting it and jumping right to the "after process" hook.
   * @param {Function | Function[]} callback A callback or callbacks array to register.
   */
  beforeProcessMessage(callback) {
    this._on(ConsumerHooks.beforeProcessMessageEvent, callback);
  }

  /** Removes a callback or callback array from the hook. */
  removeBeforeProcessMessage(callback) {
    this._off(ConsumerHooks.beforeProcessMessageEvent, callback);
  }

  /**
   * Registers callback/callbacks to be invoked before consumer starts processing a received message.
   * The callback is invoked with 'this' set to the consumer instance, and a single "payload" argument of the following shape:
   * - queue - The queue or exchange to publish to.
   * - message - The raw amqplib message.
   * - content - The deserialized message content.
   * - error - The error object in case the processing callback threw.
   * - rejectError - The error object in case a failed rejecting the message after a processing error.
   * - ackError - The error in case failed to 'ack' the message after processing it.
   * @param {Function | Function[]} callback A callback or callbacks array to register.
   */
  afterProcessMessage(callback) {
    this._on(ConsumerHooks.afterProcessMessageEvent, callback);
  }

  /** Removes a callback or callback array from the hook. */
  removeAfterProcessMessage(callback) {
    this._off(ConsumerHooks.afterProcessMessageEvent, callback);
  }

  /**
   * Registers callback/callbacks to be invoked before consumer produces a reply to an RPC message.
   * The callback is invoked with 'this' set to the consumer instance, and a single "payload" argument of the following shape:
   * - receiveProperties - The properties of the original message we reply to.
   * - replyProperties - The properties added to the reply message.
   * - queue - The queue that the original message was consumed from.
   * - reply - The value to send back, before serialization. Returned from the "subscribe" callback.
   * - serializedReply - The serialized reply buffer.
   * - error - The error in case of returning an error reply.
   * @param {Function | Function[]} callback A callback or callbacks array to register.
   */
  beforeRpcReply(callback) {
    this._on(ConsumerHooks.beforeRpcReplyEvent, callback);
  }

  /** Removes a callback or callback array from the hook. */
  removeBeforeRpcReply(callback) {
    this._off(ConsumerHooks.beforeRpcReplyEvent, callback);
  }

  /**
   * Registers callback/callbacks to be invoked before consumer produces a reply to an RPC message.
   * The callback is invoked with 'this' set to the consumer instance, and a single "payload" argument of the following shape:
   * - receiveProperties - The properties of the original message we reply to.
   * - replyProperties - The properties added to the reply message.
   * - queue - The queue that the original message was consumed from.
   * - reply - The value to send back, before serialization. Returned from the "subscribe" callback.
   * - serializedReply - The serialized reply buffer.
   * - error - The error in case we failed to sent the reply to the reply queue.
   * - written - The result of the underlying amqplib publish (boolean)
   * @param {Function | Function[]} callback A callback or callbacks array to register.
   */
  afterRpcReply(callback) {
    this._on(ConsumerHooks.afterRpcReplyEvent, callback);
  }

  /** Removes a callback or callback array from the hook. */
  removeAfterRpcReply(callback) {
    this._off(ConsumerHooks.afterRpcReplyEvent, callback);
  }
}

ConsumerHooks.beforeProcessMessageEvent = 'consumer.beforeProcessMessage';
ConsumerHooks.afterProcessMessageEvent = 'consumer.afterProcessMessageEvent';
ConsumerHooks.beforeRpcReplyEvent = 'consumer.beforeRpcReply';
ConsumerHooks.afterRpcReplyEvent = 'consumer.afterRpcReply';

module.exports = ConsumerHooks;
