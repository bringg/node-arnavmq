const assert = require('assert');
const sinon = require('sinon');
const pDefer = require('p-defer');
const docker = require('./docker');
const arnavmqFactory = require('../src/index');
const utils = require('../src/modules/utils');

/* eslint func-names: "off" */
/* eslint prefer-arrow-callback: "off" */
describe('disconnections', function () {
  let arnavmq;

  beforeEach(() => {
    arnavmq = arnavmqFactory();
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
      arnavmq.connection._config.producerMaxRetries = retryCount;
      const expectedError = 'Fake connection error.';
      sandbox.stub(arnavmq.connection, 'getDefaultChannel').rejects(new Error(expectedError));

      await assert.rejects(
        () => arnavmq.producer.produce(queue),
        (err) => {
          sinon.assert.callCount(arnavmq.connection.getDefaultChannel, retryCount + 1);
          assert.strictEqual(err.message, expectedError);
          return true;
        }
      );
    });
  });

  describe('RPC', () => {
    const queue = 'disco:test:2';

    it('should be able to re-register to consume messages between connection failures', async () => {
      let counter = 0;
      arnavmq.connection._config.rpcTimeout = 0;

      await arnavmq.consumer.consume(queue, () => {
        counter += 1;
        return counter;
      });

      await arnavmq.producer.produce(queue, undefined, { rpc: true });
      await utils.timeoutPromise(500);
      assert.equal(counter, 1);

      await docker.disconnectNetwork();

      const producePromises = [];
      for (let i = counter; i < 50; i += 1) {
        producePromises.push(arnavmq.producer.produce(queue, undefined, { rpc: true }));
      }

      await docker.connectNetwork();
      let responses = await Promise.all(producePromises);
      responses = responses.sort((a, b) => a - b);

      const lastResponse = responses[responses.length - 1];
      assert.equal(lastResponse, 50, 'last response should be 50');
      assert.equal(counter, 50, 'consumer counter should be 50');
    });
  });
});
