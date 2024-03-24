import { AmqpChannel, AmqpConnection } from './amqp';

interface ChannelConfig {
  prefetch: number;
}

declare class Channels {
  constructor(connection: AmqpConnection, config: ChannelConfig);
  private readonly _connection: AmqpConnection;
  private readonly _config: ChannelConfig;
  private readonly _channels: Map<string, { chann: Promise<AmqpChannel>; config: ChannelConfig }>;
  get(queue: string, config: ChannelConfig): Promise<AmqpChannel>;
  defaultChannel(): Promise<AmqpChannel>;
  /**
   * Creates or returns an existing channel by it's key and config.
   * @return {Promise} A promise that resolve with an amqp.node channel object
   */
  private _get(key: string, config?: ChannelConfig): Promise<AmqpChannel>;
  private _initNewChannel(key: string, config: ChannelConfig): Promise<AmqpChannel>;
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
