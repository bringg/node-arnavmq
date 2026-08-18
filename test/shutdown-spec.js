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
 * A fake amqp.node channel good enough to drive consumer.js without a broker: it captures the
 * per-queue consume() callback so tests can deliver fake messages into it directly, and exposes
 * spies for every broker call consumer.js can make on a channel.
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
  return channel;
}

function createFakeConnection(channel, overrides = {}) {
  return {
    config: { prefetch: 5, timeout: 10, requeue: true, consumerSuffix: '', ...overrides },
    getChannel: sinon.stub().resolves(channel),
    getDefaultChannel: sinon.stub().resolves(channel),
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

/** A fake amqp.node channel good enough to drive producer.js's RPC path without a broker. */
function createFakeChannelForRpc() {
  const channel = new EventEmitter();
  channel.assertQueue = sinon.stub().resolves({});
  channel.consume = sinon.stub().resolves({ consumerTag: 'fake-tag' });
  channel.sendToQueue = sinon.stub().returns(true);
  channel.publish = sinon.stub().returns(true);
  return channel;
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

      it('cancel() cancels by consumerTag and never closes the shared channel', async () => {
        const queue = 'shutdown:cancel:no-close';
        await consumer.consume(queue, () => {});

        const record = [...consumer._subscriptions.values()][0];
        assert(record.consumerTag, 'expected a consumerTag to have been assigned');
        const { channel } = record;
        const closeSpy = sandbox.spy(channel, 'close');
        const cancelSpy = sandbox.spy(channel, 'cancel');

        await consumer.cancel(queue);

        sinon.assert.calledWith(cancelSpy, record.consumerTag);
        sinon.assert.notCalled(closeSpy);
        assert.strictEqual(record.cancelled, true);

        // the channel is shared and must still be usable by everyone else afterward
        await channel.checkQueue(queue);
      });

      // The test above proves cancel() never closes the shared channel via a spy; this proves the
      // *consequence* end-to-end against the real broker - a live queueB consumer and a live
      // producer RPC round-trip both keep working concurrently with cancelling queueA, and queueA
      // itself really stops receiving.
      it('cancel(queueA) stops A while a concurrent queueB consumer and a producer RPC call keep working (regression: cancel by tag, never close the shared channel)', async () => {
        const queueA = 'shutdown:cancel:regression:a';
        const queueB = 'shutdown:cancel:regression:b';
        const rpcQueue = 'shutdown:cancel:regression:rpc';

        let countA = 0;
        let countB = 0;
        await arnavmq.consumer.consume(queueA, () => {
          countA += 1;
        });
        await arnavmq.consumer.consume(queueB, () => {
          countB += 1;
        });
        await arnavmq.consumer.consume(rpcQueue, () => 'pong');

        await arnavmq.producer.produce(queueA, { n: 1 });
        await utils.timeoutPromise(300);
        assert.strictEqual(countA, 1, 'expected queueA to receive its message before being cancelled');

        await arnavmq.consumer.cancel(queueA);

        // concurrently with queueA being cancelled: queueB keeps consuming, an RPC round-trip keeps
        // working, and a further produce to the now-cancelled queueA must never be delivered.
        const [rpcResult] = await Promise.all([
          arnavmq.producer.produce(rpcQueue, { ping: true }, { rpc: true }),
          arnavmq.producer.produce(queueB, { n: 1 }),
          arnavmq.producer.produce(queueA, { n: 2 }),
        ]);
        await utils.timeoutPromise(300);

        assert.strictEqual(rpcResult, 'pong', 'expected the RPC round-trip to keep working after cancelling queueA');
        assert.strictEqual(countB, 1, 'expected queueB to keep receiving messages after cancelling queueA');
        assert.strictEqual(countA, 1, 'the cancelled queueA subscription must not receive further deliveries');
      });

      it('cancel()/cancelAll() on a record with no consumerTag yet just marks it cancelled', async () => {
        const queue = 'shutdown:cancel:no-tag-yet';
        sandbox.stub(consumer, '_initializeChannel').resolves(null);

        // subscribe() synchronously creates+registers the record before its first internal await,
        // so it is visible on the registry immediately even though the returned promise is still
        // pending (stuck in the retry loop because _initializeChannel always resolves null here).
        const subscribePromise = consumer.subscribe(queue, () => {});
        const record = [...consumer._subscriptions.values()].find((r) => r.queue === queue);
        assert(record, 'expected a record to be registered synchronously by subscribe()');
        assert.strictEqual(record.consumerTag, null);

        await consumer.cancel(queue);

        assert.strictEqual(record.cancelled, true);
        assert.strictEqual(await subscribePromise, false);
      });

      it("subscribe()'s retry loop stops once cancelled, without ever consuming", async () => {
        const queue = 'shutdown:retry:stop-on-cancel';
        arnavmqConfigurator({ timeout: 20 });
        const initStub = sandbox.stub(consumer, '_initializeChannel').resolves(null);

        const subscribePromise = consumer.subscribe(queue, () => {});
        const record = [...consumer._subscriptions.values()].find((r) => r.queue === queue);
        assert(record, 'expected a record to be registered synchronously by subscribe()');

        await consumer.cancel(queue);
        assert.strictEqual(await subscribePromise, false);

        const callCountAfterCancel = initStub.callCount;
        await utils.timeoutPromise(100);
        assert.strictEqual(
          initStub.callCount,
          callCountAfterCancel,
          'the retry loop kept calling _initializeChannel after the subscription was cancelled',
        );
      });

      it('cancelAll() sets _shuttingDown so even brand-new subscribe() calls never consume', async () => {
        await consumer.cancelAll();
        assert.strictEqual(consumer._shuttingDown, true);

        const initSpy = sandbox.spy(consumer, '_initializeChannel');
        const result = await consumer.subscribe('shutdown:after-cancel-all', () => {});

        assert.strictEqual(result, false);
        sinon.assert.notCalled(initSpy);
      });
    });

    describe('listener hygiene on the shared channel', () => {
      it('does not accumulate close listeners across repeated _initializeChannel calls for one record', async () => {
        const { channel: sharedChannel, consumer } = newTestConsumer();
        const record = {
          id: 1,
          queue: 'shared-channel-queue',
          options: { channel: {} },
          callback: () => {},
          channel: null,
          consumerTag: null,
          onChannelClose: null,
          cancelled: false,
          inFlightMessages: new Set(),
          abandonedMessages: new Set(),
        };

        await consumer._initializeChannel(record);
        await consumer._initializeChannel(record);
        await consumer._initializeChannel(record);

        assert.strictEqual(sharedChannel.listenerCount('close'), 1);
      });

      it('the resubscribe-on-close listener is a no-op once shutting down / cancelled', async () => {
        const { channel: sharedChannel, consumer } = newTestConsumer();

        await consumer.consume('shutdown:onclose:guard', () => {});
        const record = [...consumer._subscriptions.values()][0];
        const subscribeSpy = sinon.spy(consumer, '_subscribe');

        record.cancelled = true;
        sharedChannel.emit('close');

        sinon.assert.notCalled(subscribeSpy);
      });

      it('_cancelSubscription removes the record close listener, so repeated subscribe->cancel cycles do not leak listeners', async () => {
        const { channel: sharedChannel, consumer } = newTestConsumer();
        const queue = 'shutdown:cancel:listener-hygiene';

        for (let i = 0; i < 5; i += 1) {
          await consumer.consume(queue, () => {});
          await consumer.cancel(queue);
        }

        assert.strictEqual(
          sharedChannel.listenerCount('close'),
          0,
          'cancelled subscriptions must not leave their resubscribe listener on the shared channel',
        );
        // ...but the records themselves stay: _abandonInFlightMessages()/inFlight() still read them.
        assert.strictEqual(consumer._subscriptions.length, 5, 'cancelled records must remain in the registry');
      });
    });

    // `record.channel` is set inside _initializeChannel, but `record.consumerTag` only exists once
    // assertQueue+basic.consume have both round-tripped to the broker - a cancel() landing in that
    // window must be re-checked once the tag arrives, or the subscription goes live anyway.
    describe('cancel() landing mid-subscribe (before consumerTag exists)', () => {
      it('cancels the subscription on the broker once its tag arrives - two consume()s on one queue, the second cancelled mid-flight', async () => {
        const { channel, consumer } = newTestConsumer();
        const queue = 'shutdown:cancel:mid-flight';

        await consumer.consume(queue, () => {});
        const [first] = [...consumer._subscriptions.values()];
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
        await utils.timeoutPromise(20); // let it reach the gated channel.consume()
        const second = [...consumer._subscriptions.values()][1];
        assert(second, 'expected the second subscription to be registered');
        assert.strictEqual(second.consumerTag, null, 'expected it to be mid-flight, without a tag yet');
        sinon.assert.called(channel.consume);

        // cancel() here can send nothing to the broker - there is no tag yet.
        await consumer.cancel(queue);
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
        await utils.timeoutPromise(20); // let it reach the gated assertQueue()
        const record = [...consumer._subscriptions.values()][0];
        assert(record.channel, 'expected _initializeChannel to have already attached the shared channel');
        assert.strictEqual(record.consumerTag, null);

        await consumer.cancel(queue);
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

    describe('in-flight tracking', () => {
      it('inFlight() brackets both the ack path and the reject path', async () => {
        const { channel, consumer } = newTestConsumer();

        const ackQueue = 'shutdown:inflight:ack-path';
        let observedDuringAckHandler = null;
        await consumer.consume(ackQueue, () => {
          observedDuringAckHandler = consumer.inFlight(ackQueue);
          return 'ok';
        });

        assert.strictEqual(consumer.inFlight(ackQueue), 0);
        await deliver(channel, ackQueue, fakeMessage({ a: 1 }));
        assert.strictEqual(observedDuringAckHandler, 1, 'expected inFlight() to be 1 while the handler runs');
        assert.strictEqual(consumer.inFlight(ackQueue), 0, 'expected inFlight() back to 0 once acked');
        sinon.assert.calledOnce(channel.ack);

        const rejectQueue = 'shutdown:inflight:reject-path';
        let observedDuringRejectHandler = null;
        await consumer.consume(rejectQueue, () => {
          observedDuringRejectHandler = consumer.inFlight(rejectQueue);
          throw new Error('boom');
        });

        await deliver(channel, rejectQueue, fakeMessage({ a: 1 }));
        assert.strictEqual(observedDuringRejectHandler, 1, 'expected inFlight() to be 1 while the handler runs');
        assert.strictEqual(consumer.inFlight(rejectQueue), 0, 'expected inFlight() back to 0 once rejected');
        sinon.assert.calledOnce(channel.reject);
      });
    });

    describe('abandoned-message guards (drain-timeout path)', () => {
      it('skips ack for an abandoned message and leaves the channel undamaged', async () => {
        const { channel, consumer } = newTestConsumer();
        const queue = 'shutdown:guard:ack';

        await consumer.consume(queue, () => 'ok');
        const record = [...consumer._subscriptions.values()][0];
        const msg = fakeMessage({ a: 1 });
        record.abandonedMessages.add(msg);

        await deliver(channel, queue, msg);

        sinon.assert.notCalled(channel.ack);
        sinon.assert.notCalled(channel.close);
      });

      it('skips reject for an abandoned message on the handler-error path and leaves the channel undamaged', async () => {
        const { channel, consumer } = newTestConsumer();
        const queue = 'shutdown:guard:reject';

        await consumer.consume(queue, () => {
          throw new Error('boom');
        });
        const record = [...consumer._subscriptions.values()][0];
        const msg = fakeMessage({ a: 1 });
        record.abandonedMessages.add(msg);

        await deliver(channel, queue, msg);

        sinon.assert.notCalled(channel.reject);
        sinon.assert.notCalled(channel.close);
      });

      it('skips the RPC reply for an abandoned message on the success path', async () => {
        const { channel, consumer } = newTestConsumer();
        const queue = 'shutdown:guard:rpc-success';

        await consumer.consume(queue, () => 'ok');
        const record = [...consumer._subscriptions.values()][0];
        const msg = fakeMessage({ a: 1 }, { replyTo: 'reply-queue', correlationId: 'abc' });
        record.abandonedMessages.add(msg);

        await deliver(channel, queue, msg);

        sinon.assert.notCalled(channel.sendToQueue);
        sinon.assert.notCalled(channel.close);
      });

      it('skips the RPC reply for an abandoned message on the non-requeue reject path', async () => {
        const { channel, consumer } = newTestConsumer({ requeue: false });
        const queue = 'shutdown:guard:rpc-reject';

        await consumer.consume(queue, () => {
          throw new Error('boom');
        });
        const record = [...consumer._subscriptions.values()][0];
        const msg = fakeMessage({ a: 1 }, { replyTo: 'reply-queue', correlationId: 'abc' });
        record.abandonedMessages.add(msg);

        await deliver(channel, queue, msg);

        sinon.assert.notCalled(channel.reject);
        sinon.assert.notCalled(channel.sendToQueue);
        sinon.assert.notCalled(channel.close);
      });
    });

    describe('drain()', () => {
      it('resolves true immediately when nothing is in flight', async () => {
        const { channel, consumer } = newTestConsumer();
        await consumer.consume('shutdown:drain:empty', () => 'ok');

        assert.strictEqual(await consumer.drain(1000), true);
      });

      it('resolves true once the in-flight handler finishes, and cancels nothing', async () => {
        const { channel, consumer } = newTestConsumer();
        const queue = 'shutdown:drain:waits-then-true';
        const handlerDefer = pDefer();

        await consumer.consume(queue, () => handlerDefer.promise);
        const deliverPromise = deliver(channel, queue, fakeMessage({ a: 1 }));

        assert.strictEqual(consumer.inFlight(queue), 1);
        const drainPromise = consumer.drain(1000);

        handlerDefer.resolve('ok');
        await deliverPromise;

        assert.strictEqual(await drainPromise, true);
        sinon.assert.notCalled(channel.cancel);
      });

      it('resolves false when the in-flight handler does not finish before the timeout', async () => {
        const { channel, consumer } = newTestConsumer();
        const queue = 'shutdown:drain:times-out';
        const handlerDefer = pDefer();

        await consumer.consume(queue, () => handlerDefer.promise);
        const deliverPromise = deliver(channel, queue, fakeMessage({ a: 1 }));

        assert.strictEqual(await consumer.drain(120), false);

        // let the still-running handler finish so it doesn't leak into the next test
        handlerDefer.resolve('ok');
        await deliverPromise;
      });
    });

    describe('stop()', () => {
      it('cancels every subscription then reports a clean drain with nothing abandoned', async () => {
        const { channel, consumer } = newTestConsumer();
        const queue = 'shutdown:stop:clean';

        await consumer.consume(queue, () => 'ok');

        assert.deepStrictEqual(await consumer.stop({ timeout: 1000 }), { drained: true, abandoned: {} });
        sinon.assert.called(channel.cancel);
        sinon.assert.notCalled(channel.close);
        assert.strictEqual(consumer._shuttingDown, true);
      });

      it('is idempotent - concurrent calls share one in-flight shutdown', async () => {
        const { channel, consumer } = newTestConsumer();
        await consumer.consume('shutdown:stop:idempotent', () => 'ok');

        const [first, second] = await Promise.all([consumer.stop(), consumer.stop()]);

        assert.deepStrictEqual(first, { drained: true, abandoned: {} });
        assert.strictEqual(second, first, 'both calls must resolve with the one memoized shutdown result');
        sinon.assert.calledOnce(channel.cancel);
      });

      it("on timeout, rejects+requeues abandoned in-flight messages and guards the handler's own ack afterward", async () => {
        const { channel, consumer } = newTestConsumer();
        const queue = 'shutdown:stop:timeout-abandons';
        const handlerDefer = pDefer();

        await consumer.consume(queue, () => handlerDefer.promise);
        const deliverPromise = deliver(channel, queue, fakeMessage({ a: 1 }));

        const stopped = await consumer.stop({ timeout: 120 });
        assert.deepStrictEqual(stopped, { drained: false, abandoned: { [queue]: 1 } });

        sinon.assert.calledOnce(channel.reject);
        sinon.assert.calledWith(channel.reject, sinon.match.any, true);
        sinon.assert.notCalled(channel.close);

        // the handler is not killed - it keeps running and eventually resolves; its own completion
        // must not double-ack/double-reject/double-reply on a delivery already abandoned above.
        handlerDefer.resolve('ok');
        await deliverPromise;

        sinon.assert.notCalled(channel.ack);
        sinon.assert.calledOnce(channel.reject);
        sinon.assert.notCalled(channel.close);
      });

      // The per-queue abandoned count is returned to the caller, who turns it into a metric - it has
      // to be accurate and scoped per queue rather than aggregated.
      it('reports the abandoned-message count per queue - only the queue that timed out appears in the map', async () => {
        const { channel, consumer } = newTestConsumer();
        const cleanQueue = 'shutdown:stop:abandoned-map:clean';
        const stuckQueue = 'shutdown:stop:abandoned-map:stuck';
        const handlerDefer = pDefer();

        await consumer.consume(cleanQueue, () => 'ok');
        await consumer.consume(stuckQueue, () => handlerDefer.promise);

        // one message drains cleanly on cleanQueue before stop() is even called...
        await deliver(channel, cleanQueue, fakeMessage({ a: 1 }));
        // ...while two are stuck in the never-resolving handler on stuckQueue.
        const stuckDeliveries = [
          deliver(channel, stuckQueue, fakeMessage({ b: 1 })),
          deliver(channel, stuckQueue, fakeMessage({ b: 2 })),
        ];
        assert.strictEqual(consumer.inFlight(stuckQueue), 2);

        const result = await consumer.stop({ timeout: 120 });

        assert.deepStrictEqual(result, { drained: false, abandoned: { [stuckQueue]: 2 } });
        assert.strictEqual(channel.reject.callCount, 2, 'expected exactly the two stuck messages to be requeued');

        // let the still-running handler finish so it doesn't leak into the next test
        handlerDefer.resolve('ok');
        await Promise.all(stuckDeliveries);
      });
    });

    describe('inFlight()', () => {
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
  });

  // These tests construct their own `Connection` instances (via the exported `Connection` class,
  // not the module's singleton factory) so they can freely call `close()` against a real broker
  // connection without tearing down the shared singleton every other spec file in this suite relies
  // on.
  describe('connection.js', () => {
    const sandbox = sinon.createSandbox();
    afterEach(() => sandbox.restore());

    function newConnection(overrides = {}) {
      return new Connection({
        host: 'amqp://localhost',
        hostname: 'shutdown-connection-test',
        timeout: 10,
        ...overrides,
      });
    }

    describe('isClosed', () => {
      it('is false before close() and true as soon as close() is invoked (before it even resolves)', () => {
        const conn = newConnection();
        assert.strictEqual(conn.isClosed, false);

        const closePromise = conn.close();
        assert.strictEqual(
          conn.isClosed,
          true,
          'expected _closed to flip synchronously, before any await inside close()',
        );

        return closePromise;
      });
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

      it('gives up on a channel that never confirms its close rather than hanging shutdown forever', async () => {
        const conn = newConnection({ prefetch: 5 });
        const amqpConnection = await conn.getConnection();
        const channel = await conn.getDefaultChannel();
        const connectionCloseSpy = sandbox.spy(amqpConnection, 'close');
        // amqplib leaves `channel.close()` pending forever if the Channel.Close-Ok never arrives (the
        // socket dying mid-handshake does not settle it, nor does a simultaneous server-side close).
        // The barrier is best-effort: it must be capped, or a wedged broker means a pod that never exits.
        sandbox.stub(channel, 'close').returns(new Promise(() => {}));

        const start = Date.now();
        await conn.close();
        const elapsed = Date.now() - start;

        sinon.assert.calledOnce(connectionCloseSpy);
        assert.strictEqual(conn.isClosed, true);
        assert(elapsed >= 4000, `expected close() to actually wait out the channel-close cap, took only ${elapsed}ms`);
        assert(elapsed < 15000, `expected close() to give up on the wedged channel, took ${elapsed}ms`);
      });

      it('gives up on a channel whose creation never finishes rather than hanging shutdown forever', async () => {
        const conn = newConnection({ prefetch: 5 });
        const amqpConnection = await conn.getConnection();
        const connectionCloseSpy = sandbox.spy(amqpConnection, 'close');

        // A cache entry still pending when shutdown starts - a channel allocated moments earlier whose
        // Channel.Open-Ok/Basic.Qos-Ok never arrived from a broker that stopped answering while its TCP
        // connection stayed up. The cap has to cover awaiting the entry itself, not just close().
        // eslint-disable-next-line no-underscore-dangle
        conn._channels._channels.set('never-opens', { chann: new Promise(() => {}), config: { prefetch: 5 } });

        const start = Date.now();
        await conn.close();
        const elapsed = Date.now() - start;

        sinon.assert.calledOnce(connectionCloseSpy);
        assert.strictEqual(conn.isClosed, true);
        assert(elapsed >= 4000, `expected close() to actually wait out the cap, took only ${elapsed}ms`);
        assert(elapsed < 15000, `expected close() to give up on the never-opened channel, took ${elapsed}ms`);
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
        for (let i = 0; i < 100 && !fakeChannel.prefetch.called; i += 1) {
          await utils.timeoutPromise(10);
        }
        sinon.assert.calledOnce(fakeChannel.prefetch);

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

        await assert.rejects(
          () => conn.getConnection(),
          (err) => {
            assert(err instanceof ConnectionClosedError, `expected ConnectionClosedError, got ${err.constructor.name}`);
            return true;
          },
        );
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
  });

  describe('producer.js reconnect-on-close guard', () => {
    const sandbox = sinon.createSandbox();
    afterEach(() => sandbox.restore());

    /** A fake connection whose 'close' listeners are driven by a real EventEmitter, like the amqp one. */
    function createFakeConnectionWithCloseEvent(channel) {
      const emitter = new EventEmitter();
      return {
        config: { hostname: 'shutdown-producer-test', timeout: 10, rpcTimeout: 0 },
        getDefaultChannel: sinon.stub().resolves(channel),
        addListener(event, fn) {
          emitter.on(event, fn);
        },
        emitClose() {
          emitter.emit('close');
        },
      };
    }

    it('createRpcQueue() stops retrying (does not spin) once getDefaultChannel rejects with ConnectionClosedError', async () => {
      const channel = createFakeChannelForRpc();
      const connection = createFakeConnectionWithCloseEvent(channel);
      connection.getDefaultChannel = sinon.stub().rejects(new ConnectionClosedError());
      const producer = new Producer(connection);
      const timeoutSpy = sandbox.spy(utils, 'timeoutPromise');

      const result = await producer.createRpcQueue('shutdown:rpc:closed-from-start');

      // one attempt, then the guard stops it: no internal retry-loop recursion, no delay-then-retry.
      assert.strictEqual(result, undefined);
      sinon.assert.notCalled(timeoutSpy);
      sinon.assert.calledOnce(connection.getDefaultChannel);
    });

    it('the fire-and-forget reconnect-on-close listener stops spinning once the connection is permanently closed', async () => {
      const channel = createFakeChannelForRpc();
      const connection = createFakeConnectionWithCloseEvent(channel);
      const producer = new Producer(connection);
      const queue = 'shutdown:rpc:reconnect-then-closed';

      // first init succeeds normally and registers the reconnect-on-close listener
      await producer.createRpcQueue(queue);
      sinon.assert.calledOnce(connection.getDefaultChannel);

      // now simulate the connection being permanently closed
      connection.getDefaultChannel = sinon.stub().rejects(new ConnectionClosedError());
      const timeoutSpy = sandbox.spy(utils, 'timeoutPromise');

      connection.emitClose(); // fires the registered listener, which fire-and-forgets createRpcQueue()

      // give the fire-and-forget promise chain a tick to run to completion
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });

      sinon.assert.calledOnce(connection.getDefaultChannel);
      sinon.assert.notCalled(timeoutSpy);
    });
  });

  // producer.js's stop() proactively rejects RPC promises pending in amqpRPCQueues (a separate code
  // path from the reconnect-on-close guard above) so a caller awaiting an RPC response does not hang
  // for the full rpcTimeout once the connection is gone.
  describe('producer.js stop()', () => {
    const sandbox = sinon.createSandbox();
    afterEach(() => sandbox.restore());

    function createFakeConnection(channel, overrides = {}) {
      return {
        config: { hostname: 'shutdown-producer-stop-test', timeout: 10, rpcTimeout: 15000, ...overrides },
        getDefaultChannel: sinon.stub().resolves(channel),
        getConnection: sinon.stub().resolves({}),
        addListener: sinon.stub(),
      };
    }

    /** correlationId key registered in amqpRPCQueues[queue] for the pending waiter (not 'resQueuePromise'). */
    function pendingCorrelationId(producer, queue) {
      return Object.keys(producer.amqpRPCQueues[queue] || {}).find((key) => key !== 'resQueuePromise');
    }

    it('rejects a pending RPC promise with ConnectionClosedError instead of waiting out rpcTimeout', async () => {
      const channel = createFakeChannelForRpc();
      const connection = createFakeConnection(channel);
      const producer = new Producer(connection);
      const queue = 'shutdown:producer-stop:pending';

      const rpcPromise = producer.checkRpc(queue, 'payload', { rpc: true });
      // let createRpcQueue()/publishOrSendToQueue() settle so the waiter is actually registered
      await utils.timeoutPromise(10);
      assert(pendingCorrelationId(producer, queue), 'expected a pending RPC waiter to be registered');

      producer.stop();

      await assert.rejects(() => rpcPromise, ConnectionClosedError);
    });

    it('clears the pending timeout so no lingering timer keeps the process alive', async () => {
      const channel = createFakeChannelForRpc();
      const connection = createFakeConnection(channel, { rpcTimeout: 15000 });
      const producer = new Producer(connection);
      const queue = 'shutdown:producer-stop:clear-timeout';
      const clearTimeoutSpy = sandbox.spy(global, 'clearTimeout');

      const rpcPromise = producer.checkRpc(queue, 'payload', { rpc: true });
      await utils.timeoutPromise(10);

      const corrId = pendingCorrelationId(producer, queue);
      assert(corrId, 'expected a pending RPC waiter to be registered');
      const { timeoutId } = producer.amqpRPCQueues[queue][corrId];
      assert(timeoutId, 'expected a timer to have been scheduled for the pending RPC');

      producer.stop();

      sinon.assert.calledWith(clearTimeoutSpy, timeoutId);
      assert.strictEqual(
        pendingCorrelationId(producer, queue),
        undefined,
        'expected the waiter to be removed from the registry',
      );
      await assert.rejects(() => rpcPromise, ConnectionClosedError);
    });

    it('is idempotent - calling stop() twice does not throw or double-reject', async () => {
      const channel = createFakeChannelForRpc();
      const connection = createFakeConnection(channel);
      const producer = new Producer(connection);
      const queue = 'shutdown:producer-stop:idempotent';

      const rpcPromise = producer.checkRpc(queue, 'payload', { rpc: true });
      await utils.timeoutPromise(10);

      producer.stop();
      producer.stop();

      await assert.rejects(() => rpcPromise, ConnectionClosedError);
      assert.strictEqual(producer._shuttingDown, true);
    });

    it('leaves resQueuePromise bookkeeping alone (only rejects correlationId waiters)', async () => {
      const channel = createFakeChannelForRpc();
      const connection = createFakeConnection(channel);
      const producer = new Producer(connection);
      const queue = 'shutdown:producer-stop:resqueue-untouched';

      const rpcPromise = producer.checkRpc(queue, 'payload', { rpc: true });
      await utils.timeoutPromise(10);

      producer.stop();
      await assert.rejects(() => rpcPromise, ConnectionClosedError);

      assert(
        producer.amqpRPCQueues[queue].resQueuePromise,
        'expected resQueuePromise to still be present after stop()',
      );
    });
  });

  // src/modules/arnavmq.js's top-level close() orchestrates, in order: cancel -> drain (reject-pass
  // on timeout) -> producer.stop() -> connection.close().
  describe('arnavmq.js close() orchestration', () => {
    const sandbox = sinon.createSandbox();
    afterEach(() => sandbox.restore());

    // A fresh, isolated ArnavMQ+Connection pair against the real broker - not the process-wide
    // singleton every other spec file (including arnavmqConfigurator() calls elsewhere in this
    // file) shares, since close() is terminal and would otherwise poison every test that runs after.
    function newArnavmq(overrides = {}) {
      const conn = new Connection({
        host: 'amqp://localhost',
        hostname: 'shutdown-arnavmq-close-test',
        prefetch: 5,
        timeout: 10,
        requeue: true,
        consumerSuffix: '',
        producerMaxRetries: -1,
        rpcTimeout: 0,
        shutdownTimeout: 5000,
        ...overrides,
      });
      return new ArnavMQ(conn);
    }

    /** Polls `predicate` every 20ms until truthy, or throws once `timeoutMs` elapses. */
    async function waitFor(predicate, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() >= deadline) {
          throw new Error('waitFor() timed out');
        }
        await utils.timeoutPromise(20);
      }
    }

    describe('the object returned by the top-level factory', () => {
      it('exposes close(), connection.close()/isClosed, and the additive consumer sub-API', () => {
        const arnavmq = arnavmqConfigurator();

        assert.strictEqual(typeof arnavmq.close, 'function');
        assert.strictEqual(typeof arnavmq.connection.close, 'function');
        assert.strictEqual(typeof arnavmq.connection.isClosed, 'boolean');
        assert.strictEqual(typeof arnavmq.consumer.consume, 'function');
        assert.strictEqual(typeof arnavmq.consumer.subscribe, 'function');
        assert.strictEqual(typeof arnavmq.consumer.cancel, 'function');
        assert.strictEqual(typeof arnavmq.consumer.stop, 'function');
        assert.strictEqual(typeof arnavmq.consumer.drain, 'function');
        assert.strictEqual(typeof arnavmq.consumer.inFlight, 'function');
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
      await waitFor(() => arnavmq.consumer.inFlight(queue) === 1);

      const closePromise = arnavmq.close({ timeout: 5000 });
      await utils.timeoutPromise(100); // give close() time to cancel and start draining

      assert.strictEqual(arnavmq.connection.isClosed, false, 'connection must stay open while draining');
      const [record] = [...arnavmq.consumer._subscriptions.values()];
      assert.strictEqual(record.cancelled, true, 'expected close() to have cancelled the subscription by now');
      assert.strictEqual(callCount, 1);

      gate.resolve();
      assert.deepStrictEqual(await closePromise, { drained: true, abandoned: {} });

      assert.strictEqual(callCount, 1, 'the cancelled subscription must not receive a second delivery');
      assert.strictEqual(record.abandonedMessages.size, 0, 'the message drained cleanly, nothing should be abandoned');
      assert.strictEqual(arnavmq.connection.isClosed, true);
    });

    it('rejects+requeues an in-flight message when the handler outlives the drain timeout', async () => {
      const arnavmq = newArnavmq();
      const queue = 'shutdown:arnavmq-close:timeout-reject';
      const gate = pDefer();

      await arnavmq.subscribe(queue, async () => {
        await gate.promise;
      });

      await arnavmq.publish(queue, { n: 1 });
      await waitFor(() => arnavmq.consumer.inFlight(queue) === 1);

      const result = await arnavmq.close({ timeout: 100 });

      // keyed by queue name, so a caller can emit an abandoned-message metric off it.
      assert.deepStrictEqual(result, { drained: false, abandoned: { [queue]: 1 } });
      assert.strictEqual(arnavmq.connection.isClosed, true);
      const [record] = [...arnavmq.consumer._subscriptions.values()];
      assert.strictEqual(record.abandonedMessages.size, 1, 'expected the leftover message to be abandoned+requeued');

      // let the still-running handler finish so it doesn't leak into later tests
      gate.resolve();
    });

    it('calls producer.stop() before connection.close() - produce() during the drain window still succeeds; only fails with ConnectionClosedError once close() fully resolves', async () => {
      const arnavmq = newArnavmq();
      const queue = 'shutdown:arnavmq-close:producer-order';
      const sideQueue = 'shutdown:arnavmq-close:producer-order:side';
      const proceedGate = pDefer();
      const publishSettled = pDefer();

      await arnavmq.subscribe(queue, async () => {
        await proceedGate.promise;
        try {
          await arnavmq.publish(sideQueue, { ok: true });
          publishSettled.resolve({ ok: true });
        } catch (error) {
          publishSettled.resolve({ error });
        }
      });

      await arnavmq.publish(queue, { n: 1 });
      await waitFor(() => arnavmq.consumer.inFlight(queue) === 1);

      const closePromise = arnavmq.close({ timeout: 5000 });
      await utils.timeoutPromise(50); // close() is now cancelling/draining; the handler is still gated

      assert.strictEqual(arnavmq.connection.isClosed, false, 'connection must still be open mid-drain');

      proceedGate.resolve(); // let the handler publish downstream while the connection is still open
      const publishOutcome = await publishSettled.promise;

      assert.strictEqual(publishOutcome.error, undefined, 'expected produce() during the drain window to succeed');
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

      const cancelAllSpy = sandbox.spy(arnavmq.consumer, 'cancelAll');
      const connectionCloseSpy = sandbox.spy(arnavmq.connection, 'close');

      await Promise.all([arnavmq.close(), arnavmq.close()]);
      await arnavmq.close();

      assert.strictEqual(arnavmq.connection.isClosed, true);
      // consumer.stop() memoizes its own shutdown promise, so cancelAll() only actually runs once no
      // matter how many times the top-level close() calls into it.
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
      await waitFor(() => arnavmq.consumer.inFlight(queue) === 1);

      const closePromise = arnavmq.close({ timeout: 5000 });
      await utils.timeoutPromise(50); // close() has cancelled and is draining; the handler is gated
      gate.resolve(); // handler finishes and acks well inside the 5s drain budget
      await closePromise;

      const [record] = [...arnavmq.consumer._subscriptions.values()];
      assert.strictEqual(callCount, 1);
      assert.strictEqual(
        record.abandonedMessages.size,
        0,
        'expected a clean drain (nothing abandoned/rejected) - this test is about the acked path',
      );
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

    it('close({ timeout }) on a handler that outlives it resolves quickly, and a fresh instance receives the rejected+requeued message', async () => {
      const arnavmq = newArnavmq();
      const queue = 'shutdown:arnavmq-close:timeout-reject-redelivered';
      const gate = pDefer(); // deliberately never resolved here - simulates the 5s+ handler that outlives the drain timeout

      await arnavmq.subscribe(queue, async () => {
        await gate.promise;
      });

      await arnavmq.publish(queue, { n: 1 });
      await waitFor(() => arnavmq.consumer.inFlight(queue) === 1);

      const start = Date.now();
      await arnavmq.close({ timeout: 100 });
      const elapsed = Date.now() - start;

      assert(elapsed < 2000, `expected close({ timeout: 100 }) to resolve in ~100ms, took ${elapsed}ms`);
      assert.strictEqual(arnavmq.connection.isClosed, true);

      const fresh = newArnavmq();
      const receivedDefer = pDefer();
      let received;
      await fresh.subscribe(queue, (body) => {
        received = body;
        receivedDefer.resolve();
      });

      // resolves once the requeued message is actually redelivered to this independent consumer;
      // if it were lost instead of requeued, this hangs until mocha's suite timeout fails the test.
      await receivedDefer.promise;
      assert.strictEqual(received.n, 1);

      gate.resolve(); // let the first instance's still-running handler finish so it doesn't leak
      await fresh.close();
    });

    // cancelAll() must mark every record cancelled before the channel's/connection's own 'close'
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
      await utils.timeoutPromise(100); // let checkRpc()/createRpcQueue() register the pending waiter

      // Attach the rejection expectation *before/alongside* close(), not after awaiting it: close()
      // rejects rpcPromise synchronously from inside producer.stop(), several steps before close()
      // itself resolves (it still has to await connection.close()). Awaiting close() to completion
      // first and only then attaching a handler to rpcPromise leaves it unhandled across a real
      // async gap, which trips Node's unhandledRejection detection - a test-harness ordering issue,
      // not a bug in close() itself.
      const start = Date.now();
      await Promise.all([arnavmq.close(), assert.rejects(() => rpcPromise, ConnectionClosedError)]);
      const elapsed = Date.now() - start;

      assert(
        elapsed < 5000,
        `expected close() to resolve quickly rather than waiting out rpcTimeout, took ${elapsed}ms`,
      );
    });
  });
});
