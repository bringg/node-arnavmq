import { Connection } from './connection';
import { ProducerHooks } from './hooks';
import type amqp = require('amqplib');
import pDefer = require('p-defer');

declare class ProducerError extends Error {
  constructor(error: { name: string; message: string });
}

interface ProduceOptions extends amqp.Options.Publish {
  /**
   * When provided, will publish instead of sending to queue, with the given `queue` parameter serving as the exchange and this as the routing key.
   * When sending to the default exchange, it is the same as not passing the option: `producer.produce('', "message", {routingKey:"my-queue"})` is the same as `producer.produce('my-queue', "message")`
   */
  routingKey?: string;
  /** When true, will produce the request with RPC settings, waiting for a response on a dedicated response queue after sending the message, and finally returning it. */
  rpc?: boolean;
  /** Timeout in milliseconds for setting up the reply queue, producing RPC request and waiting for the response. Does not affect non-rpc requests. */
  timeout?: number;
}

/** A pending RPC request. */
interface RpcWaiter {
  responsePromise: pDefer.DeferredPromise<unknown>;
  /** Armed once the request is published, when it has a timeout. */
  timeoutId: NodeJS.Timeout | null;
}

/** The reply queue's setup for one target queue. */
interface ReplyQueueSetup {
  /** The reply queue name, once it is declared and consumed. */
  name?: string;
  /** RPCs waiting for the setup to finish. */
  waiters: Set<pDefer.DeferredPromise<string | undefined>>;
}

/** Correlation ID -> waiter, plus the `replyQueue` setup (not a waiter). */
type RpcQueue = Record<string, RpcWaiter> & { replyQueue?: ReplyQueueSetup };

declare class Producer {
  constructor(connection: Connection);
  hooks: ProducerHooks;
  /**
   * Map of rpc queues
   *
   * [queue: string] -> [correlationId: string] -> {responsePromise, timeoutId}, plus the
   * `replyQueue` setup
   */
  private readonly amqpRPCQueues: Record<string, RpcQueue>;
  private _connection: Connection;
  private set connection(value: Connection);
  get connection(): Connection;
  /**
   * Get a function to execute on channel consumer incoming message is received
   * @param queue name of the queue where messages are SENT
   * @return function executed by an amqp.node channel consume callback method
   */
  private maybeAnswer(queue: string): (msg: amqp.Message) => void;
  /**
   * Create a RPC-ready queue. Every RPC to `queue` shares one setup; a caller that times out is
   * dropped from it.
   * @param  queue the queue name in which we send a RPC request
   * @param  timeout ms to wait; 0 (the default), or anything else but a positive number, waits as
   *   long as it takes
   * @return Resolves with the reply queue name once it's ready to receive messages, or
   *   undefined if the connection is closed. Rejects with the RPC timeout error when `timeout`
   *   elapses first.
   */
  private createRpcQueue(queue: string, timeout?: number): Promise<string | undefined>;
  /** Starts the reply-queue setup for `queue` and returns its record. */
  private _startReplyQueueSetup(queue: string): ReplyQueueSetup;
  /**
   * The reply-queue name for `sourceQueue` on the current connection:
   * `<sourceQueue>:<hostname>:<pid>:<connection id>:res`.
   */
  private _replyQueueName(sourceQueue: string): string;
  /**
   * Declare and consume the reply queue for `sourceQueue`, retrying every `config.timeout` ms until
   * it works or the connection is closed.
   * @return the reply queue name, or undefined if the connection is closed
   */
  private _initializeRpcQueue(sourceQueue: string): Promise<string | undefined>;
  /**
   * Produces a message to a queue through the default exchange, or publishes to the given exchange if the options have a `routingKey`, using it for the queue name.
   * @param queue The queue to send or exchange to publish to.
   * @param msg The message to publish
   * @param options The publish options
   */
  private publishOrSendToQueue(queue: string, msg: Buffer, options: ProduceOptions): Promise<boolean>;
  /**
   * Start a timer to reject the pending RPC call if no answer is received within the given timeout
   * @param queue  The queue where the RPC request was sent
   * @param corrId The RPC correlation ID
   * @param time The timeout in ms to wait for an answer before triggering the rejection
   * @return Nothing
   */
  private prepareTimeoutRpc(queue: string, corrId: string, time: number): void;
  /**
   * Send message with or without rpc protocol, and check if RPC queues are created
   * @param queue the queue to send `msg` on
   * @param msg string, object, number.. anything bufferable/serializable
   * @param options contain rpc property (if true, enable rpc for this message)
   * @return When `options.rpc` is true, resolves with the parsed RPC response body once it
   *   arrives; otherwise resolves with whether the message was sent.
   */
  private checkRpc(queue: string, msg: Buffer, options: ProduceOptions): Promise<boolean | unknown>;
  /**
   * @deprecated Use publish instead
   * Ensure channel exists and send message using `checkRpc`
   * @param queue The destination queue on which we want to send a message
   * @param msg Anything serializable/bufferable
   * @param options message options (persistent, durable, rpc, etc.)
   * @return checkRpc response
   */
  produce(queue: string, msg: unknown, options: ProduceOptions): Promise<unknown>;
  /** @see Producer.produce */
  publish(queue: string, msg: unknown, options: ProduceOptions): Promise<unknown>;

  private _sendToQueue(
    queue: string,
    message: unknown,
    settings: ProduceOptions,
    currentRetryNumber: number,
  ): Promise<unknown>;

  private _shouldRetry(error: Error | ProducerError, currentRetryNumber: number): boolean;
  /**
   * Default channel 'close' listener. Rejects every RPC request still pending in `amqpRPCQueues`
   * with `ConnectionClosedError` and clears its timeout, then drops the registry so the next RPC
   * publish sets the reply queue up again. Fires on a deliberate `close()`, on a connection lost
   * unexpectedly, and on the broker closing the channel - the rejection's `origin` ('shutdown' vs
   * 'unexpected') tells a `close()` apart from the rest. Internal.
   */
  private _onChannelClose(): void;
}

declare namespace Producer {
  export { ProduceOptions, ProducerError };
}

export = Producer;
