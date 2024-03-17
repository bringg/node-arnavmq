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
import arnavmq = require('./modules/arnavmq');

declare function arnavmqFactory(config: ConnectionConfig): arnavmq.Arnavmq;

declare namespace arnavmqFactory {
  export type Arnavmq = arnavmq.Arnavmq;
  export type ArnavmqFactory = (config: ConnectionConfig) => Arnavmq;

  export { ConnectionConfig, Connection, Consumer, Producer, ConnectionHooks, ConsumerHooks, ProducerHooks };
}

export = arnavmqFactory;
