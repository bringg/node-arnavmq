import type amqp = require('amqplib');

interface ChannelConfig {
  prefetch: number;
}

declare class Channels {
  constructor(connection: amqp.Connection, config: ChannelConfig);
  private readonly _connection: amqp.Connection;
  private readonly _config: ChannelConfig;
  private readonly _channels: Map<string, { chann: Promise<amqp.Channel>; config: ChannelConfig }>;
  get(queue: string, config: ChannelConfig): Promise<amqp.Channel>;
  defaultChannel(): Promise<amqp.Channel>;
  /**
   * Creates or returns an existing channel by it's key and config.
   * @return {Promise} A promise that resolve with an amqp.node channel object
   */
  private _get(key: string, config?: ChannelConfig): Promise<amqp.Channel>;
  private _initNewChannel(key: string, config: ChannelConfig): Promise<amqp.Channel>;
}

declare class ChannelAlreadyExistsError extends Error {
  constructor(name: string, config: ChannelConfig);
  name: string;
  config: ChannelConfig;
}

declare namespace channels {
  export { Channels, ChannelAlreadyExistsError, ChannelConfig };
}

export = channels;
