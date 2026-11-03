/* eslint-disable no-underscore-dangle */
const assert = require('assert');
const amqplib = require('amqplib');
const sinon = require('sinon');
const { Connection } = require('../src/modules/connection');
const { ArnavMQ } = require('../src/modules/arnavmq');

const HOST = 'amqp://localhost';
const HOSTNAME = 'reply-queue-test';

function newArnavmq(overrides = {}) {
  return new ArnavMQ(
    new Connection({
      host: HOST,
      hostname: HOSTNAME,
      prefetch: 5,
      timeout: 10,
      requeue: true,
      consumerSuffix: '',
      producerMaxRetries: -1,
      rpcTimeout: 0,
      ...overrides,
    }),
  );
}

describe('RPC reply queue', () => {
  const sandbox = sinon.createSandbox();
  let arnavmq;
  let holder; // second raw connection, holds the exclusive queue the broker will refuse to re-declare
  let holderChannel;
  let queue;
  let lockedName;
  let queueCounter = 0;

  beforeEach(async () => {
    queueCounter += 1;
    queue = `rpc-reply-queue-spec-${process.pid}-${queueCounter}`;
    lockedName = `${queue}:locked:res`;
    arnavmq = newArnavmq();

    holder = await amqplib.connect(HOST);
    holderChannel = await holder.createChannel();
    await holderChannel.assertQueue(lockedName, { durable: true, exclusive: true });

    await arnavmq.consumer.consume(queue, () => 'answer');
  });

  afterEach(async () => {
    sandbox.restore();
    await arnavmq.close();
    await holder.close();
  });

  /** The first reply-queue name handed out is the locked one, the following ones are real. */
  function lockFirstReplyQueueName() {
    const realName = arnavmq.producer._replyQueueName.bind(arnavmq.producer);
    sandbox
      .stub(arnavmq.producer, '_replyQueueName')
      .onFirstCall()
      .returns(lockedName)
      .callsFake((q) => realName(q));
  }

  describe('when the broker refuses the reply queue declaration with RESOURCE_LOCKED', () => {
    it('still answers the RPC, using a different name', async () => {
      lockFirstReplyQueueName();

      const response = await arnavmq.publish(queue, { n: 1 }, { rpc: true, timeout: 5000 });

      assert.strictEqual(response, 'answer');
      assert.notStrictEqual(await arnavmq.producer.createRpcQueue(queue), lockedName);
    });
  });

  describe('reply queue name', () => {
    const echoQueue = () => `${queue}:echo`;
    let replyTos;

    beforeEach(async () => {
      replyTos = [];
      await arnavmq.consumer.consume(echoQueue(), (msg, properties) => {
        replyTos.push(properties.replyTo);
        return 'echo';
      });
    });

    const rpc = () => arnavmq.publish(echoQueue(), {}, { rpc: true, timeout: 5000 });

    it('is reused, and consumed again, when the default channel is lost', async () => {
      const pattern = new RegExp(`^${queue}:echo:${HOSTNAME}:${process.pid}:[0-9a-f]{8}:res$`);

      await rpc();
      const defaultChannel = await arnavmq.connection.getDefaultChannel();
      await defaultChannel.close();
      assert.strictEqual(await rpc(), 'echo');

      assert.strictEqual(replyTos.length, 2);
      assert.match(replyTos[0], pattern);
      assert.strictEqual(replyTos[1], replyTos[0]);
      // exclusive queues refuse other connections, so ask over the same connection, on a throwaway channel
      const probe = await (await arnavmq.connection.getConnection()).createChannel();
      const { consumerCount } = await probe.checkQueue(replyTos[0]);
      assert.strictEqual(consumerCount, 1);
    });

    it('is new once the connection is lost', async () => {
      await rpc();
      await (await arnavmq.connection.getConnection()).close();
      assert.strictEqual(await rpc(), 'echo');

      assert.strictEqual(replyTos.length, 2);
      assert.notStrictEqual(replyTos[1], replyTos[0]);
    });
  });
});
