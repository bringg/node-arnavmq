import amqp = require('amqplib');
import channels = require('./channels');
import { Logger } from './logger';
import { ConnectionHooks } from './hooks/connection_hooks';

interface ConnectionConfig {
  /**
   * amqp connection string
   * @default 'amqp://localhost'
   */
  host?: string;

  /**
   * number of fetched messages at once on the channel
   * @default 5
   */
  prefetch?: number;

  /**
   * requeue put back message into the broker if consumer crashes/trigger exception
   * @default true
   */
  requeue?: boolean;

  /**
   * time between two reconnect (ms)
   * @default 1000
   */
  timeout?: number;

  /**
   * the maximum number of retries when trying to send a message before throwing error when failing. If set to '0' will not retry. If set to less then '0', will retry indefinitely.
   * @default -1
   */
  producerMaxRetries?: number;

  /**
   * default timeout for RPC calls. If set to '0' there will be none
   * @default 15000
   */
  rpcTimeout?: number;

  /**
   * Suffix all queues names. Defaults to empty string.
   * For example, a queue service-something with suffix :ci becomes service-something:ci etc.
   * @default ''
   */
  consumerSuffix?: string;

  /** generate a hostname so we can track this connection on the broker (rabbitmq management plugin) - defaults to host from environment or random uuid */
  hostname?: string;

  /** A logger object with a log function for each of the log levels ("debug", "info", "warn", or "error"). */
  logger?: Logger;
}

declare class Connection {
  constructor(config: ConnectionConfig);

  private _connectionPromise: Promise<amqp.Connection>;
  private _config: ConnectionConfig;
  public hooks: ConnectionHooks;

  get config(): ConnectionConfig;
  set config(value: ConnectionConfig);

  getConnection(): Promise<amqp.Connection>;
  getChannel(queue: string, config: channels.ChannelConfig): Promise<amqp.Channel>;
  getDefaultChannel(): Promise<amqp.Channel>;
  /**
   * Register an event on the default amqp.node channel
   * @param on the channel event name to be bound with
   * @param func the callback function to execute when the event is called
   */
  addListener(on: string, func: Function): Promise<void>;

  private _connect(): Promise<amqp.Connection>;
}

declare function connection(config: ConnectionConfig): Connection;

declare namespace connection {
  export interface Connection {
    getConnection(): Promise<amqp.Connection>;
    getChannel(queue: string, config: channels.ChannelConfig): Promise<amqp.Channel>;
    getDefaultChannel(): Promise<amqp.Channel>;
    /**
     * Register an event on the default amqp.node channel
     * @param on the channel event name to be bound with
     * @param func the callback function to execute when the event is called
     */
    addListener(on: string, func: Function): Promise<void>;

    get config(): ConnectionConfig;
    set config(value: ConnectionConfig);
  }

  export { ConnectionConfig };
}

export = connection;
