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
     * Graceful shutdown: cancel consumers -> drain in-flight handlers (rejecting+requeueing any
     * still running past the timeout) -> reject pending RPC waiters -> close the connection.
     * Idempotent - repeated calls are cheap no-ops rather than re-running the sequence.
     * @param options
     * @param options.timeout Drain budget in ms, passed through to consumer.stop(). Defaults to
     *   the `shutdownTimeout` config value (30000ms).
     * @return Resolves once shutdown has completed (never rejects) with the drain outcome: whether
     *   everything drained cleanly, and how many in-flight messages were abandoned per queue.
     */
    close: (options?: { timeout?: number }) => Promise<Consumer.StopResult>;
    consumer: {
      consume: typeof Consumer.prototype.consume;
      subscribe: typeof Consumer.prototype.consume;
      cancel: typeof Consumer.prototype.cancel;
      stop: typeof Consumer.prototype.stop;
      drain: typeof Consumer.prototype.drain;
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
