const docker = require('./docker');
const assert = require('assert');
const { producer, consumer } = require('../src/index')();
const utils = require('../src/modules/utils');

/* eslint func-names: "off" */
/* eslint prefer-arrow-callback: "off" */
describe('disconnections', function () {
  this.timeout(20000);

  before(docker.start);

  after(docker.stop);

  describe('regular pub/sub', () => {
    const queue = 'disco:test';

    it('should be able to re-register to consume messages between connection failures', (done) => {
      this.timeout(20000);
      let counter = 0;
      consumer.consume(queue, () => {
        counter += 1;
        if (counter === 50) {
          done();
        }
      })
      .then(() => producer.produce(queue))
      .then(() => utils.timeoutPromise(500))
      .then(() => assert(counter))
      .then(docker.stop)
      .then(() => {
        for (let i = counter; i < 50; i += 1) {
          producer.produce(queue);
        }
      })
      .then(docker.start);
    });
  });

  describe('RPC', () => {
    const queue = 'disco:test:2';

    it('should be able to re-register to consume messages between connection failures', (done) => {
      this.timeout(20000);
      let counter = 0;
      const checkReceived = (cnt) => {
        if (cnt === 50) done();
      };

      consumer.consume(queue, () => {
        counter += 1;
        return counter;
      })
      .then(() => producer.produce(queue, undefined, { rpc: true }).then(checkReceived))
      .then(() => utils.timeoutPromise(500))
      .then(() => assert(counter))
      .then(docker.stop)
      .then(() => {
        for (let i = counter; i < 50; i += 1) {
          producer.produce(queue, undefined, { rpc: true }).then(checkReceived);
        }
      })
      .then(docker.start);
    });
  });
});
