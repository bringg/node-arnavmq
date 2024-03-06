import Consumer = require('../consumer');
import BaseHooks = require('./base_hooks');
import type amqp = require('amqplib');

type BeforeProcessHook = (this: Consumer, e: ConsumeInfo) => Promise<void>;

type AfterProcessHook = (this: Consumer, e: AfterConsumeInfo) => Promise<void>;

type BeforeRpcReplyHook = (this: Consumer, e: RpcInfo) => Promise<void>;

type AfterRpcHook = (this: Consumer, e: RpcResultInfo) => Promise<void>;

interface ConsumeInfo {
  /** The consumed queue */
  queue: string;
  action: {
    /** The raw amqplib message */
    message: amqp.Message;
    /** The deserialized message content */
    content: unknown;
    /** The callback to be executed with the message */
    callback: Function;
  };
}

interface RpcInfo {
  /** The properties of the original message we reply to */
  receiveProperties: amqp.MessageProperties;
  /** The properties added to the reply message */
  replyProperties: amqp.MessageProperties;
  /** The queue that the original message was consumed from */
  queue: string;
  /** The value to send back, before serialization. Returned from the "consume" callback. */
  reply: unknown;
  /** The serialized reply buffer */
  serializedReply: Buffer;
  /** The error in case of returning an error reply */
  error?: Error;
}

type RpcResultInfo = RpcInfo &
  (
    | {
        error: Error;
      }
    | {
        error: undefined;
        written: boolean;
      }
  );

type AfterConsumeInfo = {
  /** The raw amqplib message */
  message: amqp.Message;
  /** The deserialized message content */
  content: unknown;

  /** The error ocurred during the consume callback if available */
  error?: Error;
  /** An amqplib error in case of a failed message rejection in case of a reject action is made following a callback error */
  rejectError?: Error;
  /** An amqplib error in case of a failed message ack following a successful callback. */
  ackError?: Error;
};

declare class ConsumerHooks extends BaseHooks {
  /**
   * Registers callback/callbacks to be invoked before consumer starts processing a received message.
   * The callback is invoked with 'this' set to the consumer instance, and a single "payload" argument of the following shape:
   * - queue - The queue or exchange to publish to.
   * - message - The raw amqplib message.
   * - content - The deserialized message content.
   * The hook callback can return `false` in order to skip the message processing, rejecting it and jumping right to the "after process" hook.
   * @param callback A callback or callbacks array to register.
   */
  beforeProcessMessage(callback: BeforeProcessHook | BeforeProcessHook[]): void;
  /** Removes a callback or callback array from the hook. */
  removeBeforeProcessMessage(callback: BeforeProcessHook | BeforeProcessHook[]): void;
  /**
   * Registers callback/callbacks to be invoked before consumer starts processing a received message.
   * The callback is invoked with 'this' set to the consumer instance, and a single "payload" argument of the following shape:
   * - queue - The queue or exchange to publish to.
   * - message - The raw amqplib message.
   * - content - The deserialized message content.
   * - error - The error object in case the processing callback threw.
   * - rejectError - The error object in case a failed rejecting the message after a processing error.
   * - ackError - The error in case failed to 'ack' the message after processing it.
   * @param callback A callback or callbacks array to register.
   */
  afterProcessMessage(callback: AfterProcessHook | AfterProcessHook[]): void;
  /** Removes a callback or callback array from the hook. */
  removeAfterProcessMessage(callback: AfterProcessHook | AfterProcessHook[]): void;
  /**
   * Registers callback/callbacks to be invoked before consumer produces a reply to an RPC message.
   * The callback is invoked with 'this' set to the consumer instance, and a single "payload" argument of the following shape:
   * - receiveProperties - The properties of the original message we reply to.
   * - replyProperties - The properties added to the reply message.
   * - queue - The queue that the original message was consumed from.
   * - reply - The value to send back, before serialization. Returned from the "subscribe" callback.
   * - serializedReply - The serialized reply buffer.
   * - error - The error in case of returning an error reply.
   * @param callback A callback or callbacks array to register.
   */
  beforeRpcReply(callback: BeforeRpcReplyHook | BeforeRpcReplyHook[]): void;
  /** Removes a callback or callback array from the hook. */
  removeBeforeRpcReply(callback: BeforeRpcReplyHook | BeforeRpcReplyHook[]): void;
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
   * @param callback A callback or callbacks array to register.
   */
  afterRpcReply(callback: AfterRpcHook | AfterRpcHook[]): void;
  /** Removes a callback or callback array from the hook. */
  removeAfterRpcReply(callback: AfterRpcHook | AfterRpcHook[]): void;
}
declare namespace ConsumerHooks {
  export const beforeProcessMessageEvent: 'consumer.beforeProcessMessage';
  export const afterProcessMessageEvent: 'consumer.afterProcessMessageEvent';
  export const beforeRpcReplyEvent: 'consumer.beforeRpcReply';
  export const afterRpcReplyEvent: 'consumer.afterRpcReply';

  export interface ConsumerHooks extends BaseHooks {
    /**
     * Registers callback/callbacks to be invoked before consumer starts processing a received message.
     * The callback is invoked with 'this' set to the consumer instance, and a single "payload" argument of the following shape:
     * - queue - The queue or exchange to publish to.
     * - message - The raw amqplib message.
     * - content - The deserialized message content.
     * The hook callback can return `false` in order to skip the message processing, rejecting it and jumping right to the "after process" hook.
     * @param callback A callback or callbacks array to register.
     */
    beforeProcessMessage(callback: BeforeProcessHook | BeforeProcessHook[]): void;
    /** Removes a callback or callback array from the hook. */
    removeBeforeProcessMessage(callback: BeforeProcessHook | BeforeProcessHook[]): void;
    /**
     * Registers callback/callbacks to be invoked before consumer starts processing a received message.
     * The callback is invoked with 'this' set to the consumer instance, and a single "payload" argument of the following shape:
     * - queue - The queue or exchange to publish to.
     * - message - The raw amqplib message.
     * - content - The deserialized message content.
     * - error - The error object in case the processing callback threw.
     * - rejectError - The error object in case a failed rejecting the message after a processing error.
     * - ackError - The error in case failed to 'ack' the message after processing it.
     * @param callback A callback or callbacks array to register.
     */
    afterProcessMessage(callback: AfterProcessHook | AfterProcessHook[]): void;
    /** Removes a callback or callback array from the hook. */
    removeAfterProcessMessage(callback: AfterProcessHook | AfterProcessHook[]): void;
    /**
     * Registers callback/callbacks to be invoked before consumer produces a reply to an RPC message.
     * The callback is invoked with 'this' set to the consumer instance, and a single "payload" argument of the following shape:
     * - receiveProperties - The properties of the original message we reply to.
     * - replyProperties - The properties added to the reply message.
     * - queue - The queue that the original message was consumed from.
     * - reply - The value to send back, before serialization. Returned from the "subscribe" callback.
     * - serializedReply - The serialized reply buffer.
     * - error - The error in case of returning an error reply.
     * @param callback A callback or callbacks array to register.
     */
    beforeRpcReply(callback: BeforeRpcReplyHook | BeforeRpcReplyHook[]): void;
    /** Removes a callback or callback array from the hook. */
    removeBeforeRpcReply(callback: BeforeRpcReplyHook | BeforeRpcReplyHook[]): void;
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
     * @param callback A callback or callbacks array to register.
     */
    afterRpcReply(callback: AfterRpcHook | AfterRpcHook[]): void;
    /** Removes a callback or callback array from the hook. */
    removeAfterRpcReply(callback: AfterRpcHook | AfterRpcHook[]): void;
  }

  export {
    BeforeProcessHook,
    AfterProcessHook,
    BeforeRpcReplyHook,
    AfterRpcHook,
    ConsumeInfo,
    RpcInfo,
    RpcResultInfo,
    AfterConsumeInfo,
  };
}

export = ConsumerHooks;
