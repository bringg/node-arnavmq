import BaseHooks = require('./base_hooks');
import { Connection, ConnectionConfig } from '../connection';
import type amqp = require('amqplib');

type BeforeConnectHook = (this: Connection, event: { config: ConnectionConfig }) => Promise<void>;
type AfterConnectHook = (this: Connection, event: AfterConnectInfo) => Promise<void>;
type AfterConnectInfo = {
  config: ConnectionConfig;
} & (
  | {
      connection: amqp.Connection;
      error: undefined;
    }
  | {
      error: Error;
    }
);

declare class ConnectionHooks extends BaseHooks {
  /**
   * Registers callback/callbacks to be invoked before creating a connection to rabbitmq.
   * The callback is invoked with 'this' set to the connection wrapper instance creating the connection, and a single "payload" argument of the following shape:
   * - config - The configuration object used for connecting.
   * @param callback A callback or callbacks array to register.
   */
  beforeConnect(callback: BeforeConnectHook | BeforeConnectHook[]): void;
  /** Removes a callback or callback array from the hook. */
  removeBeforeConnect(callback: BeforeConnectHook | BeforeConnectHook[]): void;
  /**
   * Registers callback/callbacks to be invoked before creating a connection to rabbitmq.
   * The callback is invoked with 'this' set to the connection wrapper instance creating the connection, and a single "payload" argument of the following shape:
   * - config - The configuration object used for connecting.
   * - connection - The created underlying amqplib connection.
   * - error - The error in case of connection failure.
   * @param {AfterConnectHook | AfterConnectHook[]} callback A callback or callbacks array to register.
   */
  afterConnect(callback: AfterConnectHook | AfterConnectHook[]): void;
  /** Removes a callback or callback array from the hook. */
  removeAfterConnect(callback: AfterConnectHook | AfterConnectHook[]): void;
}

declare namespace ConnectionHooks {
  export const beforeConnectEvent: 'connection.beforeConnect';
  export const afterConnectEvent: 'connection.afterConnect';

  export interface ConnectionHooks extends BaseHooks {
    /**
     * Registers callback/callbacks to be invoked before creating a connection to rabbitmq.
     * The callback is invoked with 'this' set to the connection wrapper instance creating the connection, and a single "payload" argument of the following shape:
     * - config - The configuration object used for connecting.
     * @param callback A callback or callbacks array to register.
     */
    beforeConnect(callback: BeforeConnectHook | BeforeConnectHook[]): void;
    /** Removes a callback or callback array from the hook. */
    removeBeforeConnect(callback: BeforeConnectHook | BeforeConnectHook[]): void;
    /**
     * Registers callback/callbacks to be invoked before creating a connection to rabbitmq.
     * The callback is invoked with 'this' set to the connection wrapper instance creating the connection, and a single "payload" argument of the following shape:
     * - config - The configuration object used for connecting.
     * - connection - The created underlying amqplib connection.
     * - error - The error in case of connection failure.
     * @param {AfterConnectHook | AfterConnectHook[]} callback A callback or callbacks array to register.
     */
    afterConnect(callback: AfterConnectHook | AfterConnectHook[]): void;
    /** Removes a callback or callback array from the hook. */
    removeAfterConnect(callback: AfterConnectHook | AfterConnectHook[]): void;
  }

  export { AfterConnectHook, AfterConnectInfo, BeforeConnectHook };
}

export = ConnectionHooks;
