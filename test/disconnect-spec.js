const assert = require('assert');
const docker = require('./docker');
const arnavmq = require('../src/index')();
const utils = require('../src/modules/utils');

/* eslint func-names: "off" */
/* eslint prefer-arrow-callback: "off" */
describe('disconnections', function () {
  before(() => docker.run().then(docker.start));

  after(docker.rm);

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
