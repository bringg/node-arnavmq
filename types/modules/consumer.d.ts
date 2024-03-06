import { ChannelConfig } from './channels';
import { Connection } from './connection';
import { ConsumerHooks } from './hooks';
import type amqp = require('amqplib');

declare class Consumer {
  constructor(connection: Connection);
  hooks: ConsumerHooks;
  set connection(value: Connection);
  get connection(): Connection;
  /**
   * Sends the RPC reply to the response queue according to the message properties when required.
   * @param  messageProperties   An amqp.node message properties object, containing the rpc settings
   * @param  queue The initial queue on which the handler received the message
   * @param  reply the received message to reply the rpc if needed:
   * @return The message properties if it is not an rpc request, or a boolean indicating the produce result when an rpc response was produced.
   */
  checkRpc(
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
  consume(queue: string, options: ChannelConfig, callback: ConsumeCallback): Promise<any>;
}

type ConsumeCallback = (body: unknown, properties: amqp.MessageProperties) => Promise<unknown> | unknown;

export = Consumer;
