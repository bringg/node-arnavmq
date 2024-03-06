import Producer = require('../producer');
import BaseHooks = require('./base_hooks');
import type amqp = require('amqplib');

interface ProduceInfo {
  /** The queue or exchange to produce to */
  queue: string;
  /** The pre-serialized message to publish */
  message: unknown;
  /** The serialized message buffer */
  parsedMessage: Buffer;
  /**
   * The publish properties and options.
   * If a "routingKey" is specified, it serves as the queue while the "queue" option represents the exchange instead. Otherwise the default exchange is used.
   */
  properties: ProduceSettings;
  /** The current retry attempt number */
  currentRetry: number;
}

type ProduceResultInfo = ProduceInfo &
  (
    | {
        result: unknown;
        error: undefined;
      }
    | {
        error: Error;
        shouldRetry: boolean;
      }
  );
type AfterProduceHook = (this: Producer, e: ProduceResultInfo) => Promise<void>;
type BeforeProduceHook = (this: Producer, e: ProduceInfo) => Promise<void>;

type ProduceSettings = amqp.MessageProperties & {
  routingKey?: string;
  rpc?: boolean;
};

declare class ProducerHooks extends BaseHooks {
  /**
   * Registers callback/callbacks to be invoked before producer publishes a message.
   * The callback is invoked with 'this' set to the producer instance, and a single "payload" argument of the following shape:
   * - queue - The queue or exchange to publish to.
   * - message - The message send, before serialization.
   * - parsedMessage - The serialized message buffer
   * - properties - The publish properties and options. If a "routingKey" is specified, it serves as the queue while the "queue" option represents the exchange instead. Otherwise the default exchange is used.
   * - currentRetry - The current retry attempt number
   * The hook callback can return `false` in order to cancel publication and jump right to the "after publish" hook.
   * @param callback A callback or callbacks array to register.
   */
  beforeProduce(callback: BeforeProduceHook | BeforeProduceHook[]): void;
  /** Removes a callback or callback array from the hook. */
  removeBeforeProduce(callback: BeforeProduceHook | BeforeProduceHook[]): void;
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
   * @param callback A callback or callbacks array to register.
   */
  afterProduce(callback: AfterProduceHook | AfterProduceHook[]): void;
  /** Removes a callback or callback array from the hook. */
  removeAfterProduce(callback: AfterProduceHook | AfterProduceHook[]): void;
}

declare namespace ProducerHooks {
  export const beforeProduce: 'producer.beforeProduce';
  export const afterProduce: 'producer.afterProduce';

  export interface ProducerHooks extends BaseHooks {
    /**
     * Registers callback/callbacks to be invoked before producer publishes a message.
     * The callback is invoked with 'this' set to the producer instance, and a single "payload" argument of the following shape:
     * - queue - The queue or exchange to publish to.
     * - message - The message send, before serialization.
     * - parsedMessage - The serialized message buffer
     * - properties - The publish properties and options. If a "routingKey" is specified, it serves as the queue while the "queue" option represents the exchange instead. Otherwise the default exchange is used.
     * - currentRetry - The current retry attempt number
     * The hook callback can return `false` in order to cancel publication and jump right to the "after publish" hook.
     * @param callback A callback or callbacks array to register.
     */
    beforeProduce(callback: BeforeProduceHook | BeforeProduceHook[]): void;
    /** Removes a callback or callback array from the hook. */
    removeBeforeProduce(callback: BeforeProduceHook | BeforeProduceHook[]): void;
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
     * @param callback A callback or callbacks array to register.
     */
    afterProduce(callback: AfterProduceHook | AfterProduceHook[]): void;
    /** Removes a callback or callback array from the hook. */
    removeAfterProduce(callback: AfterProduceHook | AfterProduceHook[]): void;
  }

  export { ProduceInfo, ProduceResultInfo, AfterProduceHook, BeforeProduceHook, ProduceSettings };
}

export = ProducerHooks;
