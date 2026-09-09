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
  /** Count of handlers currently running, not yet acked/rejected. */
  inFlightCount: number;
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
   * @return Resolves `true` once the broker has confirmed the consumer (basic.consume-ok), or
   *   `false` if the subscription was cancelled before that. Failures that may still clear - the
   *   channel cannot be opened, the queue cannot be declared as asked - are retried behind
   *   `config.timeout` rather than resolved, so this stays pending while a queue is undeclarable
   *   and never reports success for a subscription that is not consuming.
   * @throws ConnectionClosedError if the connection has already been closed - shutdown is terminal.
   */
  consume(queue: string, options: ConsumeOptions, callback: ConsumeCallback): Promise<boolean>;
  /**
   * Create a durable queue on RabbitMQ and consumes messages from it - executing a callback function.
   * Automatically answers with the callback response (can be a Promise)
   * @param queue    The RabbitMQ queue name
   * @param callback Callback function executed when a message is received on the queue name, can return a promise
   * @return See the three-argument overload.
   * @throws ConnectionClosedError if the connection has already been closed - shutdown is terminal.
   */
  consume(queue: string, callback: ConsumeCallback): Promise<boolean>;

  /** @see Consumer.consume */
  subscribe(queue: string, options: ConsumeOptions, callback: ConsumeCallback): Promise<boolean>;
  /** @see Consumer.consume */
  subscribe(queue: string, callback: ConsumeCallback): Promise<boolean>;

  /**
   * Count of currently in-flight messages across every subscription (handler running, not yet
   * acked/rejected).
   */
  inFlight(): number;

  /**
   * Resolves once every in-flight message handler has finished (inFlight() reaches 0). Cancels
   * nothing - pair with `stop()`. No timeout: a handler that never finishes means this never
   * resolves.
   */
  private _drain(): Promise<void>;
  /**
   * Cancels every subscription across every queue, then _drain()s. Idempotent - repeated/concurrent
   * calls share the one in-flight shutdown promise. Internal - not part of the object arnavmq.js's
   * factory returns publicly; call `close()` on the top-level module instead.
   * @return Resolves once every in-flight handler has finished.
   */
  private stop(): Promise<void>;
  private _cancelAll(): Promise<void>;
  private _initializeChannel(subscription: Subscription): Promise<amqp.Channel>;
  private _consumeQueue(channel: amqp.Channel, subscription: Subscription): Promise<boolean>;
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
  export { ConsumeOptions, ConsumeCallback, Subscription };
}

export = Consumer;
