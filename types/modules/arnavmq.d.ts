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
     * Graceful shutdown: stop consuming -> let every in-flight handler finish (no timeout) ->
     * close the connection. Idempotent - repeated calls are cheap no-ops rather than re-running
     * the sequence.
     *
     * The connection stays open for the whole drain, so a handler can finish its work: publish
     * downstream, answer an RPC request it had already received, or complete a new RPC round-trip
     * of its own. Anything a handler starts is waited on too.
     *
     * No drain timeout: a handler that never finishes means close() never resolves, which is left
     * to the process orchestrator's kill grace period. Closing the connection is what fails any
     * still-pending RPC waiter, with `ConnectionClosedError`, rather than letting it hang out
     * `rpcTimeout`.
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
