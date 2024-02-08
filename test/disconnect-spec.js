const assert = require('assert');
const sinon = require('sinon');
const pDefer = require('p-defer');
const docker = require('./docker');
const arnavmqConfigurator = require('../src/index');
const utils = require('../src/modules/utils');

/* eslint func-names: "off" */
/* eslint prefer-arrow-callback: "off" */
describe('disconnections', function () {
  let arnavmq;

  beforeEach(() => {
    arnavmq = arnavmqConfigurator();
  });

  const sandbox = sinon.createSandbox();
  afterEach(() => sandbox.restore());

  describe('regular pub/sub', () => {
    const queue = 'disco:test';

    it('should be able to re-register to consume messages between connection failures', async () => {
      let counter = 0;
      const consumedAllPromise = pDefer();

      await arnavmq.consumer.consume(queue, () => {
        counter += 1;

        if (counter === 50) {
          consumedAllPromise.resolve();
        }
      });

      await arnavmq.producer.produce(queue);
      await utils.timeoutPromise(500);
      assert.equal(counter, 1);
      await docker.disconnectNetwork();

      const producePromises = [];
      for (let i = counter; i < 50; i += 1) {
        producePromises.push(arnavmq.producer.produce(queue));
      }

      await docker.connectNetwork();
      await Promise.all(producePromises);
      await consumedAllPromise.promise;
      assert.equal(counter, 50);
    });

    it('should retry producing only as configured', async () => {
      const retryCount = 3;
      arnavmqConfigurator({ timeout: 100, producerMaxRetries: retryCount });
      const expectedError = 'Fake connection error.';
      sandbox.stub(arnavmq.connection, 'getDefaultChannel').rejects(new Error(expectedError));

      await assert.rejects(
        () => arnavmq.producer.produce(queue),
        (err) => {
          sinon.assert.callCount(arnavmq.connection.getDefaultChannel, retryCount + 1);
          assert.strictEqual(err.message, expectedError);
          return true;
        },
      );
    });

    describe('hooks', () => {
      let beforeConnectHook;
      let afterConnectHook;
      let afterPublishHook;

      beforeEach(() => {
        beforeConnectHook = sandbox.spy();
        afterConnectHook = sandbox.spy();
        afterPublishHook = sandbox.stub();
      });

      afterEach(() => {
        arnavmq.hooks.connection.removeBeforeConnect(beforeConnectHook);
        arnavmq.hooks.connection.removeAfterConnect(afterConnectHook);
        arnavmq.hooks.producer.removeAfterPublish(afterPublishHook);
      });

      it('should stop retrying if "after processing" hook returned false', async () => {
        const retryCount = 3;
        arnavmqConfigurator({ timeout: 100, producerMaxRetries: retryCount });
        const expectedError = 'Fake connection error.';
        const hookTestsQueue = 'disco:test:hooks:1';
        const expectedHookArgs = {
          queue: hookTestsQueue,
          message: {},
          parsedMessage: sinon.match.instanceOf(Buffer),
          properties: sinon.match.object,
          shouldRetry: true,
          error: sinon.match({ message: expectedError }),
        };
        sandbox.stub(arnavmq.connection, 'getDefaultChannel').rejects(new Error(expectedError));
        let hookCallCount = 0;
        afterPublishHook.callsFake((event) => {
          if (event.queue !== hookTestsQueue) {
            return undefined;
          }
          hookCallCount += 1;

          if (hookCallCount >= 2) {
            return false;
          }
          return undefined;
        });
        arnavmq.hooks.producer.afterPublish(afterPublishHook);

        await assert.rejects(
          () => arnavmq.producer.produce(hookTestsQueue),
          (err) => {
            sinon.assert.callCount(arnavmq.connection.getDefaultChannel, 2);
            assert.strictEqual(err.message, expectedError);
            return true;
          },
        );
        assert.equal(hookCallCount, 2);
        sinon.assert.calledWith(afterPublishHook, { ...expectedHookArgs, currentRetry: 0 });
        sinon.assert.calledWith(afterPublishHook, { ...expectedHookArgs, currentRetry: 1 });
      });

      it('calls event hooks on connecting', async () => {
        const hookTestsQueue = 'disco:test:hooks:2';
        const consumedAllPromise = pDefer();
        await arnavmq.consumer.consume(hookTestsQueue, () => {
          consumedAllPromise.resolve();
        });

        await docker.disconnectNetwork();

        arnavmq.hooks.connection.beforeConnect(beforeConnectHook);
        arnavmq.hooks.connection.afterConnect(afterConnectHook);

        await docker.connectNetwork();
        await arnavmq.producer.produce(hookTestsQueue);
        await consumedAllPromise.promise;

        sinon.assert.called(beforeConnectHook);
        sinon.assert.called(afterConnectHook);
      });
    });
  });

  describe('RPC', () => {
    const queue = 'disco:test:2';

    it('should be able to re-register to consume messages between connection failures', async () => {
      let counter = 0;
      arnavmqConfigurator({ rpcTimeout: 0 });

      await arnavmq.consumer.consume(queue, () => {
        counter += 1;
        return counter;
      });

      await arnavmq.producer.produce(queue, undefined, { rpc: true });
      await utils.timeoutPromise(500);
      assert.strictEqual(counter, 1);

      await docker.disconnectNetwork();

      const producePromises = [];
      for (let i = counter; i < 50; i += 1) {
        producePromises.push(arnavmq.producer.produce(queue, undefined, { rpc: true }));
      }

      await docker.connectNetwork();
      const responses = await Promise.all(producePromises);
      responses.sort((a, b) => a - b);

      assert.deepStrictEqual(
        responses,
        Array.from({ length: 49 }, (_, i) => i + 2),
      );
      assert.strictEqual(counter, 50, `consumer counter should be 50, but it is ${counter}`);
    });
  });
});
