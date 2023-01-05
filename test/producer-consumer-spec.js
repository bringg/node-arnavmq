const assert = require('assert');
const uuid = require('uuid');
const arnavmq = require('../src/index')();
const utils = require('../src/modules/utils');
const docker = require('./docker');

const fixtures = {
  queues: ['test-queue-0', 'test-queue-1', 'test-queue-2', 'test-queue-3', 'test-queue-4', 'test-queue-5'],
  routingKey: 'queue-routing-key'
};

let letters = 0;

/* eslint func-names: "off" */
/* eslint prefer-arrow-callback: "off" */
describe('producer/consumer', function () {
  before(docker.rm);
  before(() => docker.run().then(docker.start));
  describe('msg delevering', () => {
    before(() => arnavmq.consumer.consume(fixtures.queues[0], () => {
      letters -= 1;
    }).then(() => arnavmq.consumer.consume(fixtures.queues[1], () => {
      letters -= 1;
    })));

    it('should receive message that is only string', () => {
      const queueName = 'test-only-string-queue';
      return arnavmq.consumer.consume(queueName, (message) => Promise.resolve(`${message}-test`))
        .then(() => arnavmq.producer.produce(queueName, '85.69.30.121', { rpc: true }))
        .then((result) => {
          assert.equal(result, '85.69.30.121-test');
        });
    });

    it('should receive message that is only array', () => {
      const queueName = 'test-only-array-queue';
      return arnavmq.consumer.consume(queueName, (message) => Promise.resolve({ message }))
        .then(() => arnavmq.producer.produce(queueName, [1, '2'], { rpc: true }))
        .then((result) => {
          assert.deepEqual(result, { message: [1, '2'] });
        });
    });

    it('should receive message headers', () => {
      const headers = { header1: 'Header1', header2: 'Header2' };
      const queueName = 'test-headers';
      return arnavmq.consumer.consume(queueName, (message, properties) => Promise.resolve({ message, properties }))
        .then(() => arnavmq.producer.produce(queueName, [1, '2'], { rpc: true, headers }))
        .then((result) => {
          assert.deepEqual(result.message, [1, '2']);
          assert.deepEqual(result.properties.headers, headers);
        });
    });

    it('should receive message properties', () => {
      const queueName = 'test-headers';
      return arnavmq.consumer.consume(queueName, (message, properties) => Promise.resolve({ message, properties }))
        .then(() => arnavmq.producer.produce(queueName, [1, '2'], { rpc: true }))
        .then((result) => {
          assert.deepEqual(result.message, [1, '2']);
          assert.deepEqual(result.properties.contentType, 'application/json');
        });
    });

    it('should receive contentLength property', () => {
      const queueName = 'test-headers';
      const payload = { a: 1 };
      const messageSize = Buffer.byteLength(JSON.stringify(payload));
      return arnavmq.consumer.consume(queueName, (message, properties) => Promise.resolve({ message, properties }))
        .then(() => arnavmq.producer.produce(queueName, payload, { rpc: true }))
        .then((result) => {
          assert.deepEqual(result.message, payload);
          assert.deepEqual(result.properties.contentType, 'application/json');
          assert.deepEqual(result.properties.contentLength, messageSize);
        });
    });

    it('should be able to consume message sent by producer to queue [test-queue-0]', () => {
      letters += 1;
      return arnavmq.producer.produce(fixtures.queues[0], { msg: uuid.v4() })
        .then(() => utils.timeoutPromise(300))
        .then(() => assert.equal(letters, 0));
    });

    it('should be able to consume message sent by producer to queue [test-queue-0] (no message)', () => {
      letters += 1;
      return arnavmq.producer.produce(fixtures.queues[0])
        .then(() => utils.timeoutPromise(300))
        .then(() => assert.equal(letters, 0));
    });

    it('should be able to consume message sent by producer to queue [test-queue-0] (null message)', () => {
      letters += 1;
      return arnavmq.producer.produce(fixtures.queues[0], null)
        .then(() => utils.timeoutPromise(300))
        .then(() => assert.equal(letters, 0));
    });

    it('should not be able to consume message sent by producer to queue [test-queue-1]', () => {
      letters += 1;
      return arnavmq.producer.produce(fixtures.queues[1], null)
        .then(() => utils.timeoutPromise(300))
        .then(() => assert.equal(letters, 0));
    });

    it('should be able to consume all message populated by producer to all queues [test-queue-0,'
      + ' test-queue-1, test-queue-2]', () => {
      const count = 100;
      const messages = [];
      letters += 200;

      for (let i = 0; i < count; i += 1) {
        messages.push(arnavmq.producer.produce(fixtures.queues[0], null));
        messages.push(arnavmq.producer.produce(fixtures.queues[1], null));
      }

      return Promise.all(messages)
        .then(() => utils.timeoutPromise(500))
        .then(() => assert.equal(letters, 0));
    });
  });

  describe('msg requeueing', () => {
    it('should requeue the message again on error [test-queue-0]', (done) => {
      let attempt = 3;

      arnavmq.consumer.consume(fixtures.queues[3], (msg) => {
        assert(typeof msg === 'object');

        attempt -= 1;
        if (!attempt) {
          return done();
        }
        throw new Error('Any kind of error');
      })
        .then(() => arnavmq.producer.produce(fixtures.queues[3], { msg: uuid.v4() })
          .then((response) => {
            assert(response === true);
            letters += 1;
          })).catch(done);
    });
  });

  describe('routing keys', () => {
    it('should be able to send a message to a rounting key exchange', () => arnavmq.consumer.consume(fixtures.routingKey, (message) => {
      assert.equal(message.content, 'ok');
    }).then(() => arnavmq.producer.produce(fixtures.rountingKey, { content: 'ok' }, { routingKey: 'route' })));
  });

  describe('rpc timeouts', () => {
    it('should reject on timeout, if no answer received', () => arnavmq.producer.produce('non-existing-queue', { msg: 'ok' }, { rpc: true, timeout: 1000 })
      .catch((e) => {
        assert.equal(e.message, 'Timeout reached');
      }));

    it('should reject on default timeout, if no answer received', () => {
      arnavmq.connection._config.rpcTimeout = 1000;
      arnavmq.producer.produce('non-existing-queue', { msg: 'ok' }, { rpc: true })
        .catch((e) => {
          assert.equal(e.message, 'Timeout reached');
        });
    });

    it('should not deliver message if timeout is reached ', (done) => {
      // (prefetch + 1) messages will be sent. The last one doesn't have to be consumed as it has to be discarded while waiting in the queue
      let receivedCounter = 0;
      const numMsgsToSend = arnavmq.connection._config.prefetch + 1;
      arnavmq.consumer.consume(fixtures.queues[5], () => {
        receivedCounter += 1;
        return utils.timeoutPromise(500);
      })
        .then(() => Promise.all(Array.from({ length: numMsgsToSend }, (v, k) => arnavmq.producer.produce(fixtures.queues[5], { a: k }, { rpc: true, timeout: 200 }))))
        .catch(() => {
          // last message promise is rejected due to timeout. Let's wait a sec to be sure that message hasn't been consumed
          setTimeout(() => {
            assert.equal(receivedCounter, numMsgsToSend - 1);
            done();
          }, 1000);
        });
    });
  });

  describe('error', () => {
    it('should not be consumed', (done) => {
      arnavmq.consumer.consume(fixtures.queues[4], () => ({ error: new Error('Error test') }))
        .then(() => arnavmq.producer.produce(fixtures.queues[4], {}, { rpc: true }))
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

    it('should receive message', () => {
      arnavmq.consumer.consume('queue-name-undefined-suffix', (message) => {
        assert.equal(message.msg, 'test for undefined queue suffix');
      }).then(() => arnavmq.producer.produce('queue-name-undefined-suffix', {
        msg: 'test for undefined queue suffix'
      }));
    });
  });
});
