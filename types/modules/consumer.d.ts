import { ChannelConfig } from './channels';
import { Connection } from './connection';
import { ConsumerHooks } from './hooks';
import type amqp = require('amqplib');

type ConsumeOptions = amqp.Options.AssertQueue & {
  channel: ChannelConfig;
};
type ConsumeCallback = (body: unknown, properties: amqp.MessageProperties) => Promise<unknown> | unknown;
/** One consume()/subscribe() registration and its live state, tracked for resubscribe/shutdown. */
type Subscription = {
  queue: string;
  options: ConsumeOptions;
  callback: ConsumeCallback;
  channel: amqp.Channel | null;
  consumerTag: string | null;
  onChannelClose: (() => void) | null;
  /** Set by `_cancelSubscription()`; once true this subscription never (re)subscribes again. */
  cancelled: boolean;
  /** Messages whose handler is currently running. */
  inFlightMessages: Set<amqp.Message>;
  /** Messages requeued by `stop()`'s timeout path; a per-delivery guard against double ack/reject/RPC-reply. */
  abandonedMessages: Set<amqp.Message>;
};
/** The outcome of a `stop()` (and, through it, of `arnavmq.close()`). */
type StopResult = {
  /** true if every in-flight handler finished inside the drain budget, false if messages were abandoned. */
  drained: boolean;
  /**
   * Queue name -> how many in-flight messages were abandoned (rejected+requeued) on it. Empty on a
   * clean drain. Intended for an abandoned-message shutdown metric.
   */
  abandoned: Record<string, number>;
};

declare class Consumer {
  constructor(connection: Connection);
  hooks: ConsumerHooks;
  private set connection(value: Connection);
  get connection(): Connection;
  /**
   * Sends the RPC reply to the response queue according to the message properties when required.
   * @param  messageProperties   An amqp.node message properties object, containing the rpc settings
   * @param  queue The initial queue on which the handler received the message
   * @param  reply the received message to reply the rpc if needed:
   * @return The message properties if it is not an rpc request, or a boolean indicating the produce result when an rpc response was produced.
   */
  private checkRpc(
    messageProperties: amqp.MessageProperties,
    queue: string,
    reply: unknown,
  ): Promise<boolean | amqp.MessageProperties>;
  /**
   * Create a durable queue on RabbitMQ and consumes messages from it - executing a callback function.
   * Automatically answers with the callback response (can be a Promise)
   * @param queue    The RabbitMQ queue name
   * @param options  (Optional) Options for the queue (durable, persistent, etc.) and channel (with prefetch, `{ channel: { prefetch: 100 } }`)
   * @param callback Callback function executed when a message is received on the queue name, can return a promise
   * @return A promise that resolves when connection is established and consumer is ready
   */
  consume(queue: string, options: ConsumeOptions, callback: ConsumeCallback): Promise<boolean>;
  /**
   * Create a durable queue on RabbitMQ and consumes messages from it - executing a callback function.
   * Automatically answers with the callback response (can be a Promise)
   * @param queue    The RabbitMQ queue name
   * @param callback Callback function executed when a message is received on the queue name, can return a promise
   * @return A promise that resolves when connection is established and consumer is ready
   */
  consume(queue: string, callback: ConsumeCallback): Promise<boolean>;

  /** @see Consumer.consume */
  subscribe(queue: string, options: ConsumeOptions, callback: ConsumeCallback): Promise<boolean>;
  /** @see Consumer.consume */
  subscribe(queue: string, callback: ConsumeCallback): Promise<boolean>;

  /**
   * basic.cancel by consumerTag for every subscription on `queue`. Does NOT close the channel (it
   * is shared with other consumers and with RPC replies) and does NOT wait for in-flight handlers
   * - use `drain()`/`stop()` for that. Cancelled subscriptions are never resubscribed.
   * @param queue The queue to stop consuming from.
   * @return Resolves once every subscription on `queue` has been cancelled.
   */
  cancel(queue: string): Promise<void>;
  /**
   * cancel()s every subscription across every queue, and marks this consumer as shutting down so
   * no subscription resubscribes/retries afterward.
   * @return Resolves once every subscription has been cancelled.
   */
  cancelAll(): Promise<void>;
  /**
   * Resolves true once every in-flight message handler has finished (inFlight() reaches 0), or
   * false if `timeoutMs` elapses first. Cancels nothing - pair with `cancel()`/`cancelAll()`.
   * @param timeoutMs How long to wait for in-flight handlers to finish. Defaults to 30s.
   * @return true if drained before the timeout, false otherwise.
   */
  drain(timeoutMs?: number): Promise<boolean>;
  /**
   * cancelAll(), then drain(options.timeout). Idempotent - repeated/concurrent calls share the one
   * in-flight shutdown promise. If drain() times out, every message still in-flight is rejected
   * with requeue=true and marked as abandoned, so the still-running handler's eventual
   * ack/reject/RPC-reply for it becomes a no-op.
   * @param options
   * @param options.timeout Passed through to drain(). Defaults to 30s.
   * @return The drain outcome: whether it drained cleanly, and how many messages were abandoned per queue.
   */
  stop(options?: { timeout?: number }): Promise<StopResult>;
  /**
   * Count of currently in-flight messages (handler running, not yet acked/rejected).
   * @param queue When given, count only subscriptions on this queue; otherwise every subscription.
   */
  inFlight(queue?: string): number;

  private _initializeChannel(subscription: Subscription): Promise<amqp.Channel>;
  private _consumeQueue(channel: amqp.Channel, subscription: Subscription): Promise<void>;
  private _rejectMessageAfterProcess(
    channel: amqp.Channel,
    subscription: Subscription,
    msg: amqp.Message,
    parsedBody: unknown,
    requeue: boolean,
    error: Error,
  ): Promise<void>;
}

declare namespace Consumer {
  export { ConsumeOptions, ConsumeCallback, StopResult, Subscription };
}

export = Consumer;
