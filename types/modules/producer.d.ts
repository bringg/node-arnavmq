import { Connection } from './connection';
import { ProducerHooks } from './hooks';
import type amqp = require('amqplib');
import pDefer = require('p-defer');

declare class Producer {
  constructor(connection: any);
  hooks: ProducerHooks;
  /**
   * Map of rpc queues
   *
   * [queue: string] -> [correlationId: string] -> {responsePromise, timeoutId}
   */
  amqpRPCQueues: Record<
    string,
    Record<string, { responsePromise: pDefer.DeferredPromise<unknown>; timeoutId: NodeJS.Timeout }>
  >;
  set connection(value: Connection);
  get connection(): Connection;
  /**
   * Get a function to execute on channel consumer incoming message is received
   * @param queue name of the queue where messages are SENT
   * @return function executed by an amqp.node channel consume callback method
   */
  maybeAnswer(queue: string): (msg: amqp.Message) => void;
  /**
   * Create a RPC-ready queue
   * @param  queue the queue name in which we send a RPC request
   * @return Resolves with the the response queue name when the answer response queue is ready to receive messages
   */
  createRpcQueue(queue: string): Promise<string>;
  /**
   * Produces a message to a queue through the default exchange, or publishes to the given exchange if the options have a `routingKey`, using it for the queue name.
   * @param queue The queue to send or exchange to publish to.
   * @param msg The message to publish
   * @param options The publish options
   */
  publishOrSendToQueue(queue: string, msg: Buffer, options: PublishOptions): Promise<any>;
  /**
   * Start a timer to reject the pending RPC call if no answer is received within the given timeout
   * @param queue  The queue where the RPC request was sent
   * @param corrId The RPC correlation ID
   * @param time The timeout in ms to wait for an answer before triggering the rejection
   * @return Nothing
   */
  prepareTimeoutRpc(queue: string, corrId: string, time: number): void;
  /**
   * Send message with or without rpc protocol, and check if RPC queues are created
   * @param queue the queue to send `msg` on
   * @param msg string, object, number.. anything bufferable/serializable
   * @param options contain rpc property (if true, enable rpc for this message)
   * @return Resolves when message is correctly sent, or when response is received when rpc is enabled
   */
  checkRpc(queue: string, msg: Buffer, options: PublishOptions): Promise<boolean>;
  /**
   * @deprecated Use publish instead
   * Ensure channel exists and send message using `checkRpc`
   * @param queue The destination queue on which we want to send a message
   * @param msg Anything serializable/bufferable
   * @param options message options (persistent, durable, rpc, etc.)
   * @return checkRpc response
   */
  produce(queue: string, msg: unknown, options: PublishOptions): Promise<boolean>;
  /**
   * Ensure channel exists and send message using `checkRpc`
   * @param queue The destination queue on which we want to send a message
   * @param msg Anything serializable/bufferable
   * @param options message options (persistent, durable, rpc, etc.)
   * @return checkRpc response
   */
  publish(queue: string, msg: unknown, options: PublishOptions): Promise<any>;
}

interface PublishOptions extends amqp.Options.Publish {
  routingKey?: string;
  rpc?: boolean;
}

export = Producer;
