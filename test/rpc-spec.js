const assert = require('assert');
const producer = require('../src/index')().producer;
const consumer = require('../src/index')().consumer;
const uuid = require('node-uuid');
const docker = require('./docker');
const utils = require('../src/modules/utils');

const fixtures = {
  queues: ['rpc-queue-0', 'rpc-queue-1', 'rpc-queue-2', 'rpc-queue-3']
};

/* eslint func-names: "off" */
/* eslint prefer-arrow-callback: "off" */
describe('Producer/Consumer RPC messaging:', function () {
  this.timeout(20000);

  before(docker.start);

  after(docker.stop);

  it('should be able to create a consumer that returns a message if called as RPC [rpc-queue-0]', () =>
    consumer.consume(fixtures.queues[0], () =>
      'Power Ranger Red'
    )
    .then((created) => {
      assert(created === true);
    })
  );

  it('should be able to send directly to the queue, without correlationId and not crash [rpc-queue-0]', () =>
    producer.produce(fixtures.queues[0], { nothing: true }, { rpc: true })
      .then(() =>
        producer.produce(`${fixtures.queues[0]}:${producer.conn.config.hostname}:res`, { nothing: true })
      )
      .then(utils.timeoutPromise(500))
  );

  it('should be able to produce a RPC message and get a response [rpc-queue-0]', () =>
    producer.produce(fixtures.queues[0], { msg: uuid.v4() }, { rpc: true })
    .then((response) => {
      assert.equal(response, 'Power Ranger Red');
    })
  );

  /* eslint no-labels: "off" */
  /* eslint no-restricted-syntax: "off" */
  /* eslint no-unused-labels: "off" */
  /* eslint no-unused-expressions: "off" */
  it('should be able to produce a RPC message and get a as JSON [rpc-queue-1]', () =>
    consumer.consume(fixtures.queues[1],
      function () {
        return { powerRangerColor: 'Pink' };
      })
    .then(() =>
      producer.produce(fixtures.queues[1], { msg: uuid.v4() }, { rpc: true })
    )
    .then((response) => {
      assert.equal(typeof response, 'object');
      assert.equal(response.powerRangerColor, 'Pink');
    })
  );

  it('should be able to produce a RPC message and get undefined response [rpc-queue-2]', () =>
    consumer.consume(fixtures.queues[2], () => undefined)
    .then(() => producer.produce(fixtures.queues[2], undefined, { rpc: true }))
    .then((response) => {
      assert(response === undefined, 'Got a response !== undefined');
    })
  );

  it('should be able to produce a RPC message and get null response [rpc-queue-3]', () =>
    consumer.consume(fixtures.queues[3], () => null)
    .then(() =>
      producer.produce(fixtures.queues[3], undefined, { rpc: true }))
    .then((response) => {
      assert(response === null, 'Got a response !== null');
    })
  );
});
