/* eslint-disable no-underscore-dangle */
const assert = require('assert');
const crypto = require('crypto');
const sinon = require('sinon');
const pDefer = require('p-defer');
const arnavmq = require('../src/index')();
const amqp = require('amqplib');
const utils = require('../src/modules/utils');
const { ArnavMQ } = require('../src/modules/arnavmq');
const { DIRECT_REPLY_TO, newConnection, waitFor } = require('./test-helpers');

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

  describe('Direct Reply-to', () => {
    const sandbox = sinon.createSandbox();
    const extraRequesters = [];
    let requester;

    function newRequester() {
      return new ArnavMQ(newConnection({ hostname: 'rpc-direct-reply-to' }));
    }

    /** A requester of its own, for a test that needs an RPC channel nobody has used yet. */
    function freshRequester() {
      const mq = newRequester();
      extraRequesters.push(mq);
      return mq;
    }

    // One requester for the tests that don't care which RPC channel they run on, already warmed up
    // so a short RPC timeout never lands on the channel setup.
    before(async () => {
      requester = newRequester();
      await requester.producer._getReplyChannel();
    });

    after(async () => {
      await requester.connection.close();
    });

    afterEach(async () => {
      sandbox.restore();
      await Promise.all(extraRequesters.splice(0).map((mq) => mq.connection.close()));
    });

    it('publishes with the Direct Reply-to replyTo, tells the responder a rewritten address, and declares no reply queue', async () => {
      const queue = `rpc-direct-${crypto.randomUUID()}`;
      let responderReplyTo;
      await arnavmq.consumer.consume(queue, (msg, properties) => {
        responderReplyTo = properties.replyTo;
        return 'pong';
      });
      const mq = freshRequester();
      const beforeProduce = sandbox.spy();
      const afterProduce = sandbox.spy();
      mq.producer.hooks.beforeProduce(beforeProduce);
      mq.producer.hooks.afterProduce(afterProduce);
      const defaultChannel = await mq.connection.getDefaultChannel();
      const defaultAssertQueue = sandbox.spy(defaultChannel, 'assertQueue');
      const consume = sandbox.spy(defaultChannel, 'consume');

      const response = await mq.publish(queue, { ping: true }, { rpc: true, timeout: 5000 });

      assert.strictEqual(response, 'pong');
      sinon.assert.calledWith(beforeProduce, sinon.match({ properties: sinon.match({ replyTo: DIRECT_REPLY_TO }) }));
      sinon.assert.calledWith(afterProduce, sinon.match({ properties: sinon.match({ replyTo: DIRECT_REPLY_TO }) }));
      assert(responderReplyTo.startsWith(`${DIRECT_REPLY_TO}.`), `unexpected replyTo ${responderReplyTo}`);
      sinon.assert.notCalled(defaultAssertQueue);
      sinon.assert.calledOnceWithExactly(consume, DIRECT_REPLY_TO, sinon.match.func, { noAck: true });
    });

    it('resolves concurrent RPCs to several target queues with their own replies over one reply consumer', async () => {
      const queues = ['a', 'b', 'c'].map((suffix) => `rpc-direct-${suffix}-${crypto.randomUUID()}`);
      await Promise.all(
        queues.map((queue) =>
          arnavmq.consumer.consume(queue, async (msg) => {
            // the first request is answered last, so replies can't match requests by position
            await utils.timeoutPromise(queue === queues[0] ? 40 : 5);
            return `${queue}:${msg.n}`;
          }),
        ),
      );
      const mq = freshRequester();
      const consume = sandbox.spy(await mq.connection.getDefaultChannel(), 'consume');

      const responses = await Promise.all(
        queues.map((queue, n) => mq.publish(queue, { n }, { rpc: true, timeout: 5000 })),
      );

      assert.deepStrictEqual(responses, [`${queues[0]}:0`, `${queues[1]}:1`, `${queues[2]}:2`]);
      sinon.assert.calledOnceWithExactly(consume, DIRECT_REPLY_TO, sinon.match.func, { noAck: true });
    });

    it('rejects a second RPC reusing a pending correlationId without retrying it, and the first still resolves', async () => {
      const queue = `rpc-direct-dup-${crypto.randomUUID()}`;
      const gate = pDefer();
      await arnavmq.consumer.consume(queue, async () => {
        await gate.promise;
        return 'first-reply';
      });
      const afterProduce = sandbox.spy();
      requester.producer.hooks.afterProduce(afterProduce);
      const options = { rpc: true, timeout: 5000, correlationId: 'duplicated' };

      const first = requester.publish(queue, { n: 1 }, { ...options });
      await waitFor(() => requester.producer._rpcRequests.has('duplicated'));
      // producerMaxRetries is -1: a retried rejection would never settle
      await assert.rejects(
        () => requester.publish(queue, { n: 2 }, { ...options }),
        (error) => error.constructor.name === 'ProducerError',
      );
      gate.resolve();

      assert.strictEqual(await first, 'first-reply');
      sinon.assert.calledWith(afterProduce, sinon.match({ shouldRetry: false, currentRetry: 0 }));
      requester.producer.hooks.removeAfterProduce(afterProduce);
    });

    it('rejects with "Timeout reached", and a reply arriving after the timeout neither throws nor settles anything', async () => {
      const queue = `rpc-direct-late-${crypto.randomUUID()}`;
      const fastQueue = `rpc-direct-fast-${crypto.randomUUID()}`;
      const gate = pDefer();
      await arnavmq.consumer.consume(queue, async () => {
        await gate.promise;
        return 'too late';
      });
      await arnavmq.consumer.consume(fastQueue, () => 'fast');
      const onReply = sandbox.spy(requester.producer, '_onReply');

      await assert.rejects(() => requester.publish(queue, {}, { rpc: true, timeout: 50 }), {
        message: 'Timeout reached',
      });
      assert.strictEqual(requester.producer._rpcRequests.size, 0);

      gate.resolve();
      await waitFor(() => onReply.called); // the late reply reached the requester

      // the reply consumer survived the late reply
      assert.strictEqual(await requester.publish(fastQueue, {}, { rpc: true, timeout: 5000 }), 'fast');
    });

    it('ignores a reply with no correlationId, leaving the request to its timeout', async () => {
      const queue = `rpc-direct-nocorr-${crypto.randomUUID()}`;
      await arnavmq.consumer.consume(queue, async (msg, properties) => {
        await arnavmq.producer.produce(properties.replyTo, { nothing: true });
        delete properties.replyTo; // no further reply to the client
      });

      await assert.rejects(() => requester.publish(queue, {}, { rpc: true, timeout: 100 }), {
        message: 'Timeout reached',
      });
    });

    it('still answers a plain amqplib requester that uses a named exclusive reply queue', async () => {
      const queue = `rpc-direct-interop-${crypto.randomUUID()}`;
      await arnavmq.consumer.consume(queue, (msg) => ({ echo: msg.value }));
      const connection = await amqp.connect('amqp://localhost');
      try {
        const channel = await connection.createChannel();
        const { queue: replyQueue } = await channel.assertQueue('', { exclusive: true });
        const replied = new Promise((resolve) => {
          channel.consume(replyQueue, resolve, { noAck: true });
        });

        channel.sendToQueue(queue, Buffer.from(JSON.stringify({ value: 42 })), {
          contentType: 'application/json',
          replyTo: replyQueue,
          correlationId: 'plain-amqplib',
        });

        const message = await replied;
        assert.strictEqual(message.properties.correlationId, 'plain-amqplib');
        assert.deepStrictEqual(JSON.parse(message.content.toString()), { echo: 42 });
      } finally {
        await connection.close();
      }
    });
  });
});
