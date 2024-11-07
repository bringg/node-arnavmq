const assert = require('assert');
const sinon = require('sinon');
const pDefer = require('p-defer');
const docker = require('./docker');
const arnavmqConfigurator = require('../src/index');
const utils = require('../src/modules/utils');

describe('disconnections', () => {
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
      let afterProduceHook;

      beforeEach(() => {
        beforeConnectHook = sandbox.spy();
        afterConnectHook = sandbox.spy();
        afterProduceHook = sandbox.stub();
      });

      afterEach(() => {
        arnavmq.hooks.connection.removeBeforeConnect(beforeConnectHook);
        arnavmq.hooks.connection.removeAfterConnect(afterConnectHook);
        arnavmq.hooks.producer.removeAfterProduce(afterProduceHook);
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
