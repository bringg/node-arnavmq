import { AmqpMessage, AmqpOptions } from './amqp';

declare function _in(msg: AmqpMessage): unknown;
export { _in as in };
export function out(content: unknown, options: AmqpOptions.Publish): Buffer;
