/*
 * Base types were generated using the command:
 *
 *   npx -p typescript tsc src/index.js --declaration --allowJs --emitDeclarationOnly --outDir types
 *
 * Then, all private methods were removed from the types, and all the 'any' placeholders were replaced with handcrafted types to match the expected values, and exported in addition to the actual classes as part of the module.
 * Any jsdoc comments with parameter descriptions were updated accordingly.
 */

import { ConnectionConfig, Connection } from './modules/connection';
import Consumer = require('./modules/consumer');
import Producer = require('./modules/producer');
import { ConnectionHooks, ConsumerHooks, ProducerHooks } from './modules/hooks';

declare function arnavmq(config: ConnectionConfig): {
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

declare namespace arnavmq {
  export type ArnavmqFactory = (config: ConnectionConfig) => {
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

  export { ConnectionConfig, Connection, Consumer, Producer, ConnectionHooks, ConsumerHooks, ProducerHooks };
}

export = arnavmq;
