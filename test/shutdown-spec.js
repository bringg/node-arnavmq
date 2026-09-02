/* eslint-disable no-underscore-dangle */
const assert = require('assert');
const sinon = require('sinon');
const EventEmitter = require('events');
const pDefer = require('p-defer');
const arnavmqConfigurator = require('../src/index');
const Consumer = require('../src/modules/consumer');
const Producer = require('../src/modules/producer');
const { Connection, ConnectionClosedError } = require('../src/modules/connection');
const { ArnavMQ } = require('../src/modules/arnavmq');
const { setLogger } = require('../src/modules/logger');
const utils = require('../src/modules/utils');

/**
 * A fake amqp.node channel good enough to drive consumer.js and producer.js without a broker: it
 * captures the per-queue consume() callback so tests can deliver fake messages into it directly,
 * and exposes spies for every broker call either module can make on a channel.
 */
function createFakeChannel() {
  const channel = new EventEmitter();
  channel.consumeFns = new Map();
  channel.assertQueue = sinon.stub().resolves({});
  channel.consume = sinon.stub().callsFake((queue, fn) => {
    channel.consumeFns.set(queue, fn);
    return Promise.resolve({ consumerTag: `fake-tag:${queue}:${channel.consumeFns.size}` });
  });
  channel.ack = sinon.stub();
  channel.reject = sinon.stub();
  channel.cancel = sinon.stub().resolves();
  channel.close = sinon.stub().resolves();
  channel.sendToQueue = sinon.stub().returns(true);
  channel.publish = sinon.stub().returns(true);
  return channel;
}

function createFakeConnection(channel, overrides = {}) {
  return {
    config: {
      prefetch: 5,
      timeout: 10,
      requeue: true,
      consumerSuffix: '',
      hostname: 'shutdown-fake-connection',
      rpcTimeout: 15000,
      ...overrides,
    },
    getChannel: sinon.stub().resolves(channel),
    getDefaultChannel: sinon.stub().resolves(channel),
    getConnection: sinon.stub().resolves({}),
  };
}

/** A fake channel + connection + Consumer wired together, for tests that don't need the broker. */
function newTestConsumer(overrides = {}) {
  const channel = createFakeChannel();
  const connection = createFakeConnection(channel, overrides);
  const consumer = new Consumer(connection);
  return { channel, connection, consumer };
}

function fakeMessage(content, properties = {}) {
  return {
    content: Buffer.from(JSON.stringify(content)),
    properties: { contentType: 'application/json', ...properties },
  };
}

/** Delivers `msg` into the consumeFunc consumer.js registered for `queue` on this fake channel. */
function deliver(channel, queue, msg) {
  const fn = channel.consumeFns.get(queue);
  assert(fn, `no consume callback captured for queue "${queue}" - was consume() awaited first?`);
  return fn(msg);
}

/**
 * basic.cancel by consumerTag for every subscription on `queue` on this consumer - a stand-in for
 * the removed public per-queue cancel(), for tests that need to cancel a single queue without a
 * full stop().
 */
async function cancelQueue(consumer, queue) {
  const subscriptions = consumer._subscriptions.filter((sub) => sub.queue === queue);
  await Promise.all(subscriptions.map((sub) => consumer._cancelSubscription(sub)));
}

/**
 * A Connection against the real broker, built from the exported class rather than the module's
 * singleton factory, so close() (which is terminal) never tears down what the other spec files use.
 */
function newConnection(overrides = {}) {
  return new Connection({
    host: 'amqp://localhost',
    hostname: 'shutdown-test',
    prefetch: 5,
    timeout: 10,
    requeue: true,
    consumerSuffix: '',
    producerMaxRetries: -1,
    rpcTimeout: 0,
    ...overrides,
  });
}

/** A fresh, isolated ArnavMQ + Connection pair against the real broker. */
function newArnavmq(overrides = {}) {
  return new ArnavMQ(newConnection(overrides));
}

/** The correlationId of the pending RPC waiter registered in amqpRPCQueues[queue], if any. */
function pendingCorrelationId(producer, queue) {
  return Object.keys(producer.amqpRPCQueues[queue] || {}).find((key) => key !== 'resQueuePromise');
}

/** A producer with one RPC request already published and waiting for its response. */
async function newPendingRpc(queue, overrides = {}) {
  const channel = createFakeChannel();
  const producer = new Producer(createFakeConnection(channel, overrides));
  const rpcPromise = producer.checkRpc(queue, 'payload', { rpc: true });
  await waitFor(() => !!pendingCorrelationId(producer, queue));
  return { channel, producer, rpcPromise };
}

/** Polls `predicate` every 20ms until truthy, or throws once `timeoutMs` elapses. */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`waitFor() timed out after ${timeoutMs}ms waiting for: ${predicate}`);
    }
    await utils.timeoutPromise(20);
  }
}

/**
 * Runs `fn` and resolves with its result, or with the error it threw. For work done inside a
 * consumer handler, where consumer.js swallows a throw into a reject+log and the test would
 * otherwise never see it.
 */
async function settled(fn) {
  try {
    return await fn();
  } catch (error) {
    return error;
  }
}

/** Resolves once close()'s cancel step has landed on every subscription registered on `mq`. */
function waitForCancelled(mq) {
  const subscriptions = mq.consumer._subscriptions;
  return waitFor(() => subscriptions.length > 0 && subscriptions.every((sub) => sub.cancelled));
}

/**
 * Resolves after one full turn of the event loop. Node reports unhandled rejections once the
 * microtask queue has drained, so draining microtasks alone (`await Promise.resolve()`, however
 * many times) never observes one, while a single turn always does - making this exact rather than
 * a sleep long enough to probably work. A sleep that turned out to be too short would report "no
 * unhandled rejection" and pass a test that should have failed.
 */
function nextTurn() {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Runs `fn` with every existing 'unhandledRejection' listener (mocha installs one that fails the
 * current test from underneath it) swapped out for a recorder, and returns what Node reported.
 * Lets a test assert on unhandled rejections itself, with its own message.
 */
async function recordUnhandledRejections(fn) {
  const existing = process.listeners('unhandledRejection');
  existing.forEach((listener) => process.removeListener('unhandledRejection', listener));

  const seen = [];
  const recorder = (error) => seen.push(error);
  process.on('unhandledRejection', recorder);
  try {
    await fn();
    await nextTurn(); // let Node report anything still unhandled
  } finally {
    process.removeListener('unhandledRejection', recorder);
    existing.forEach((listener) => process.on('unhandledRejection', listener));
  }

  return seen;
}

describe('graceful shutdown', () => {
  describe('subscription registry (consumer.js)', () => {
    const sandbox = sinon.createSandbox();
    afterEach(() => sandbox.restore());

    describe('against the real broker', () => {
      let arnavmq;
      let consumer;

      beforeEach(() => {
        arnavmq = arnavmqConfigurator();
        consumer = new Consumer(arnavmq.connection);
      });

      it('cancelling a queue cancels by consumerTag and never closes the shared channel', async () => {
        const queue = 'shutdown:cancel:no-close';
        await consumer.consume(queue, () => {});

        const record = consumer._subscriptions[0];
        assert(record.consumerTag, 'expected a consumerTag to have been assigned');
        const { channel } = record;
        const closeSpy = sandbox.spy(channel, 'close');
        const cancelSpy = sandbox.spy(channel, 'cancel');

        await cancelQueue(consumer, queue);

        sinon.assert.calledWith(cancelSpy, record.consumerTag);
        sinon.assert.notCalled(closeSpy);
        assert.strictEqual(record.cancelled, true);

        // the channel is shared and must still be usable by everyone else afterward
        await channel.checkQueue(queue);
      });

      // The test above proves cancelling a queue never closes the shared channel via a spy; this
      // proves the *consequence* end-to-end against the real broker - a live queueB consumer and a
      // live producer RPC round-trip both keep working concurrently with cancelling queueA, and
      // queueA itself really stops receiving.
      it('cancelling queueA leaves a concurrent queueB consumer and a producer RPC round-trip working', async () => {
        const queueA = 'shutdown:cancel:regression:a';
        const queueB = 'shutdown:cancel:regression:b';
        const rpcQueue = 'shutdown:cancel:regression:rpc';

        let countA = 0;
        let countB = 0;
        await consumer.consume(queueA, () => {
          countA += 1;
        });
        await consumer.consume(queueB, () => {
          countB += 1;
        });
        await consumer.consume(rpcQueue, () => 'pong');

        await arnavmq.producer.produce(queueA, { n: 1 });
        await waitFor(() => countA === 1);

        await cancelQueue(consumer, queueA);

        // concurrently with queueA being cancelled: queueB keeps consuming, an RPC round-trip keeps
        // working, and a further produce to the now-cancelled queueA must never be delivered.
        const [rpcResult] = await Promise.all([
          arnavmq.producer.produce(rpcQueue, { ping: true }, { rpc: true }),
          arnavmq.producer.produce(queueB, { n: 1 }),
          arnavmq.producer.produce(queueA, { n: 2 }),
        ]);
        await waitFor(() => countB === 1); // queueB keeps receiving after queueA was cancelled

        assert.strictEqual(rpcResult, 'pong', 'expected the RPC round-trip to keep working after cancelling queueA');
        assert.strictEqual(countA, 1, 'the cancelled queueA subscription must not receive further deliveries');
      });

      it('cancelling a record with no consumerTag yet just marks it cancelled', async () => {
        const queue = 'shutdown:cancel:no-tag-yet';
        sandbox.stub(consumer, '_initializeChannel').resolves(null);

        // subscribe() synchronously creates+registers the record before its first internal await,
        // so it is visible on the registry immediately even though the returned promise is still
        // pending (stuck in the retry loop because _initializeChannel always resolves null here).
        const subscribePromise = consumer.subscribe(queue, () => {});
        const record = consumer._subscriptions.find((r) => r.queue === queue);
        assert(record, 'expected a record to be registered synchronously by subscribe()');
        assert.strictEqual(record.consumerTag, null);

        await cancelQueue(consumer, queue);

        assert.strictEqual(record.cancelled, true);
        assert.strictEqual(await subscribePromise, false);
      });

      it("subscribe()'s retry loop stops once cancelled, without ever consuming", async () => {
        const queue = 'shutdown:retry:stop-on-cancel';
        arnavmqConfigurator({ timeout: 20 });
        const initStub = sandbox.stub(consumer, '_initializeChannel').resolves(null);

        const subscribePromise = consumer.subscribe(queue, () => {});
        const record = consumer._subscriptions.find((r) => r.queue === queue);
        assert(record, 'expected a record to be registered synchronously by subscribe()');

        await cancelQueue(consumer, queue);
        assert.strictEqual(await subscribePromise, false);

        const callCountAfterCancel = initStub.callCount;
        await utils.timeoutPromise(100);
        assert.strictEqual(
          initStub.callCount,
          callCountAfterCancel,
          'the retry loop kept calling _initializeChannel after the subscription was cancelled',
        );
      });

      // Resolving `false` here (as this used to) let a service that resubscribed after a shutdown
      // boot "successfully", report healthy and consume nothing for the rest of its life. publish()
      // already failed loudly on the same state.
      it('after stop(), subscribe() rejects instead of quietly resolving false', async () => {
        await consumer.stop();

        const initSpy = sandbox.spy(consumer, '_initializeChannel');

        await assert.rejects(() => consumer.subscribe('shutdown:after-cancel-all', () => {}), ConnectionClosedError);
        sinon.assert.notCalled(initSpy);
      });

      it('rejects a subscribe after the connection itself was closed, without a stop() first', async () => {
        const isolated = new Consumer(newConnection({ hostname: 'shutdown-subscribe-after-close' }));
        await isolated.connection.close();

        await assert.rejects(
          () => isolated.subscribe('shutdown:after-connection-close', () => {}),
          ConnectionClosedError,
        );
      });
    });

    describe('listener hygiene on the shared channel', () => {
      it('does not accumulate close listeners across repeated _initializeChannel calls for one record', async () => {
        const { channel: sharedChannel, consumer } = newTestConsumer();

        await consumer.consume('shared-channel-queue', () => {});
        const record = consumer._subscriptions[0];
        await consumer._initializeChannel(record);
        await consumer._initializeChannel(record);

        assert.strictEqual(sharedChannel.listenerCount('close'), 1);
      });

      it('the resubscribe-on-close listener is a no-op once shutting down / cancelled', async () => {
        const { channel: sharedChannel, consumer } = newTestConsumer();

        await consumer.consume('shutdown:onclose:guard', () => {});
        const record = consumer._subscriptions[0];
        const subscribeSpy = sinon.spy(consumer, '_subscribe');

        record.cancelled = true;
        sharedChannel.emit('close');

        sinon.assert.notCalled(subscribeSpy);
      });

      it('repeated subscribe->cancel cycles leave no listener and no record behind', async () => {
        const { channel: sharedChannel, consumer } = newTestConsumer();
        const queue = 'shutdown:cancel:listener-hygiene';

        for (let i = 0; i < 5; i += 1) {
          await consumer.consume(queue, () => {});
          await cancelQueue(consumer, queue);
        }

        assert.strictEqual(
          sharedChannel.listenerCount('close'),
          0,
          'cancelled subscriptions must not leave their resubscribe listener on the shared channel',
        );
        // ...and once cancelled+drained, the records themselves are dropped - otherwise repeated
        // subscribe->cancel cycles would grow the registry (and its retained callbacks/options)
        // without bound in a long-lived process.
        assert.strictEqual(
          consumer._subscriptions.length,
          0,
          'cancelled and drained records must not remain in the registry',
        );
      });
    });

    // `record.channel` is set inside _initializeChannel, but `record.consumerTag` only exists once
    // assertQueue+basic.consume have both round-tripped to the broker - a cancel landing in that
    // window must be re-checked once the tag arrives, or the subscription goes live anyway.
    describe('cancel landing mid-subscribe (before consumerTag exists)', () => {
      it('cancels the subscription on the broker once its tag arrives - two consume()s on one queue, the second cancelled mid-flight', async () => {
        const { channel, consumer } = newTestConsumer();
        const queue = 'shutdown:cancel:mid-flight';

        await consumer.consume(queue, () => {});
        const [first] = consumer._subscriptions;
        assert(first.consumerTag, 'expected the first subscription to be fully subscribed');

        // The second one is held inside channel.consume() - i.e. past _initializeChannel (so
        // record.channel is set) but before record.consumerTag exists.
        const consumeGate = pDefer();
        channel.consume = sinon.stub().callsFake(async (q, fn) => {
          await consumeGate.promise;
          channel.consumeFns.set(q, fn);
          return { consumerTag: 'mid-flight-tag' };
        });

        const subscribePromise = consumer.consume(queue, () => {});
        await waitFor(() => channel.consume.called); // it has reached the gated channel.consume()
        const second = consumer._subscriptions[1];
        assert(second, 'expected the second subscription to be registered');
        assert.strictEqual(second.consumerTag, null, 'expected it to be mid-flight, without a tag yet');

        // cancelling here can send nothing to the broker - there is no tag yet.
        await cancelQueue(consumer, queue);
        assert.strictEqual(second.cancelled, true);
        sinon.assert.neverCalledWith(channel.cancel, 'mid-flight-tag');

        // Now the broker answers the basic.consume. The tag exists, so the cancellation must be
        // carried out for real rather than silently dropped.
        consumeGate.resolve();
        assert.strictEqual(
          await subscribePromise,
          false,
          'a subscription cancelled mid-flight must not report success',
        );

        assert.strictEqual(second.consumerTag, 'mid-flight-tag');
        sinon.assert.calledWith(channel.cancel, 'mid-flight-tag');
        sinon.assert.calledWith(channel.cancel, first.consumerTag);
        sinon.assert.notCalled(channel.close);
      });

      it('skips the basic.consume round-trip entirely when the cancel lands before it (mid-assertQueue)', async () => {
        const { channel, consumer } = newTestConsumer();
        const queue = 'shutdown:cancel:mid-assert-queue';

        const assertGate = pDefer();
        channel.assertQueue = sinon.stub().callsFake(async () => {
          await assertGate.promise;
          return {};
        });

        const subscribePromise = consumer.subscribe(queue, () => {});
        await waitFor(() => channel.assertQueue.called); // it has reached the gated assertQueue()
        const record = consumer._subscriptions[0];
        assert(record.channel, 'expected _initializeChannel to have already attached the shared channel');
        assert.strictEqual(record.consumerTag, null);

        await cancelQueue(consumer, queue);
        assertGate.resolve();

        assert.strictEqual(
          await subscribePromise,
          false,
          'a subscription cancelled mid-flight must not report success',
        );
        sinon.assert.notCalled(channel.consume);
        assert.strictEqual(record.consumerTag, null);
      });
    });

    // A queue that cannot be declared as asked (PRECONDITION_FAILED from changed arguments,
    // ACCESS_REFUSED) is answered with a channel-level error, which kills the channel. Consuming on
    // it afterwards cannot work, so the declaration failing has to be treated as the subscription
    // failing - not logged and stepped over.
    describe('a subscription whose setup keeps failing', () => {
      function newFailingAssertConsumer() {
        const { channel, connection, consumer } = newTestConsumer({ timeout: 60 });
        channel.assertQueue = sinon.stub().callsFake(async () => {
          // what the broker actually does: channel-level error, so the channel dies with it
          channel.emit('close');
          throw new Error('PRECONDITION_FAILED - inequivalent arg durable');
        });
        return { channel, connection, consumer };
      }

      it('retries behind the configured backoff instead of once per broker round-trip', async () => {
        const { connection, consumer } = newFailingAssertConsumer();

        consumer.subscribe('shutdown:setup-failure:backoff', () => {}).catch(() => {});
        await utils.timeoutPromise(400);

        // ~400ms at a 60ms backoff is a handful of attempts. Unbounded, this opened a fresh channel
        // per round-trip - measured at ~660/s against a real broker - and two competing retry
        // loops would instead double every cycle.
        const attempts = connection.getChannel.callCount;
        assert(attempts > 1, 'expected it to keep retrying');
        assert(attempts < 15, `expected the backoff to bound the retries, got ${attempts} channels in 400ms`);
      });

      it('never resolves true - the subscription is not consuming', async () => {
        const { consumer } = newFailingAssertConsumer();

        const settled = await Promise.race([
          consumer.subscribe('shutdown:setup-failure:never-true', () => {}).then((value) => ({ value })),
          utils.timeoutPromise(300).then(() => 'still-pending'),
        ]);

        assert.strictEqual(
          settled,
          'still-pending',
          `expected subscribe() to stay pending, it settled: ${JSON.stringify(settled)}`,
        );
      });

      it('resolves false when the broker refuses the basic.consume itself', async () => {
        const { channel, consumer } = newTestConsumer();
        channel.consume = sinon.stub().rejects(new Error('ACCESS_REFUSED - consume'));

        // Unlike a dead channel there is nothing to retry against here, so the caller is told
        // plainly rather than the failure being logged and reported as success.
        assert.strictEqual(await consumer.subscribe('shutdown:setup-failure:consume-refused', () => {}), false);
      });
    });

    describe('in-flight tracking', () => {
      it('inFlight() brackets both the ack path and the reject path', async () => {
        const { channel, consumer } = newTestConsumer();

        const ackQueue = 'shutdown:inflight:ack-path';
        let observedDuringAckHandler = null;
        await consumer.consume(ackQueue, () => {
          observedDuringAckHandler = consumer.inFlight();
          return 'ok';
        });

        assert.strictEqual(consumer.inFlight(), 0);
        await deliver(channel, ackQueue, fakeMessage({ a: 1 }));
        assert.strictEqual(observedDuringAckHandler, 1, 'expected inFlight() to be 1 while the handler runs');
        assert.strictEqual(consumer.inFlight(), 0, 'expected inFlight() back to 0 once acked');
        sinon.assert.calledOnce(channel.ack);

        const rejectQueue = 'shutdown:inflight:reject-path';
        let observedDuringRejectHandler = null;
        await consumer.consume(rejectQueue, () => {
          observedDuringRejectHandler = consumer.inFlight();
          throw new Error('boom');
        });

        await deliver(channel, rejectQueue, fakeMessage({ a: 1 }));
        assert.strictEqual(observedDuringRejectHandler, 1, 'expected inFlight() to be 1 while the handler runs');
        assert.strictEqual(consumer.inFlight(), 0, 'expected inFlight() back to 0 once rejected');
        sinon.assert.calledOnce(channel.reject);
      });

      it('reports the requeue to the after-process hook, so the delivery is not invisible', async () => {
        const { channel, consumer } = newTestConsumer();
        const queue = 'shutdown:inflight:buffered-hook';
        const payloads = [];
        consumer.hooks.afterProcessMessage((payload) => payloads.push(payload));

        await consumer.consume(queue, () => 'ok');
        consumer._subscriptions[0].cancelled = true;

        const msg = fakeMessage({ a: 1 });
        await deliver(channel, queue, msg);

        // Without this event a caller's received and completed counters silently disagree by every
        // message the broker had buffered under prefetch when the shutdown started.
        assert.strictEqual(payloads.length, 1);
        assert.strictEqual(payloads[0].queue, queue);
        assert.strictEqual(payloads[0].message, msg);
        assert.strictEqual(payloads[0].requeued, true);
        assert.strictEqual(payloads[0].rejectError, undefined);
      });

      it('rejects+requeues a buffered message without running the handler once the subscription is no longer live', async () => {
        const { channel, consumer } = newTestConsumer();
        const queue = 'shutdown:inflight:buffered-after-cancel';
        let handlerCalls = 0;

        await consumer.consume(queue, () => {
          handlerCalls += 1;
          return 'ok';
        });
        const record = consumer._subscriptions[0];
        record.cancelled = true; // simulates a delivery buffered before cancel-ok landed

        await deliver(channel, queue, fakeMessage({ a: 1 }));

        assert.strictEqual(handlerCalls, 0, 'the handler must not run for a message delivered after cancel');
        assert.strictEqual(consumer.inFlight(), 0);
        sinon.assert.calledOnce(channel.reject);
        sinon.assert.calledWith(channel.reject, sinon.match.any, true);
        sinon.assert.notCalled(channel.ack);
      });
    });

    describe('_drain()', () => {
      it('resolves immediately when nothing is in flight', async () => {
        const { consumer } = newTestConsumer();
        await consumer.consume('shutdown:drain:empty', () => 'ok');

        await consumer._drain();
      });

      it('resolves once the in-flight handler finishes, and cancels nothing', async () => {
        const { channel, consumer } = newTestConsumer();
        const queue = 'shutdown:drain:waits-then-resolves';
        const handlerDefer = pDefer();

        await consumer.consume(queue, () => handlerDefer.promise);
        const deliverPromise = deliver(channel, queue, fakeMessage({ a: 1 }));

        assert.strictEqual(consumer.inFlight(), 1);
        const drainPromise = consumer._drain();

        handlerDefer.resolve('ok');
        await deliverPromise;

        await drainPromise;
        sinon.assert.notCalled(channel.cancel);
      });

      it('does not resolve while a handler is still running', async () => {
        const { channel, consumer } = newTestConsumer();
        const queue = 'shutdown:drain:waits-indefinitely';
        const handlerDefer = pDefer();

        await consumer.consume(queue, () => handlerDefer.promise);
        const deliverPromise = deliver(channel, queue, fakeMessage({ a: 1 }));

        let drained = false;
        consumer._drain().then(() => {
          drained = true;
        });

        await utils.timeoutPromise(150);
        assert.strictEqual(drained, false, 'expected _drain() to still be waiting on the in-flight handler');

        handlerDefer.resolve('ok');
        await deliverPromise;
      });
    });

    describe('stop()', () => {
      it('cancels every subscription then resolves once nothing is in flight', async () => {
        const { channel, consumer } = newTestConsumer();
        const queue = 'shutdown:stop:clean';

        await consumer.consume(queue, () => 'ok');

        await consumer.stop();
        sinon.assert.called(channel.cancel);
        sinon.assert.notCalled(channel.close);
      });

      it('is idempotent - concurrent calls share one in-flight shutdown', async () => {
        const { channel, consumer } = newTestConsumer();
        await consumer.consume('shutdown:stop:idempotent', () => 'ok');

        await Promise.all([consumer.stop(), consumer.stop()]);

        sinon.assert.calledOnce(channel.cancel);
      });

      it('waits out a slow handler rather than abandoning it', async () => {
        const { channel, consumer } = newTestConsumer();
        const queue = 'shutdown:stop:waits-for-slow-handler';
        const handlerDefer = pDefer();

        await consumer.consume(queue, () => handlerDefer.promise);
        const deliverPromise = deliver(channel, queue, fakeMessage({ a: 1 }));

        let stopped = false;
        const stopPromise = consumer.stop().then(() => {
          stopped = true;
        });

        await utils.timeoutPromise(150);
        assert.strictEqual(stopped, false, 'expected stop() to still be waiting on the in-flight handler');
        sinon.assert.notCalled(channel.reject);

        handlerDefer.resolve('ok');
        await deliverPromise;
        await stopPromise;

        sinon.assert.calledOnce(channel.ack);
        sinon.assert.notCalled(channel.reject);
      });
    });

    it('inFlight() counts across all queues', async () => {
      const { channel, consumer } = newTestConsumer();
      const queueA = 'shutdown:inflight:scope-a';
      const queueB = 'shutdown:inflight:scope-b';
      const deferA = pDefer();
      const deferB = pDefer();

      await consumer.consume(queueA, () => deferA.promise);
      await consumer.consume(queueB, () => deferB.promise);

      const deliverA = deliver(channel, queueA, fakeMessage({ a: 1 }));
      const deliverB = deliver(channel, queueB, fakeMessage({ b: 1 }));

      assert.strictEqual(consumer.inFlight(), 2);

      deferA.resolve('ok');
      deferB.resolve('ok');
      await Promise.all([deliverA, deliverB]);

      assert.strictEqual(consumer.inFlight(), 0);
    });
  });

  describe('connection.js', () => {
    const sandbox = sinon.createSandbox();
    afterEach(() => sandbox.restore());

    it('isClosed is false before close() and true as soon as close() is invoked, before it resolves', () => {
      const conn = newConnection();
      assert.strictEqual(conn.isClosed, false);

      const closePromise = conn.close();
      assert.strictEqual(conn.isClosed, true, 'expected isClosed to flip synchronously, before any await in close()');

      return closePromise;
    });

    describe('close()', () => {
      it('resolves cleanly when no connection was ever established', async () => {
        const conn = newConnection();
        await conn.close();
        assert.strictEqual(conn.isClosed, true);
      });

      it('closes the underlying amqp connection exactly once on sequential double-close', async () => {
        const conn = newConnection();
        const amqpConnection = await conn.getConnection();
        const closeSpy = sandbox.spy(amqpConnection, 'close');

        await conn.close();
        await conn.close();

        sinon.assert.calledOnce(closeSpy);
        assert.strictEqual(conn.isClosed, true);
      });

      it('is idempotent under concurrent double-close - both calls share one close, no unhandled rejection', async () => {
        const conn = newConnection();
        const amqpConnection = await conn.getConnection();
        const closeSpy = sandbox.spy(amqpConnection, 'close');

        const [first, second] = await Promise.all([conn.close(), conn.close()]);

        assert.strictEqual(first, undefined);
        assert.strictEqual(second, undefined);
        sinon.assert.calledOnce(closeSpy);
        assert.strictEqual(conn.isClosed, true);
      });

      it("doesn't race an in-flight connect - awaits it, lets it resolve, then closes that connection", async () => {
        const conn = newConnection();

        const connectPromise = conn.getConnection(); // connect kicked off, not yet resolved
        const closePromise = conn.close(); // close() must not tear down the in-flight connect

        const amqpConnection = await connectPromise;
        assert(amqpConnection, 'expected the in-flight connect to still resolve with a connection');

        await closePromise;

        assert.strictEqual(conn.isClosed, true);
      });

      it('logs and swallows an in-flight connect that fails while close() is waiting on it', async () => {
        const fakeLogger = { debug: sinon.stub(), info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };
        setLogger(fakeLogger);
        try {
          // nothing is listening on 5673, so this connect fails on its own while close() awaits it
          const conn = newConnection({ host: 'amqp://localhost:5673' });
          const connectPromise = conn.getConnection();
          const closePromise = conn.close();

          await Promise.all([assert.rejects(() => connectPromise), closePromise]); // close() must not reject

          assert.strictEqual(conn.isClosed, true);
          sinon.assert.calledWithMatch(fakeLogger.debug, {
            message: sinon.match(/in-flight connection attempt while closing/),
          });
        } finally {
          setLogger(utils.emptyLogger);
        }
      });

      it('swallows errors from closing an already-broken socket instead of rejecting', async () => {
        const conn = newConnection();
        const amqpConnection = await conn.getConnection();
        sandbox.stub(amqpConnection, 'close').rejects(new Error('socket already gone'));

        await conn.close(); // must not throw
        assert.strictEqual(conn.isClosed, true);
      });

      // `channel.ack()`/`channel.reject()` are fire-and-forget in AMQP 0-9-1, so dropping the socket
      // straight away can lose them to the broker's requeue-on-disconnect cleanup. `Channel.Close`
      // round-trips, so closing every channel first is the barrier that guarantees the broker
      // processed them.
      it('gracefully closes every cached channel before closing the socket', async () => {
        const conn = newConnection({ prefetch: 5 });
        const amqpConnection = await conn.getConnection();
        const defaultChannel = await conn.getDefaultChannel();
        const customChannel = await conn.getChannel('shutdown:connection:custom-prefetch', { prefetch: 2 });
        assert.notStrictEqual(defaultChannel, customChannel, 'expected the custom prefetch to get its own channel');

        const defaultCloseSpy = sandbox.spy(defaultChannel, 'close');
        const customCloseSpy = sandbox.spy(customChannel, 'close');
        const connectionCloseSpy = sandbox.spy(amqpConnection, 'close');

        await conn.close();

        sinon.assert.calledOnce(defaultCloseSpy);
        sinon.assert.calledOnce(customCloseSpy);
        sinon.assert.callOrder(defaultCloseSpy, connectionCloseSpy);
        sinon.assert.callOrder(customCloseSpy, connectionCloseSpy);
      });

      it('closes the remaining channels and the socket even when one channel fails to close', async () => {
        const conn = newConnection({ prefetch: 5 });
        const amqpConnection = await conn.getConnection();
        const goodChannel = await conn.getDefaultChannel();
        const badChannel = await conn.getChannel('shutdown:connection:bad-channel', { prefetch: 2 });

        const goodCloseSpy = sandbox.spy(goodChannel, 'close');
        sandbox.stub(badChannel, 'close').rejects(new Error('channel already gone'));
        const connectionCloseSpy = sandbox.spy(amqpConnection, 'close');

        await conn.close(); // must not throw

        sinon.assert.calledOnce(goodCloseSpy);
        sinon.assert.calledOnce(connectionCloseSpy);
        assert.strictEqual(conn.isClosed, true);
      });

      // The channel-close barrier is best-effort and has to be capped, or one wedged channel means a
      // pod that never exits. Both tests below wedge a different step of it.
      async function assertClosesByWaitingOutTheCap(conn, what) {
        const amqpConnection = await conn.getConnection();
        const connectionCloseSpy = sandbox.spy(amqpConnection, 'close');

        const start = Date.now();
        await conn.close();
        const elapsed = Date.now() - start;

        sinon.assert.calledOnce(connectionCloseSpy);
        assert.strictEqual(conn.isClosed, true);
        assert(elapsed >= 4000, `expected close() to actually wait out the cap, took only ${elapsed}ms`);
        assert(elapsed < 15000, `expected close() to give up on the ${what}, took ${elapsed}ms`);
      }

      it('gives up on a channel that never confirms its close rather than hanging shutdown forever', async () => {
        const conn = newConnection();
        const channel = await conn.getDefaultChannel();
        // amqplib leaves `channel.close()` pending forever if the Channel.Close-Ok never arrives - the
        // socket dying mid-handshake does not settle it, nor does a simultaneous server-side close.
        sandbox.stub(channel, 'close').returns(new Promise(() => {}));

        await assertClosesByWaitingOutTheCap(conn, 'wedged channel');
      });

      it('gives up on a channel whose creation never finishes rather than hanging shutdown forever', async () => {
        const conn = newConnection();
        await conn.getConnection();

        // A cache entry still pending when shutdown starts - a channel allocated moments earlier whose
        // Channel.Open-Ok/Basic.Qos-Ok never arrived from a broker that stopped answering while its TCP
        // connection stayed up. The cap has to cover awaiting the entry itself, not just close().
        conn._channels._channels.set('never-opens', { chann: new Promise(() => {}), config: { prefetch: 5 } });

        await assertClosesByWaitingOutTheCap(conn, 'never-opened channel');
      });
    });

    describe('channel listener registration', () => {
      it("attaches the channel's error/close listeners before awaiting prefetch", async () => {
        const conn = newConnection({ prefetch: 5 });
        const amqpConnection = await conn.getConnection();

        const fakeChannel = new EventEmitter();
        const prefetchGate = pDefer();
        fakeChannel.prefetch = sinon.stub().returns(prefetchGate.promise);
        fakeChannel.close = sinon.stub().resolves();
        sandbox.stub(amqpConnection, 'createChannel').resolves(fakeChannel);

        const channelPromise = conn.getDefaultChannel();
        // wait until we are inside the prefetch round-trip, with the channel allocated but qos pending
        await waitFor(() => fakeChannel.prefetch.called);

        assert.strictEqual(fakeChannel.listenerCount('error'), 1, "expected the 'error' listener on before prefetch");
        assert.strictEqual(fakeChannel.listenerCount('close'), 1, "expected the 'close' listener on before prefetch");
        // The actual hazard: amqplib routes a server-sent Channel.Close through safeEmit(ch,'error'),
        // which rethrows when nothing is listening - out of its frame handler, into an uncaught
        // exception that kills the process. With the listener already on, this emit is absorbed.
        assert.doesNotThrow(() => fakeChannel.emit('error', new Error('Channel closed by server: simulated')));

        prefetchGate.resolve();
        assert.strictEqual(await channelPromise, fakeChannel);

        await conn.close();
      });
    });

    describe('getConnection() after close()', () => {
      it('rejects with ConnectionClosedError, and does not attempt to reconnect', async () => {
        const conn = newConnection();
        await conn.getConnection();
        await conn.close();

        await assert.rejects(() => conn.getConnection(), ConnectionClosedError);
      });

      it('also rejects for a connection that was never connected before close()', async () => {
        const conn = newConnection();
        await conn.close();

        await assert.rejects(() => conn.getConnection(), ConnectionClosedError);
      });

      it('getChannel()/getDefaultChannel() built on getConnection() also reject with ConnectionClosedError', async () => {
        const conn = newConnection();
        await conn.getConnection();
        await conn.close();

        await assert.rejects(() => conn.getDefaultChannel(), ConnectionClosedError);
        await assert.rejects(() => conn.getChannel('any-queue', {}), ConnectionClosedError);
      });
    });

    describe('close() landing between getConnection() and the channel-cache check', () => {
      // getChannel()/getDefaultChannel() each do `await getConnection()` then touch `_channels`.
      // close() can run entirely inside that gap: it flips `isClosed` synchronously, snapshots and
      // clears the channel cache in closeAll(), and closes the socket. Without a re-check of
      // isClosed right after getConnection() resolves, the resumed call would insert a brand new
      // channel into the (now-cleared) cache that closeAll() already walked past - a channel never
      // protected by the Channel.Close-Ok barrier, escaping into a connection that's tearing down.
      function driveCloseIntoTheGap(conn) {
        const originalGetConnection = conn.getConnection.bind(conn);
        sandbox.stub(conn, 'getConnection').callsFake(async () => {
          const result = await originalGetConnection();
          await conn.close();
          return result;
        });
      }

      const accessors = {
        'getChannel()': (conn) => conn.getChannel('some-queue', {}),
        'getDefaultChannel()': (conn) => conn.getDefaultChannel(),
      };

      Object.entries(accessors).forEach(([name, getChannel]) => {
        it(`${name} rejects with ConnectionClosedError instead of creating an orphan channel`, async () => {
          const conn = newConnection();
          const amqpConnection = await conn.getConnection();
          const createChannelSpy = sandbox.spy(amqpConnection, 'createChannel');

          driveCloseIntoTheGap(conn);

          await assert.rejects(() => getChannel(conn), ConnectionClosedError);
          sinon.assert.notCalled(createChannelSpy);
        });
      });
    });
  });

  // Closing a channel is what makes every pending RPC request unanswerable, so producer.js hangs
  // one listener on it and rejects its waiters from there. That covers a graceful close() and a
  // socket that died on its own with the same code, and replaces the per-RPC-queue listener that
  // used to fire-and-forget a queue rebuild.
  describe('producer.js channel-close listener', () => {
    const sandbox = sinon.createSandbox();
    afterEach(() => sandbox.restore());

    it('rejects a pending RPC promise with ConnectionClosedError instead of waiting out rpcTimeout', async () => {
      const { channel, rpcPromise } = await newPendingRpc('shutdown:producer-close:pending');

      channel.emit('close');

      await assert.rejects(() => rpcPromise, ConnectionClosedError);
    });

    it('clears the pending timeout so no lingering timer keeps the process alive', async () => {
      const clearTimeoutSpy = sandbox.spy(global, 'clearTimeout');
      const queue = 'shutdown:producer-close:clear-timeout';
      const { channel, producer, rpcPromise } = await newPendingRpc(queue);

      const { timeoutId } = producer.amqpRPCQueues[queue][pendingCorrelationId(producer, queue)];
      assert(timeoutId, 'expected a timer to have been scheduled for the pending RPC');

      channel.emit('close');

      sinon.assert.calledWith(clearTimeoutSpy, timeoutId);
      await assert.rejects(() => rpcPromise, ConnectionClosedError);
    });

    it('drops the dead reply-queue bookkeeping, so the next RPC publish rebuilds it', async () => {
      const queue = 'shutdown:producer-close:resqueue-rebuilt';
      const { channel, producer, rpcPromise } = await newPendingRpc(queue);
      assert(producer.amqpRPCQueues[queue].resQueuePromise, 'expected a reply queue to have been set up');

      channel.emit('close');
      await assert.rejects(() => rpcPromise, ConnectionClosedError);

      // The reply queue was exclusive to the connection that just went away, so keeping its promise
      // would hand every later RPC a replyTo naming a queue that no longer exists.
      assert.strictEqual(producer.amqpRPCQueues[queue], undefined);
      assert(await producer.createRpcQueue(queue), 'expected the next RPC publish to rebuild the reply queue');
    });

    it('is idempotent - a second close does not throw or double-reject', async () => {
      const { channel, rpcPromise } = await newPendingRpc('shutdown:producer-close:idempotent');

      channel.emit('close');
      channel.emit('close');

      await assert.rejects(() => rpcPromise, ConnectionClosedError);
    });

    // The listener has to be re-armed on each new channel (a reconnect gets a fresh one), which the
    // remove-then-add in _initializeRpcQueue does - without piling up one listener per RPC queue on
    // the channel every consumer and the reply path share.
    it('stays at exactly one listener on the channel however many RPC queues are initialized', async () => {
      const channel = createFakeChannel();
      const producer = new Producer(createFakeConnection(channel));

      await producer.createRpcQueue('shutdown:producer-close:listeners:a');
      await producer.createRpcQueue('shutdown:producer-close:listeners:b');
      await producer.createRpcQueue('shutdown:producer-close:listeners:c');

      assert.strictEqual(channel.listenerCount('close'), 1);
    });

    it('createRpcQueue() stops retrying once getDefaultChannel rejects with ConnectionClosedError', async () => {
      const connection = createFakeConnection(createFakeChannel());
      connection.getDefaultChannel = sinon.stub().rejects(new ConnectionClosedError());
      const producer = new Producer(connection);
      const timeoutSpy = sandbox.spy(utils, 'timeoutPromise');

      const result = await producer.createRpcQueue('shutdown:producer-close:closed-from-start');

      // one attempt, then the guard stops it: no internal retry-loop recursion, no delay-then-retry.
      assert.strictEqual(result, undefined);
      sinon.assert.notCalled(timeoutSpy);
      sinon.assert.calledOnce(connection.getDefaultChannel);
    });

    // checkRpc() registers the waiter *before* awaiting the publish and only attaches its own
    // handler (`return await responsePromise.promise`) after it. A close landing in that window
    // rejects a deferred nobody is listening to yet, and a rejection left unhandled for a full turn
    // of the loop is fatal under Node's default `--unhandled-rejections=throw`. Note the `settled`
    // handler below is on checkRpc()'s own promise, a different promise than the deferred, and does
    // not mask this.
    it('a close landing while the RPC publish is still in flight does not leave the rejection unhandled', async () => {
      const channel = createFakeChannel();
      const publishGate = pDefer();
      // A publish that is a real round-trip rather than a microtask, so the window is actually open.
      channel.sendToQueue = sinon.stub().callsFake(() => publishGate.promise);
      const producer = new Producer(createFakeConnection(channel));
      const queue = 'shutdown:producer-close:publish-window';

      let settled;
      const seen = await recordUnhandledRejections(async () => {
        const rpcPromise = producer.checkRpc(queue, 'payload', { rpc: true });
        settled = rpcPromise.then(
          () => undefined,
          (error) => error,
        );

        await waitFor(() => channel.sendToQueue.called);
        assert(pendingCorrelationId(producer, queue), 'expected the waiter to be registered');

        channel.emit('close');
        await nextTurn(); // the turn in which Node would report the rejection as unhandled

        publishGate.resolve(true); // now let the publish finish, so checkRpc() reaches its await
      });

      assert.deepStrictEqual(
        seen.map((error) => error && error.message),
        [],
        'expected no unhandled rejection while the close raced the in-flight publish',
      );
      assert((await settled) instanceof ConnectionClosedError, 'expected the rejection to still reach the caller');
    });

    it('deletes the waiter when the publish itself fails, so nothing is left in the registry', async () => {
      const channel = createFakeChannel();
      channel.sendToQueue = sinon.stub().rejects(new Error('broker blip'));
      const producer = new Producer(createFakeConnection(channel));
      const queue = 'shutdown:producer-close:publish-failed';

      await assert.rejects(() => producer.checkRpc(queue, 'payload', { rpc: true }), /broker blip/);

      // Left behind, the entry can never be settled - prepareTimeoutRpc() was never reached, so it
      // has no timer - and it would leak until the channel finally closed.
      assert.strictEqual(
        pendingCorrelationId(producer, queue),
        undefined,
        'expected no orphaned RPC waiter after a failed publish',
      );
    });

    // The sweep drops the whole per-queue entry, and checkRpc() has two awaits between creating that
    // entry and registering its waiter in it. A close landing in between used to leave checkRpc()
    // indexing a key that was gone, so the caller got a TypeError instead of the publish's own
    // retryable error - and with retries capped, a real message failed for the wrong reason.
    it('survives a close landing between createRpcQueue() and the waiter registration', async () => {
      const channel = createFakeChannel();
      channel.sendToQueue = sinon.stub().callsFake(() => {
        throw new Error('Channel closed');
      });
      const producer = new Producer(createFakeConnection(channel));
      const queue = 'shutdown:producer-close:setup-window';

      // drive the close into the window, exactly once
      const createRpcQueue = producer.createRpcQueue.bind(producer);
      let dropped = false;
      producer.createRpcQueue = async (q) => {
        const resQueue = await createRpcQueue(q);
        if (!dropped) {
          dropped = true;
          channel.emit('close');
        }
        return resQueue;
      };

      await assert.rejects(() => producer.checkRpc(queue, 'payload', { rpc: true }), /Channel closed/);

      // The publish's own error is what the caller must see: unlike ConnectionClosedError it is
      // retryable, so _sendToQueue reconnects and republishes rather than losing the request.
      assert.strictEqual(
        pendingCorrelationId(producer, queue),
        undefined,
        'expected no orphaned RPC waiter after the failed publish',
      );
    });

    // The win from putting this on the channel rather than in close(): the same code covers a
    // connection that died on its own. amqplib routes every teardown through
    // Connection.toClosed() -> _closeChannels() -> Channel.toClosed(), which emits 'close' on every
    // channel - so a broker that goes away no longer leaves RPC callers hanging out rpcTimeout, or
    // forever with rpcTimeout: 0.
    it('rejects pending RPC waiters when the socket dies on its own, not just on close()', async () => {
      // rpcTimeout: 0 arms no timer at all, so only the channel-close listener can settle this
      const connection = newConnection({ hostname: 'shutdown-producer-socket-death', rpcTimeout: 0 });
      const mq = new ArnavMQ(connection);
      const queue = 'shutdown:producer-close:socket-death';
      // deliberately unconsumed - only the channel-close listener can ever settle this

      const rpcPromise = mq.publish(queue, { ping: true }, { rpc: true });
      await waitFor(() => !!pendingCorrelationId(mq.producer, queue));

      // destroy(err) so the socket emits 'error', which is what amqplib wires its teardown to
      // (along with 'end'). A bare destroy() emits only 'close', which amqplib does not listen for.
      const amqpConnection = await connection.getConnection();
      (amqpConnection.stream || amqpConnection.connection.stream).destroy(new Error('ECONNRESET (simulated)'));

      await assert.rejects(() => rpcPromise, ConnectionClosedError);
      assert.strictEqual(connection.isClosed, false, 'this was a drop, not a close() - isClosed stays false');
      await connection.close();
    });
  });

  // src/modules/arnavmq.js's top-level close() orchestrates, in order: cancel -> drain ->
  // connection.close(). Nothing else - failing pending RPC waiters falls out of closing the
  // connection, via producer.js's channel-close listener.
  describe('arnavmq.js close() orchestration', () => {
    const sandbox = sinon.createSandbox();
    afterEach(() => sandbox.restore());

    describe('the object returned by the top-level factory', () => {
      it('exposes close(), connection.close()/isClosed, and the additive consumer sub-API', () => {
        const arnavmq = arnavmqConfigurator();

        assert.strictEqual(typeof arnavmq.close, 'function');
        assert.strictEqual(typeof arnavmq.connection.close, 'function');
        assert.strictEqual(typeof arnavmq.connection.isClosed, 'boolean');
        assert.strictEqual(typeof arnavmq.consumer.consume, 'function');
        assert.strictEqual(typeof arnavmq.consumer.subscribe, 'function');
        assert.strictEqual(typeof arnavmq.consumer.inFlight, 'function');
      });

      it('does not expose cancel/stop/drain on the consumer sub-API - close() is the only public shutdown entry point', () => {
        const arnavmq = arnavmqConfigurator();

        assert.strictEqual(arnavmq.consumer.cancel, undefined);
        assert.strictEqual(arnavmq.consumer.stop, undefined);
        assert.strictEqual(arnavmq.consumer.drain, undefined);
        assert.strictEqual(arnavmq.producer.stop, undefined);
      });

      // `instanceof ConnectionClosedError` is how close()'s contract expects callers to detect the
      // shutting-down rejection - it has to actually be constructible at runtime.
      it('exposes ConnectionClosedError on the package entry point, usable with new and instanceof', () => {
        assert.strictEqual(arnavmqConfigurator.ConnectionClosedError, ConnectionClosedError);
        assert(
          new arnavmqConfigurator.ConnectionClosedError() instanceof arnavmqConfigurator.ConnectionClosedError,
          'expected require("arnavmq").ConnectionClosedError to be a real, constructible class',
        );
      });
    });

    it('cancels the subscription, drains the in-flight handler, lets it ack, then closes the connection', async () => {
      const arnavmq = newArnavmq();
      const queue = 'shutdown:arnavmq-close:cancel-drain-ack';
      const gate = pDefer();
      let callCount = 0;

      await arnavmq.subscribe(queue, async () => {
        callCount += 1;
        await gate.promise;
      });

      await arnavmq.publish(queue, { n: 1 });
      await waitFor(() => arnavmq.consumer.inFlight() === 1);

      const closePromise = arnavmq.close();
      await waitForCancelled(arnavmq); // cancelled, now draining

      assert.strictEqual(arnavmq.connection.isClosed, false, 'connection must stay open while draining');
      assert.strictEqual(callCount, 1);

      gate.resolve();
      assert.strictEqual(await closePromise, undefined);

      assert.strictEqual(callCount, 1, 'the cancelled subscription must not receive a second delivery');
      assert.strictEqual(arnavmq.connection.isClosed, true);
    });

    it('does not resolve while an in-flight handler is still running, and waits for it rather than abandoning it', async () => {
      const arnavmq = newArnavmq();
      const queue = 'shutdown:arnavmq-close:waits-for-slow-handler';
      const gate = pDefer();

      await arnavmq.subscribe(queue, async () => {
        await gate.promise;
      });

      await arnavmq.publish(queue, { n: 1 });
      await waitFor(() => arnavmq.consumer.inFlight() === 1);

      let closed = false;
      const closePromise = arnavmq.close().then(() => {
        closed = true;
      });

      await utils.timeoutPromise(150);
      assert.strictEqual(closed, false, 'expected close() to still be waiting on the in-flight handler');
      assert.strictEqual(arnavmq.connection.isClosed, false);

      gate.resolve();
      await closePromise;
      assert.strictEqual(arnavmq.connection.isClosed, true);
    });

    it('a handler can publish during the drain, and publishing only fails once close() has resolved', async () => {
      const arnavmq = newArnavmq();
      const queue = 'shutdown:arnavmq-close:producer-order';
      const sideQueue = 'shutdown:arnavmq-close:producer-order:side';
      const proceedGate = pDefer();
      const publishSettled = pDefer();

      await arnavmq.subscribe(queue, async () => {
        await proceedGate.promise;
        publishSettled.resolve(await settled(() => arnavmq.publish(sideQueue, { ok: true })));
      });

      await arnavmq.publish(queue, { n: 1 });
      await waitFor(() => arnavmq.consumer.inFlight() === 1);

      const closePromise = arnavmq.close();
      await waitForCancelled(arnavmq); // cancelled, now draining; the handler is still gated

      assert.strictEqual(arnavmq.connection.isClosed, false, 'connection must still be open mid-drain');

      proceedGate.resolve(); // let the handler publish downstream while the connection is still open
      const publishOutcome = await publishSettled.promise;

      assert(!(publishOutcome instanceof Error), `expected a publish during the drain to succeed: ${publishOutcome}`);
      assert.strictEqual(
        arnavmq.connection.isClosed,
        false,
        'connection should still be open right after that publish resolved',
      );

      await closePromise;
      assert.strictEqual(arnavmq.connection.isClosed, true);

      await assert.rejects(() => arnavmq.publish(sideQueue, { late: true }), ConnectionClosedError);
    });

    it('is idempotent - repeated close() calls do not re-run the sequence or throw', async () => {
      const arnavmq = newArnavmq();
      const queue = 'shutdown:arnavmq-close:idempotent';
      await arnavmq.subscribe(queue, () => {});

      const cancelAllSpy = sandbox.spy(arnavmq.consumer, '_cancelAll');
      const connectionCloseSpy = sandbox.spy(arnavmq.connection, 'close');

      await Promise.all([arnavmq.close(), arnavmq.close()]);
      await arnavmq.close();

      assert.strictEqual(arnavmq.connection.isClosed, true);
      // consumer.stop() memoizes its own shutdown promise, so _cancelAll() only actually runs once
      // no matter how many times the top-level close() calls into it.
      sinon.assert.calledOnce(cancelAllSpy);
      // the top-level close() itself is called 3 times above and must not throw on any of them.
      sinon.assert.calledThrice(connectionCloseSpy);
    });

    // A drained handler's `channel.ack()` is fire-and-forget on the wire, so tearing the raw
    // connection down right after it races that ack against the broker's requeue-everything-
    // still-unacked cleanup. `Channels.closeAll()` (awaited by `Connection._close()` before the
    // socket goes) is the barrier that removes the race - `Channel.Close` round-trips, so the broker
    // has demonstrably processed the ack by the time close() returns.
    it('a cleanly drained+acked message is never redelivered to a fresh instance after close()', async () => {
      const arnavmq = newArnavmq();
      const queue = 'shutdown:arnavmq-close:no-redelivery';

      // Start from a known-empty queue: a message left behind by an earlier failing run of this very
      // test would be indistinguishable from the redelivery this test is looking for.
      const setupChannel = await arnavmq.connection.getDefaultChannel();
      await setupChannel.assertQueue(queue, { durable: true });
      await setupChannel.purgeQueue(queue);

      const gate = pDefer();
      let callCount = 0;
      await arnavmq.subscribe(queue, async () => {
        callCount += 1;
        await gate.promise;
      });

      await arnavmq.publish(queue, { n: 1 });
      await waitFor(() => arnavmq.consumer.inFlight() === 1);

      const closePromise = arnavmq.close();
      await waitForCancelled(arnavmq); // cancelled, now draining; the handler is gated
      gate.resolve(); // handler finishes and acks
      await closePromise;

      assert.strictEqual(callCount, 1);
      assert.strictEqual(arnavmq.connection.isClosed, true);

      // The actual proof, from outside the closed instance: an independent ArnavMQ+Connection pair on
      // the same queue must never be handed that message. Any broker-side requeue would have happened
      // when the first instance's connection dropped - i.e. before this one even connects - so a
      // redelivery lands as soon as this consumer registers, well inside the window below.
      const fresh = newArnavmq();
      let redelivered;
      await fresh.subscribe(queue, (body) => {
        redelivered = body;
      });
      await utils.timeoutPromise(1500);

      assert.strictEqual(
        redelivered,
        undefined,
        `expected the acked message to be gone for good, but it was redelivered: ${JSON.stringify(redelivered)}`,
      );

      await fresh.close();
    });

    // _cancelAll() must mark every record cancelled before the channel's/connection's own 'close'
    // event fires, or the onChannelClose listener would try to resubscribe against a connection
    // that's being torn down.
    it('after close(), _consumeQueue is never invoked again - no resubscribe fight with the closing connection', async () => {
      const arnavmq = newArnavmq();
      const queue = 'shutdown:arnavmq-close:no-resubscribe-fight';
      await arnavmq.subscribe(queue, () => {});

      const consumeQueueSpy = sandbox.spy(arnavmq.consumer, '_consumeQueue');

      await arnavmq.close();

      // give any 'close' event fired by the now-dead channel/connection a moment to propagate - if
      // the shutting-down/cancelled guard on the resubscribe listener were missing or ordered wrong,
      // this is when a resubscribe attempt (and another _consumeQueue call) would happen.
      await utils.timeoutPromise(200);

      sinon.assert.notCalled(consumeQueueSpy);
      assert.strictEqual(arnavmq.connection.isClosed, true);
    });

    it('a pending RPC call rejects when close() runs, instead of hanging for rpcTimeout', async () => {
      const arnavmq = newArnavmq({ rpcTimeout: 15000 });
      const queue = 'shutdown:arnavmq-close:pending-rpc';
      // deliberately no consumer subscribed on `queue` - this RPC call never gets answered on its own.

      const rpcPromise = arnavmq.publish(queue, { ping: true }, { rpc: true });
      await waitFor(() => !!pendingCorrelationId(arnavmq.producer, queue));

      // Attach the rejection expectation *before/alongside* close(), not after awaiting it: the
      // waiter is rejected from the channel-close listener partway through connection.close(),
      // before close() itself resolves. Awaiting close() to completion first and only then
      // attaching a handler to rpcPromise leaves it unhandled across a real async gap, which trips
      // Node's unhandledRejection detection - a test-harness ordering issue, not a bug in close().
      const start = Date.now();
      await Promise.all([arnavmq.close(), assert.rejects(() => rpcPromise, ConnectionClosedError)]);
      const elapsed = Date.now() - start;

      assert(
        elapsed < 5000,
        `expected close() to resolve quickly rather than waiting out rpcTimeout, took ${elapsed}ms`,
      );
    });

    // A draining handler has to be able to finish its work, which includes answering an RPC request
    // it had already received. consumer.js's checkRpc() writes the reply straight to the channel,
    // and the connection stays open for the whole drain, so this keeps working.
    //
    // The caller is a separate instance so that closing the server cannot settle the caller's own
    // waiter as a side effect - that would prove nothing about the reply actually arriving.
    it('a draining handler can still answer an RPC request it had already received', async () => {
      const server = newArnavmq();
      const caller = newArnavmq({ hostname: 'shutdown-arnavmq-close-test-caller', rpcTimeout: 15000 });
      const queue = 'shutdown:arnavmq-close:reply-while-draining';

      const proceedGate = pDefer();
      await server.subscribe(queue, async () => {
        await proceedGate.promise;
        return { pong: true };
      });

      const callerPromise = caller.publish(queue, { ping: true }, { rpc: true });
      await waitFor(() => server.consumer.inFlight() === 1);

      const closePromise = server.close();
      await waitForCancelled(server); // cancelled, now draining; the handler is still gated
      assert.strictEqual(server.connection.isClosed, false, 'connection must still be open mid-drain');

      proceedGate.resolve(); // the handler returns, and checkRpc() writes the reply
      assert.deepStrictEqual(await callerPromise, { pong: true });

      await closePromise;
      assert.strictEqual(server.connection.isClosed, true);
      await caller.close();
    });

    // The connection stays open for the whole drain, so everything a handler starts still works:
    // a plain publish, and a brand new RPC request that gets a real answer. There is no producer
    // shutdown flag turning these away any more.
    it('during the drain a handler can still publish and still complete a new RPC round-trip', async () => {
      const app = newArnavmq();
      const peer = newArnavmq({ hostname: 'shutdown-arnavmq-close-test-peer' });
      const queue = 'shutdown:arnavmq-close:work-while-draining';
      const sideQueue = 'shutdown:arnavmq-close:work-while-draining:side';
      const rpcQueue = 'shutdown:arnavmq-close:work-while-draining:rpc';

      await peer.subscribe(rpcQueue, () => ({ pong: true }));

      const proceedGate = pDefer();
      const outcomes = pDefer();
      await app.subscribe(queue, async () => {
        await proceedGate.promise;
        outcomes.resolve({
          plain: await settled(() => app.publish(sideQueue, { plain: true })),
          rpc: await settled(() => app.publish(rpcQueue, { ping: true }, { rpc: true })),
        });
      });

      await app.publish(queue, { n: 1 });
      await waitFor(() => app.consumer.inFlight() === 1);

      const closePromise = app.close();
      await waitForCancelled(app); // cancelled, now draining; the handler is still gated
      proceedGate.resolve();

      const result = await outcomes.promise;
      assert(!(result.plain instanceof Error), `expected a plain publish to still succeed, got ${result.plain}`);
      assert.deepStrictEqual(result.rpc, { pong: true }, `expected the RPC to be answered, got ${result.rpc}`);

      await closePromise;
      assert.strictEqual(app.connection.isClosed, true);
      await peer.close();
    });
  });
});
