import type amqp = require('amqplib');

interface ChannelConfig {
  prefetch: number;
}

declare class Channels {
  constructor(connection: amqp.Connection, config: ChannelConfig);
  _connection: any;
  _config: any;
  _channels: Map<any, any>;
  get(queue: any, config: any): Promise<any>;
  defaultChannel(): Promise<any>;
  /**
   * Creates or returns an existing channel by it's key and config.
   * @return {Promise} A promise that resolve with an amqp.node channel object
   */
  _get(key: any, config?: {}): Promise<any>;
  _initNewChannel(key: any, config: any): Promise<any>;
}

declare class ChannelAlreadyExistsError extends Error {
  constructor(name: any, config: any);
  name: any;
  config: any;
}

declare namespace channels {
  export { Channels, ChannelAlreadyExistsError, ChannelConfig };
}

export = channels;
