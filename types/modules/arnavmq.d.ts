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
    consumer: {
      consume: typeof Consumer.prototype.consume;
      subscribe: typeof Consumer.prototype.consume;
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
