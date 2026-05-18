const assert = require('assert');
const arnavmq = require('../src/index');

describe('createFresh', () => {
  it('exports createFresh function', () => {
    assert.strictEqual(typeof arnavmq.createFresh, 'function');
  });

  it('returns independent instances for different configs', () => {
    const bus1 = arnavmq.createFresh({ host: 'amqp://server1', hostname: 'test1' });
    const bus2 = arnavmq.createFresh({ host: 'amqp://server2', hostname: 'test2' });

    assert.notStrictEqual(bus1.connection, bus2.connection);
    assert.strictEqual(bus1.connection.config.host, 'amqp://server1');
    assert.strictEqual(bus2.connection.config.host, 'amqp://server2');
  });

  it('returned bus has subscribe, publish, hooks', () => {
    const bus = arnavmq.createFresh({ host: 'amqp://localhost', hostname: 'test' });

    assert.strictEqual(typeof bus.subscribe, 'function');
    assert.strictEqual(typeof bus.publish, 'function');
    assert.ok(bus.hooks);
    assert.ok(bus.hooks.consumer);
    assert.ok(bus.hooks.producer);
    assert.ok(bus.hooks.connection);
  });

  it('hooks are independent between instances', () => {
    const bus1 = arnavmq.createFresh({ host: 'amqp://server1', hostname: 'test1' });
    const bus2 = arnavmq.createFresh({ host: 'amqp://server2', hostname: 'test2' });

    assert.notStrictEqual(bus1.hooks.consumer, bus2.hooks.consumer);
  });
});
