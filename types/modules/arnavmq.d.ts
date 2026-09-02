import Producer = require('./producer');
import Consumer = require('./consumer');
import { Connection } from './connection';
import { ConnectionHooks, ConsumerHooks, ProducerHooks } from './hooks';

declare function arnavmq(connection: Connection): arnavmq.Arnavmq;

declare namespace arnavmq {
  export type Arnavmq = {
    connection: Connection;
    consume: typeof Consumer.prototype.consume;
    subscribe: typeof Consumer.prototype.consume;
    produce: typeof Producer.prototype.produce;
    publish: typeof Producer.prototype.produce;
    /**
     * Graceful shutdown: reject pending RPC waiters -> cancel consumers -> drain in-flight
     * handlers (no timeout) -> close the connection. Idempotent - repeated calls are cheap no-ops
     * rather than re-running the sequence.
     *
     * Pending RPC waiters are rejected up front, so a handler awaiting a response never holds the
     * drain open. From that point on a new outgoing RPC request fails with `ConnectionClosedError`;
     * non-RPC publishes, and RPC replies from handlers still draining, keep working until the
     * connection itself closes.
     * @return Resolves once shutdown has completed (never rejects).
     */
    close: () => Promise<void>;
    consumer: {
      consume: typeof Consumer.prototype.consume;
      subscribe: typeof Consumer.prototype.consume;
      inFlight: typeof Consumer.prototype.inFlight;
    };
    producer: {
      produce: typeof Producer.prototype.produce;
      publish: typeof Producer.prototype.produce;
    };
    hooks: {
      connection: ConnectionHooks;
      consumer: ConsumerHooks;
      producer: ProducerHooks;
    };
  };
}

export = arnavmq;
