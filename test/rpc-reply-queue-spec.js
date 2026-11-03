/* eslint-disable no-underscore-dangle */
const assert = require('assert');
const amqplib = require('amqplib');
const sinon = require('sinon');
const pDefer = require('p-defer');
const { Connection } = require('../src/modules/connection');
const { ArnavMQ } = require('../src/modules/arnavmq');
const utils = require('../src/modules/utils');

const HOST = 'amqp://localhost';
const HOSTNAME = 'reply-queue-test';
const RPC_TIMEOUT = 400;

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

    it('rejects with Timeout reached within rpcTimeout when setup can never succeed, without retrying', async () => {
      sandbox.stub(arnavmq.producer, '_replyQueueName').returns(lockedName);
      const startedAt = Date.now();

      await assert.rejects(() => arnavmq.publish(queue, { n: 1 }, { rpc: true, timeout: RPC_TIMEOUT }), {
        message: 'Timeout reached',
      });

      const elapsed = Date.now() - startedAt;
      assert(elapsed >= RPC_TIMEOUT - 50, `rejected too early: ${elapsed}ms`);
      assert(elapsed < RPC_TIMEOUT + 1500, `rejected too late: ${elapsed}ms`);
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

  describe('reply queue setup that keeps failing', () => {
    let locked;
    let failedAttempts;

    // Every name is the locked one while `locked` is true, so each declare is refused.
    beforeEach(() => {
      locked = true;
      failedAttempts = 0;
      const realName = arnavmq.producer._replyQueueName.bind(arnavmq.producer);
      sandbox.stub(arnavmq.producer, '_replyQueueName').callsFake((q) => {
        if (locked) {
          failedAttempts += 1;
          return lockedName;
        }
        return realName(q);
      });
    });

    it('lets timed-out callers go, keeps the longer ones waiting, and answers them once setup succeeds', async () => {
      const long = arnavmq.publish(queue, { n: 1 }, { rpc: true, timeout: 5000 });
      const short = arnavmq.publish(queue, { n: 2 }, { rpc: true, timeout: 200 });

      await assert.rejects(() => short, { message: 'Timeout reached' });

      const { waiters } = arnavmq.producer.amqpRPCQueues[queue].replyQueue;
      assert.strictEqual(waiters.size, 1, 'only the caller still waiting stays registered');

      locked = false;
      assert.strictEqual(await long, 'answer');
    });

    it('lets an RPC arriving during the backoff join the running setup instead of starting another', async () => {
      arnavmq.connection.config.timeout = 300;
      const replyTos = [];
      await arnavmq.consumer.consume(`${queue}:echo`, (msg, properties) => {
        replyTos.push(properties.replyTo);
        return 'echo';
      });
      const rpc = () => arnavmq.publish(`${queue}:echo`, {}, { rpc: true, timeout: 5000 });

      const first = rpc();
      await utils.timeoutPromise(50); // inside the first backoff
      assert.strictEqual(failedAttempts, 1);
      const second = rpc();
      await utils.timeoutPromise(100); // still inside the 300 ms backoff, still locked
      // a second, concurrent setup would have made its own declare attempt by now
      assert.strictEqual(failedAttempts, 1);
      locked = false;

      assert.deepStrictEqual(await Promise.all([first, second]), ['echo', 'echo']);
      // a second concurrent setup would have declared and consumed a second reply queue
      assert.strictEqual(replyTos.length, 2);
      assert.strictEqual(replyTos[1], replyTos[0]);
    });
  });

  describe('timeout given as a string', () => {
    it('is honoured as a number of milliseconds', async () => {
      await arnavmq.consumer.consume(`${queue}:slow`, async () => {
        await utils.timeoutPromise(100);
        return 'slow';
      });

      const response = await arnavmq.publish(`${queue}:slow`, {}, { rpc: true, timeout: '3000' });

      assert.strictEqual(response, 'slow');
    });
  });

  describe('closing while the reply queue setup is failing', () => {
    it('stops the setup at once instead of sleeping out the retry backoff', async () => {
      arnavmq.connection.config.timeout = 5000;
      const declare = pDefer();
      const defaultChannel = await arnavmq.connection.getDefaultChannel();
      sandbox.stub(defaultChannel, 'assertQueue').callsFake(() => declare.promise);
      // handler attached up front: setup rejects right after close() and env.js rethrows unhandled rejections
      const setup = arnavmq.producer.createRpcQueue(queue).then(
        () => 'resolved',
        (error) => error,
      );
      await utils.timeoutPromise(100); // the declare is now in flight

      await arnavmq.close();
      declare.reject(new Error('channel closed under the declare'));

      const result = await Promise.race([setup, utils.timeoutPromise(1000).then(() => 'still retrying')]);
      assert.ok(result instanceof ConnectionClosedError);
    });
  });
});
