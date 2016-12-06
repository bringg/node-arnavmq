const assert = require('assert');
const producer = require('../src/index')().producer;
const consumer = require('../src/index')().consumer;
const utils = require('../src/modules/utils');
const uuid = require('node-uuid');
const docker = require('./docker');

const fixtures = {
  queues: ['test-queue-0', 'test-queue-1', 'test-queue-2', 'test-queue-3'],
  routingKey: 'queue-routing-key'
};

let letters = 0;

/* eslint func-names: "off" */
/* eslint prefer-arrow-callback: "off" */
describe('producer/consumer', function () {
  this.timeout(20000);

  before(docker.start);

  after(docker.stop);

  describe('msg delevering', () => {
    before(() =>
      consumer.consume(fixtures.queues[0], () => {
        letters -= 1;
      }).then(() =>
        consumer.consume(fixtures.queues[1], () => {
          letters -= 1;
        })
      )
    );

    it('should be able to consume message sended by producer to queue [test-queue-0]', () => {
      letters += 1;
      return producer.produce(fixtures.queues[0], { msg: uuid.v4() })
        .then(() => utils.timeoutPromise(300))
        .then(() => assert.equal(letters, 0));
    });

    it('should be able to consume message sended by producer to queue [test-queue-0] (no message)', () => {
      letters += 1;
      return producer.produce(fixtures.queues[0])
        .then(() => utils.timeoutPromise(300))
        .then(() => assert.equal(letters, 0));
    });

    it('should be able to consume message sended by producer to queue [test-queue-0] (null message)', () => {
      letters += 1;
      return producer.produce(fixtures.queues[0], null)
        .then(() => utils.timeoutPromise(300))
        .then(() => assert.equal(letters, 0));
    });

    it('should not be able to consume message sended by producer to queue [test-queue-1]', () => {
      letters += 1;
      return producer.produce(fixtures.queues[1], null)
        .then(() => utils.timeoutPromise(300))
        .then(() => assert.equal(letters, 0));
    });

    it('should be able to consume all message populated by producer to all queues [test-queue-0,' +
      ' test-queue-1, test-queue-2]', () => {
      const count = 100;
      const messages = [];
      letters += 200;

      for (let i = 0; i < count; i += 1) {
        messages.push(producer.produce(fixtures.queues[0], null));
        messages.push(producer.produce(fixtures.queues[1], null));
      }

      return Promise.all(messages)
        .then(() => utils.timeoutPromise(500))
        .then(() => assert.equal(letters, 0));
    });
  });

  describe('msg requeueing', () => {
    it('should be able to consume message, but throw error so the message is requeued again on queue [test-queue-0]',
     (done) => {
       let attempt = 3;

       consumer.consume(fixtures.queues[3], (msg) => {
         assert(typeof msg === 'object');

         attempt -= 1;
         if (!attempt) {
           return done();
         }
         throw new Error('Any kind of error');
       })
      .then(() => {
        producer.produce(fixtures.queues[3], { msg: uuid.v4() })
        .then((response) => {
          assert(response === true);
          letters += 1;
        });
      });
     });
  });

  describe('routing keys', () => {
    it('should be able to send a message to a rounting key exchange', () =>
      consumer.consume(fixtures.routingKey, (message) => {
        assert.equal(message.content, 'ok');
      })
      .then(() =>
        producer.produce(fixtures.rountingKey, { content: 'ok' }, { routingKey: 'route' })
      )
    );
  });

  describe('rpc timeouts', () => {
    it('should reject on timeout, if no answer received', () =>
      producer.produce('non-existing-queue', { msg: 'ok' }, { rpc: true, timeout: 1000 })
        .catch((e) => {
          assert.equal(e.message, 'Timeout reached');
        })
    );
  });
});
