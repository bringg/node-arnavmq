const assert = require('assert');
const crypto = require('crypto');
const sinon = require('sinon');
const arnavmqConfigurator = require('../src/index');
const utils = require('../src/modules/utils');
const { Channels, ChannelAlreadyExistsError } = require('../src/modules/channels');

const fixtures = {
  queues: ['test-queue-0', 'test-queue-1', 'test-queue-2', 'test-queue-3', 'test-queue-4'],
  routingKey: 'queue-routing-key',
};

const arnavmq = arnavmqConfigurator();

let letters = 0;

function createFakeChannel() {
  return {
    isFake: true,
    prefetch: () => {},
    addListener: () => {},
    on: () => {},
    assertQueue: () => Promise.resolve({}),
    consume: () => Promise.resolve(),
  };
}

describe('producer/consumer', () => {
  const sandbox = sinon.createSandbox();
  afterEach(() => sandbox.restore());

  let beforeProduceHook;
  let afterProduceHook;
  let beforeProcessMessageHook;
  let afterProcessMessageHook;
  let beforeRpcReplyHook;
  let afterRpcReplyHook;

  function setupHooks() {
    beforeProduceHook = sandbox.stub();
    afterProduceHook = sandbox.spy();
    beforeProcessMessageHook = sandbox.stub();
    afterProcessMessageHook = sandbox.spy();
    beforeRpcReplyHook = sandbox.spy();
    afterRpcReplyHook = sandbox.spy();
    arnavmq.hooks.producer.beforeProduce(beforeProduceHook);
    arnavmq.hooks.producer.afterProduce(afterProduceHook);
    arnavmq.hooks.consumer.beforeProcessMessage(beforeProcessMessageHook);
    arnavmq.hooks.consumer.afterProcessMessage(afterProcessMessageHook);
    arnavmq.hooks.consumer.beforeRpcReply(beforeRpcReplyHook);
    arnavmq.hooks.consumer.afterRpcReply(afterRpcReplyHook);
  }

  function cleanupHooks() {
    if (!beforeProduceHook) {
      return;
    }

    arnavmq.hooks.producer.removeBeforeProduce(beforeProduceHook);
    arnavmq.hooks.producer.removeAfterProduce(afterProduceHook);
    arnavmq.hooks.consumer.removeBeforeProcessMessage(beforeProcessMessageHook);
    arnavmq.hooks.consumer.removeAfterProcessMessage(afterProcessMessageHook);
    arnavmq.hooks.consumer.removeBeforeRpcReply(beforeRpcReplyHook);
    arnavmq.hooks.consumer.removeAfterRpcReply(afterRpcReplyHook);
    beforeProduceHook = undefined;
  }

  describe('consuming messages', () => {
    context('prefetch', () => {
      it('when no custom prefetch specified is uses default channel', async () => {
        const queueName = 'use-default-prefetch';

        const channel = createFakeChannel();
        sandbox.stub(channel, 'assertQueue').resolves({ queue: queueName });

        const getChannel = sandbox.spy(arnavmq.connection, 'getChannel');
        const getChannelDefault = sandbox.stub(Channels.prototype, 'defaultChannel').resolves(channel);

        await arnavmq.consumer.consume(queueName, (message) => Promise.resolve(`${message}-test`));

        sinon.assert.calledWith(getChannel, queueName, { prefetch: 5 });
        sinon.assert.calledOnce(getChannelDefault);
        sinon.assert.calledWith(channel.assertQueue, queueName, {
          durable: true,
          persistent: true,
          channel: {
            prefetch: 5,
          },
        });
      });

      it('when custom prefetch specified is creates new channel', async () => {
        const queueName = 'use-custom-prefetch';
        const prefetch = 6;

        const connection = await arnavmq.connection.getConnection();

        const fakeChannel = createFakeChannel();
        sandbox.spy(fakeChannel, 'prefetch');
        sandbox.stub(fakeChannel, 'assertQueue').resolves({ queue: queueName });
        sandbox.stub(connection, 'createChannel').resolves(fakeChannel);

        const getChannel = sandbox.spy(arnavmq.connection, 'getChannel');
        const getChannelDefault = sandbox.spy(Channels.prototype, 'defaultChannel');

        await arnavmq.consumer.consume(queueName, { channel: { prefetch } }, (message) =>
          Promise.resolve(`${message}-test`),
        );

        sinon.assert.calledWith(getChannel, queueName, { prefetch });
        sinon.assert.calledWith(fakeChannel.prefetch, prefetch);
        sinon.assert.notCalled(getChannelDefault);
        sinon.assert.calledWith(fakeChannel.assertQueue, queueName, {
          durable: true,
          persistent: true,
          channel: {
            prefetch,
          },
        });
      });

      it('throws when existing channel with custom prefetch already exists', async () => {
        const queueName = 'use-custom-prefetch-duplicate';
        const prefetch = 6;

        // This is the first one
        await arnavmq.consumer.consume(queueName, { channel: { prefetch } }, (message) =>
          Promise.resolve(`${message}-test`),
        );

        await assert.rejects(async () => {
          // This is the second one
          await arnavmq.consumer.consume(queueName, { channel: { prefetch: prefetch + 1 } }, (message) =>
            Promise.resolve(`${message}-test`),
          );
        }, ChannelAlreadyExistsError);
      });
    });

    it('does not throw unhandled rejection when consume got error', async () => {
      const queueName = 'test-consume-error';
      const prefetch = 6;

      const channel = createFakeChannel();
      sandbox.stub(channel, 'assertQueue').resolves({ queue: queueName });

      sandbox.stub(arnavmq.connection, 'getChannel').resolves(channel);
      sandbox.stub(Channels.prototype, 'defaultChannel').resolves(channel);
      const consume = sandbox.stub(channel, 'consume').rejects(new Error('Error simulating connection closed.'));

      await arnavmq.consumer.consume(queueName, { channel: { prefetch } }, (message) =>
        Promise.resolve(`${message}-test`),
      );
      sinon.assert.called(consume);
    });
  });

  describe('msg delivering', () => {
    before(async () => {
      await arnavmq.consumer.consume(fixtures.queues[0], () => {
        letters -= 1;
      });

      await arnavmq.consumer.consume(fixtures.queues[1], () => {
        letters -= 1;
      });
    });

    afterEach(() => {
      cleanupHooks();
    });

    it('should receive message that is only string', async () => {
      const queueName = 'test-only-string-queue';
      const sentMessage = '85.69.30.121';
      setupHooks();

      await arnavmq.consumer.consume(queueName, (message) => Promise.resolve(`${message}-test`));
      const result = await arnavmq.producer.produce(queueName, sentMessage, { rpc: true });

      assert.equal(result, `${sentMessage}-test`);
    });

    it('should receive message that is only array', async () => {
      const queueName = 'test-only-array-queue';

      await arnavmq.consumer.consume(queueName, (message) => Promise.resolve({ message }));
      const result = await arnavmq.producer.produce(queueName, [1, '2'], { rpc: true });

      assert.deepEqual(result, { message: [1, '2'] });
    });

    it('should receive message headers', async () => {
      const headers = { header1: 'Header1', header2: 'Header2' };
      const queueName = 'test-headers';

      await arnavmq.consumer.consume(queueName, (message, properties) => Promise.resolve({ message, properties }));
      const result = await arnavmq.producer.produce(queueName, [1, '2'], { rpc: true, headers });

      assert.deepEqual(result.message, [1, '2']);
      assert.deepEqual(result.properties.headers, headers);
    });

    it('should receive message properties', async () => {
      const queueName = 'test-headers';

      await arnavmq.consumer.consume(queueName, (message, properties) => Promise.resolve({ message, properties }));
      const result = await arnavmq.producer.produce(queueName, [1, '2'], { rpc: true });

      assert.deepEqual(result.message, [1, '2']);
      assert.deepEqual(result.properties.contentType, 'application/json');
    });

    it('should receive contentLength property', async () => {
      const queueName = 'test-headers';
      const payload = { a: 1 };
      const messageSize = Buffer.byteLength(JSON.stringify(payload));

      await arnavmq.consumer.consume(queueName, (message, properties) => Promise.resolve({ message, properties }));
      const result = await arnavmq.producer.produce(queueName, payload, { rpc: true });

      assert.deepEqual(result.message, payload);
      assert.deepEqual(result.properties.contentType, 'application/json');
      assert.deepEqual(result.properties.contentLength, messageSize);
    });

    it('should be able to consume message sent by producer to queue [test-queue-0]', async () => {
      letters += 1;

      await arnavmq.producer.produce(fixtures.queues[0], { msg: crypto.randomUUID() });
      await utils.timeoutPromise(300);

      assert.equal(letters, 0);
    });

    it('should be able to consume message sent by producer to queue [test-queue-0] (no message)', async () => {
      letters += 1;

      await arnavmq.producer.produce(fixtures.queues[0]);
      await utils.timeoutPromise(300);

      assert.equal(letters, 0);
    });

    it('should be able to consume message sent by producer to queue [test-queue-0] (null message)', async () => {
      letters += 1;

      await arnavmq.producer.produce(fixtures.queues[0], null);
      await utils.timeoutPromise(300);

      assert.equal(letters, 0);
    });

    it('should not be able to consume message sent by producer to queue [test-queue-1]', async () => {
      letters += 1;

      await arnavmq.producer.produce(fixtures.queues[1], null);
      await utils.timeoutPromise(300);

      assert.equal(letters, 0);
    });

    it(
      'should be able to consume all message populated by producer to all queues [test-queue-0,' +
        ' test-queue-1, test-queue-2]',
      async () => {
        const count = 100;
        const messages = [];
        letters += 200;

        for (let i = 0; i < count; i += 1) {
          messages.push(arnavmq.producer.produce(fixtures.queues[0], null));
          messages.push(arnavmq.producer.produce(fixtures.queues[1], null));
        }
        await Promise.all(messages);
        await utils.timeoutPromise(500);

        assert.equal(letters, 0);
      },
    );

    describe('hooks', () => {
      beforeEach(() => setupHooks());

      it('calls the producer "before and after publish" hooks', async () => {
        const queueName = 'test-before-after-publish-hooks-queue';
        const sentMessage = crypto.randomUUID();

        await arnavmq.consumer.consume(queueName, (message) => Promise.resolve(`${message}-test`));
        const result = await arnavmq.producer.produce(queueName, sentMessage, { rpc: true });

        sinon.assert.calledWith(beforeProduceHook, {
          queue: queueName,
          message: sentMessage,
          parsedMessage: sinon.match.instanceOf(Buffer),
          properties: sinon.match({ rpc: true }),
          currentRetry: 0,
        });
        sinon.assert.calledWith(afterProduceHook, {
          queue: queueName,
          message: sentMessage,
          parsedMessage: sinon.match.instanceOf(Buffer),
          properties: sinon.match({ rpc: true }),
          currentRetry: 0,
          result,
          error: undefined,
        });
      });

      it('calls the consumer "before and after process message" hooks', async () => {
        const queueName = 'test-before-after-process-message-hooks-queue';
        const sentMessage = crypto.randomUUID();

        const callback = (message) => Promise.resolve(`${message}-test`);
        await arnavmq.consumer.consume(queueName, callback);
        await arnavmq.producer.produce(queueName, sentMessage, { rpc: true });

        sinon.assert.calledWith(beforeProcessMessageHook, {
          queue: queueName,
          action: { message: sinon.match({ content: sinon.match.instanceOf(Buffer) }), content: sentMessage, callback },
        });
        sinon.assert.calledWith(afterProcessMessageHook, {
          queue: queueName,
          message: sinon.match({ content: sinon.match.instanceOf(Buffer) }),
          content: sentMessage,
          ackError: undefined,
        });
      });

      it('calls the consumer "before and after rpc reply" hooks', async () => {
        const queueName = 'test-before-after-rpc-hooks-queue';
        const sentMessage = crypto.randomUUID();

        await arnavmq.consumer.consume(queueName, (message) => Promise.resolve(`${message}-test`));
        const result = await arnavmq.producer.produce(queueName, sentMessage, { rpc: true });

        sinon.assert.calledWith(beforeRpcReplyHook, {
          queue: queueName,
          reply: result,
          serializedReply: sinon.match.instanceOf(Buffer),
          replyProperties: {
            correlationId: sinon.match.string,
            persistent: true,
            durable: true,
          },
          receiveProperties: sinon.match.object,
          error: undefined,
        });
        sinon.assert.calledWith(afterRpcReplyHook, {
          queue: queueName,
          reply: result,
          serializedReply: sinon.match.instanceOf(Buffer),
          replyProperties: {
            correlationId: sinon.match.string,
            persistent: true,
            durable: true,
          },
          receiveProperties: sinon.match.object,
          written: true,
          error: undefined,
        });
      });

      it('does not call unregistered hooks', async () => {
        const queueName = 'test-unregister-hooks-queue';
        const sentMessage = crypto.randomUUID();

        const newHooks = [sinon.spy(), sinon.spy()];
        const unregisteredHooks = [
          ...newHooks,
          beforeRpcReplyHook,
          afterProcessMessageHook,
          beforeProcessMessageHook,
          afterProcessMessageHook,
          beforeRpcReplyHook,
          afterRpcReplyHook,
        ];
        cleanupHooks();
        arnavmq.hooks.producer.beforeProduce(newHooks);
        arnavmq.hooks.producer.removeBeforeProduce(newHooks);

        await arnavmq.consumer.consume(queueName, (message) => Promise.resolve(`${message}-test`));
        await arnavmq.producer.produce(queueName, sentMessage, { rpc: true });

        unregisteredHooks.forEach((hook) => sinon.assert.notCalled(hook));
      });
    });
  });

  describe('msg requeueing', () => {
    it('should requeue the message again on error [test-queue-4]', (done) => {
      let attempt = 3;

      const expectedMessage = { msg: crypto.randomUUID() };
      arnavmq.consumer
        .consume(fixtures.queues[4], (msg) => {
          assert(typeof msg === 'object');

          attempt -= 1;
          if (attempt === 0) {
            done();
            return;
          }
          throw new Error(`Any kind of error ${attempt}`);
        })
        .then(() => arnavmq.producer.produce(fixtures.queues[4], expectedMessage))
        .then((response) => {
          assert(response === true);
          letters += 1;
        })
        .catch(done);
    });
  });

  describe('routing keys', () => {
    it('should be able to send a message to a routing key exchange', (done) => {
      arnavmq.consumer
        .consume(
          fixtures.routingKey,
          (message) => {
            try {
              assert.equal(message.content, 'ok');
              done();
            } catch (error) {
              done(error);
            }
          },
          {},
        )
        .then(() => arnavmq.producer.produce('', { content: 'ok' }, { routingKey: fixtures.routingKey }))
        .catch(done);
    });
  });

  describe('rpc timeouts', () => {
    it('should reject on timeout, if no answer received', async () => {
      setupHooks();

      try {
        await arnavmq.producer.produce('non-existing-queue', { msg: 'ok' }, { rpc: true, timeout: 1000 });
        assert.fail('Did not get the expected error.');
      } catch (error) {
        if (error instanceof assert.AssertionError) {
          throw error;
        }
        sinon.assert.calledWith(afterProduceHook, sinon.match({ error: sinon.match({ message: 'Timeout reached' }) }));
        assert.equal(error.message, 'Timeout reached');
      }
    });

    it('should reject on default timeout, if no answer received', async () => {
      arnavmqConfigurator({ rpcTimeout: 1000 });
      try {
        await arnavmq.producer.produce('non-existing-queue', { msg: 'ok' }, { rpc: true });
        assert.fail('Did not get the expected error.');
      } catch (error) {
        if (error instanceof assert.AssertionError) {
          throw error;
        }

        assert.equal(error.message, 'Timeout reached');
      }
    });
  });

  describe('error', () => {
    it('should not be consumed', (done) => {
      setupHooks();
      const expectedMessage = { msg: crypto.randomUUID() };

      arnavmq.consumer
        .consume('test-queue-5', () => ({ error: new Error('Error test') }))
        .then(() => arnavmq.producer.produce('test-queue-5', expectedMessage, { rpc: true }))
        .then((response) => {
          assert(response.error);
          assert(response.error instanceof Error);

          // Should include error in the hook if given.
          sinon.assert.calledWith(beforeRpcReplyHook, sinon.match({ error: sinon.match({ message: 'Error test' }) }));
          sinon.assert.calledWith(afterProduceHook, sinon.match({ error: sinon.match({ message: 'Error test' }) }));
          done();
        })
        .catch(done);
    });
  });

  describe('undefined queue name', () => {
    before(() => {
      arnavmqConfigurator({ consumerSuffix: undefined });
    });

    it('should receive message', (done) => {
      arnavmq.consumer
        .consume('queue-name-undefined-suffix', (message) => {
          try {
            assert.equal(message.msg, 'test for undefined queue suffix');
            done();
          } catch (error) {
            done(error);
          }
        })
        .then(() =>
          arnavmq.producer.produce('queue-name-undefined-suffix', {
            msg: 'test for undefined queue suffix',
          }),
        );
    });
  });
});
