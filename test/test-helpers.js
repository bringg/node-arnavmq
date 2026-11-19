const { Connection } = require('../src/modules/connection');

/** RabbitMQ's Direct Reply-to pseudo-queue, as the requester names it in `replyTo`. */
const DIRECT_REPLY_TO = 'amq.rabbitmq.reply-to';

/**
 * A Connection against the real broker, built from the exported class rather than the module's
 * singleton factory, so close() (which is terminal) never tears down what the other spec files use.
 */
function newConnection(overrides = {}) {
  return new Connection({
    host: 'amqp://localhost',
    hostname: 'arnavmq-test',
    prefetch: 5,
    timeout: 10,
    requeue: true,
    consumerSuffix: '',
    producerMaxRetries: -1,
    rpcTimeout: 0,
    ...overrides,
  });
}

/** Polls `predicate` every few ms until truthy, or throws once `timeoutMs` elapses. */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`waitFor() timed out after ${timeoutMs}ms waiting for: ${predicate}`);
    }
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

module.exports = { DIRECT_REPLY_TO, newConnection, waitFor };
