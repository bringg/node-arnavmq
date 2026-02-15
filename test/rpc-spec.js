const assert = require('assert');
const crypto = require('crypto');
const sinon = require('sinon');
const arnavmq = require('../src/index')();
const utils = require('../src/modules/utils');

const fixtures = {
  queues: ['rpc-queue-0', 'rpc-queue-1', 'rpc-queue-2', 'rpc-queue-3'],
};

describe('Producer/Consumer RPC messaging:', () => {
  it('should be able to create a consumer that returns a message if called as RPC [rpc-queue-0]', async () => {
    const created = await arnavmq.consumer.consume(fixtures.queues[0], () => 'Power Ranger Red');

    assert(created === true);
  });

  it('should be able to send directly to the queue, without correlationId and not crash [rpc-queue-0]', async () => {
    await arnavmq.producer.produce(fixtures.queues[0], { nothing: true }, { rpc: true });
    await arnavmq.producer.produce(`${fixtures.queues[0]}:${arnavmq.connection.config.hostname}:${process.pid}:res`, {
      nothing: true,
    });
    await utils.timeoutPromise(500);
  });

  it('should be able to produce a RPC message and get a response [rpc-queue-0]', async () => {
    const response = await arnavmq.producer.produce(fixtures.queues[0], { msg: crypto.randomUUID() }, { rpc: true });

    assert.strictEqual(response, 'Power Ranger Red');
  });

  it('should be able to produce a RPC message and get a as JSON [rpc-queue-1]', async () => {
    await arnavmq.consumer.consume(fixtures.queues[1], () => ({ powerRangerColor: 'Pink' }));
    const response = await arnavmq.producer.produce(fixtures.queues[1], { msg: crypto.randomUUID() }, { rpc: true });

    assert.strictEqual(typeof response, 'object');
    assert.strictEqual(response.powerRangerColor, 'Pink');
  });

  it('should be able to produce a RPC message and get undefined response [rpc-queue-2]', async () => {
    await arnavmq.consumer.consume(fixtures.queues[2], () => undefined);
    const response = await arnavmq.producer.produce(fixtures.queues[2], undefined, { rpc: true });

    assert.strictEqual(response, undefined);
  });

  it('should return syntax error when we fail to parse response', (done) => {
    arnavmq.consumer
      .consume(fixtures.queues[3], async (msg, properties) => {
        // call produce here manually to simulate client sending invalid json
        try {
          await arnavmq.producer.produce(properties.replyTo, 'invalid_json', {
            correlationId: properties.correlationId,
            contentType: 'application/json',
          });
        } catch (error) {
          done(error);
        }
        // delete the replyTo so we don't return rpc to client
        delete properties.replyTo;
      })
      .then(() =>
        arnavmq.producer
          .produce(fixtures.queues[3], undefined, {
            contentType: 'application/json',
            rpc: true,
            timeout: 2000,
          })
          .then(() => {
            assert.fail('Did not get the expected error.');
          }),
      )
      .catch((error) => {
        if (error instanceof assert.AssertionError) {
          done(error);
          return;
        }

        try {
          assert.strictEqual(
            error.name,
            'SyntaxError',
            `Got unexpected error of type '${error.name}': ${error.message}`,
          );
          done();
        } catch (assertError) {
          done(assertError);
        }
      });
  });

  it('should return SyntaxError to RPC producer when consumer receives invalid JSON', async () => {
    const queueName = 'rpc-queue-parse-error';

    const callbackSpy = sinon.spy(() => 'should not be called');
    await arnavmq.consumer.consume(queueName, callbackSpy);

    const response = await arnavmq.producer.produce(queueName, 'not{valid}json', {
      contentType: 'application/json',
      rpc: true,
      timeout: 2000,
    });

    sinon.assert.notCalled(callbackSpy);

    // The RPC response should contain the error
    // Note: error is serialized/deserialized, so instanceof won't work - check .name instead
    assert(response.error, 'Expected response to contain an error');
    assert.strictEqual(response.error.name, 'SyntaxError');
  });
});
