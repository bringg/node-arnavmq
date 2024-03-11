declare function _in(msg: amqp.Message): unknown;
export { _in as in };
export function out(content: unknown, options: amqp.Options.Publish): Buffer;

import type amqp = require('amqplib');
