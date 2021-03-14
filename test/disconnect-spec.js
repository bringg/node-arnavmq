const assert = require('assert');
const faker = require('faker');
const sinon = require('sinon');
const amqp = require('amqplib');
const docker = require('./docker');
const arnavmq = require('../src/index')({ producerMaxRetries: -1 });
const utils = require('../src/modules/utils');

/* eslint func-names: "off" */
/* eslint prefer-arrow-callback: "off" */
describe('disconnections', function () {
  before(docker.rm);
  before(() => docker.run().then(docker.start));

  describe('regular pub/sub', () => {
    const queue = 'disco:test';

    it('should be able to re-register to consume messages between connection failures', (done) => {
      let counter = 0;
      arnavmq.consumer.consume(queue, () => {
        counter += 1;
        if (counter === 50) {
          done();
        }
      })
        .then(() => arnavmq.producer.produce(queue))
        .then(() => utils.timeoutPromise(500))
        .then(() => assert(counter))
        .then(docker.stop)
        .then(() => {
          for (let i = counter; i < 50; i += 1) {
            arnavmq.producer.produce(queue);
          }
        })
        .then(docker.start)
        .catch(done);
    });

    it('should retry producing only as configured', (done) => {
      const retryCount = faker.random.number({ min: 2, max: 6 });
      arnavmq.connection._config.producerMaxRetries = retryCount;
      const expectedError = 'Fake connection error.';
      sinon.stub(amqp, 'connect').rejects(new Error(expectedError));

      arnavmq.producer.produce(queue)
        .then(() => {
          assert.fail('Should fail to produce and throw error, but did not.');
        })
        .catch((e) => {
          if (e instanceof assert.AssertionError) {
            done(e);
            return;
          }
          try {
            sinon.assert.callCount(amqp.connect, retryCount + 1);
            assert.strictEqual(e.message, 'Fake connection error.');
            done();
          } catch (error) {
            done(error);
          }
        });
    });
  });

  describe('RPC', () => {
    const queue = 'disco:test:2';

    it('should be able to re-register to consume messages between connection failures', (done) => {
      let counter = 0;
      const checkReceived = (cnt) => {
        if (cnt === 50) done();
      };
      arnavmq.connection._config.rpcTimeout = 0;
      arnavmq.consumer.consume(queue, () => {
        counter += 1;
        return counter;
      })
        .then(() => arnavmq.producer.produce(queue, undefined, { rpc: true }).then(checkReceived))
        .then(() => utils.timeoutPromise(500))
        .then(() => assert(counter))
        .then(docker.stop)
        .then(() => {
          for (let i = counter; i < 50; i += 1) {
            arnavmq.producer.produce(queue, undefined, { rpc: true }).then(checkReceived);
          }
        })
        .then(docker.start)
        .catch(done);
    });
  });
});
