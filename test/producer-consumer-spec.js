const assert = require('assert');
const uuid = require('uuid');
const sinon = require('sinon');
const arnavmq = require('../src/index')();
const utils = require('../src/modules/utils');
const { Channels, ChannelAlreadyExistsError } = require('../src/modules/channels');

const fixtures = {
  queues: ['test-queue-0', 'test-queue-1', 'test-queue-2', 'test-queue-3', 'test-queue-4'],
  routingKey: 'queue-routing-key',
};

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

/* eslint func-names: "off" */
/* eslint prefer-arrow-callback: "off" */
describe('producer/consumer', function () {
  const sandbox = sinon.createSandbox();
  afterEach(() => sandbox.restore());

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
          Promise.resolve(`${message}-test`)
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
          Promise.resolve(`${message}-test`)
        );

        await assert.rejects(async () => {
          // This is the second one
          await arnavmq.consumer.consume(queueName, { channel: { prefetch: prefetch + 1 } }, (message) =>
            Promise.resolve(`${message}-test`)
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
        Promise.resolve(`${message}-test`)
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

    it('should receive message that is only string', async () => {
      const queueName = 'test-only-string-queue';

      await arnavmq.consumer.consume(queueName, (message) => Promise.resolve(`${message}-test`));
      const result = await arnavmq.producer.produce(queueName, '85.69.30.121', { rpc: true });

      assert.equal(result, '85.69.30.121-test');
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

      await arnavmq.producer.produce(fixtures.queues[0], { msg: uuid.v4() });
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
      }
    );
  });

  describe('msg requeueing', () => {
    it('should requeue the message again on error [test-queue-4]', (done) => {
      let attempt = 3;

      arnavmq.consumer
        .consume(fixtures.queues[4], (msg) => {
          assert(typeof msg === 'object');

          attempt -= 1;
          if (attempt === 0) {
            done();
            return;
          }
          throw new Error('Any kind of error');
        })
        .then(() => arnavmq.producer.produce(fixtures.queues[4], { msg: uuid.v4() }))
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
          {}
        )
        .then(() => arnavmq.producer.produce('', { content: 'ok' }, { routingKey: fixtures.routingKey }))
        .catch(done);
    });
  });

  describe('rpc timeouts', () => {
    it('should reject on timeout, if no answer received', async () => {
      try {
        await arnavmq.producer.produce('non-existing-queue', { msg: 'ok' }, { rpc: true, timeout: 1000 });
        assert.fail('Did not get the expected error.');
      } catch (error) {
        if (error instanceof assert.AssertionError) {
          throw error;
        }
        assert.equal(error.message, 'Timeout reached');
      }
    });

    it('should reject on default timeout, if no answer received', async () => {
      arnavmq.connection._config.rpcTimeout = 1000;
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
      arnavmq.consumer
        .consume('test-queue-5', () => ({ error: new Error('Error test') }))
        .then(() => arnavmq.producer.produce('test-queue-5', {}, { rpc: true }))
        .then((response) => {
          assert(response.error);
          assert(response.error instanceof Error);
          done();
        })
        .catch(done);
    });
  });

  describe('undefined queue name', () => {
    before(() => {
      arnavmq.connection._config.consumerSuffix = undefined;
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
          })
        );
    });
  });
});
