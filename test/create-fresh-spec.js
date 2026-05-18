const arnavmq = require('../src/index');

describe('createFresh', () => {
  it('exports createFresh function', () => {
    expect(typeof arnavmq.createFresh).toBe('function');
  });

  it('returns independent instances for different configs', () => {
    const bus1 = arnavmq.createFresh({ host: 'amqp://server1', hostname: 'test1' });
    const bus2 = arnavmq.createFresh({ host: 'amqp://server2', hostname: 'test2' });

    expect(bus1.connection).not.toBe(bus2.connection);
    expect(bus1.connection.config.host).toBe('amqp://server1');
    expect(bus2.connection.config.host).toBe('amqp://server2');
  });

  it('returned bus has subscribe, publish, hooks', () => {
    const bus = arnavmq.createFresh({ host: 'amqp://localhost', hostname: 'test' });

    expect(typeof bus.subscribe).toBe('function');
    expect(typeof bus.publish).toBe('function');
    expect(bus.hooks).toBeDefined();
    expect(bus.hooks.consumer).toBeDefined();
    expect(bus.hooks.producer).toBeDefined();
    expect(bus.hooks.connection).toBeDefined();
  });

  it('hooks are independent between instances', () => {
    const bus1 = arnavmq.createFresh({ host: 'amqp://server1', hostname: 'test1' });
    const bus2 = arnavmq.createFresh({ host: 'amqp://server2', hostname: 'test2' });

    expect(bus1.hooks.consumer).not.toBe(bus2.hooks.consumer);
  });
});
