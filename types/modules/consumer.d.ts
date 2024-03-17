import { ChannelConfig } from './channels';
import { Connection } from './connection';
import { ConsumerHooks } from './hooks';
import type amqp = require('amqplib');

type ConsumeOptions = amqp.Options.AssertQueue & {
  channel: ChannelConfig;
};
type ConsumeCallback = (body: unknown, properties: amqp.MessageProperties) => Promise<unknown> | unknown;

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
  consume(queue: string, options: ConsumeOptions, callback: ConsumeCallback): Promise<true>;
  /**
   * Create a durable queue on RabbitMQ and consumes messages from it - executing a callback function.
   * Automatically answers with the callback response (can be a Promise)
   * @param queue    The RabbitMQ queue name
   * @param callback Callback function executed when a message is received on the queue name, can return a promise
   * @return A promise that resolves when connection is established and consumer is ready
   */
  consume(queue: string, callback: ConsumeCallback): Promise<true>;

  /** @see Consumer.consume */
  subscribe(queue: string, options: ConsumeOptions, callback: ConsumeCallback): Promise<true>;
  /** @see Consumer.consume */
  subscribe(queue: string, callback: ConsumeCallback): Promise<true>;

  private _initializeChannel(queue: string, options: ConsumeOptions, callback): Promise<amqp.Channel>;
  private _consumeQueue(channel: amqp.Channel, queue: string, callback: ConsumeCallback): Promise<void>;
  private _rejectMessageAfterProcess(
    channel: amqp.Channel,
    queue: string,
    msg: amqp.Message,
    parsedBody: unknown,
    requeue: boolean,
    error: Error,
  ): Promise<void>;
}

declare namespace Consumer {
  export { ConsumeOptions, ConsumeCallback };
}

export = Consumer;
