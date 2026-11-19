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
  /**
   * When true, will produce the request with RPC settings, waiting for the response through RabbitMQ Direct Reply-to after sending the message, and finally returning it.
   * `replyTo` is set to `amq.rabbitmq.reply-to`. A caller-supplied `correlationId` must be unique among the process's pending RPC requests; a duplicate is rejected.
   */
  rpc?: boolean;
  /** Timeout in milliseconds for producing RPC request and waiting for the response, including setting up the reply consumer. Does not affect non-rpc requests. */
  timeout?: number;
}

declare class Producer {
  constructor(connection: Connection);
  hooks: ProducerHooks;
  /** Pending RPC requests by correlation ID, across every target queue. */
  private readonly _rpcRequests: Map<string, pDefer.DeferredPromise<unknown>>;
  /** The Direct Reply-to consumer on the default channel, once the first RPC on it set it up. */
  private _replyConsumer: { channel: amqp.Channel; ready: Promise<void> } | null;
  private _connection: Connection;
  private set connection(value: Connection);
  get connection(): Connection;
  /**
   * Produces a message to a queue through the default exchange, or publishes to the given exchange if the options have a `routingKey`, using it for the queue name.
   * @param queue The queue to send or exchange to publish to.
   * @param msg The message to publish
   * @param options The publish options
   */
  private publishOrSendToQueue(queue: string, msg: Buffer, options: ProduceOptions): Promise<boolean>;
  /**
   * Send message with or without rpc protocol
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
  /** The default channel, with the Direct Reply-to consumer set up on it. Internal. */
  private _getReplyChannel(): Promise<amqp.Channel>;
  /** Consumes Direct Reply-to replies on `channel`, and rejects pending requests once it closes. Internal. */
  private _consumeReplies(channel: amqp.Channel): Promise<void>;
  /** Delivery callback of the Direct Reply-to consumer; ignores `null` (a broker cancel). Internal. */
  private _onReply(msg: amqp.Message | null): void;
  /**
   * `promise`, rejected with the RPC timeout error if `deadline` (epoch ms; `null` = no limit) passes
   * first. Internal.
   */
  private _beforeDeadline<T>(promise: Promise<T>, deadline: number | null): Promise<T>;
  /**
   * Publishes `msg` on `channel`, through the default exchange or to `queue` as an exchange with
   * `options.routingKey`. Internal.
   */
  private _publishOn(channel: amqp.Channel, queue: string, msg: Buffer, options: ProduceOptions): boolean;
  /**
   * Rejects every pending RPC request with `ConnectionClosedError`. The rejection's `origin`
   * ('shutdown' vs 'unexpected') tells a deliberate `close()` from a lost connection. Internal.
   */
  private _discardRequests(): void;
}

declare namespace Producer {
  export { ProduceOptions, ProducerError };
}

export = Producer;
