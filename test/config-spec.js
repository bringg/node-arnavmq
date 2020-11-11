const assert = require('assert');
const uuid = require('uuid');

/* eslint global-require: "off" */
describe('config', () => {
  beforeEach(() => {
    this.oldHost = process.env.HOSTNAME;
    this.oldUsr = process.env.USER;
  });

  afterEach(() => {
    process.env.HOSTNAME = this.oldHost;
    process.env.USER = this.oldUsr;
    process.env.LOCAL_QUEUE = '';
    process.env.AMQP_URL = '';
    process.env.AMQP_DEBUG = '';
  });

  describe('retrocompat', () => {
    const retrocompat = require('../src/modules/retrocompat-config');

    it('should set config as empty array if no config present', () => {
      const conf = retrocompat();
      assert.deepEqual(conf, {});
    });

    it('should be able to override default config options based on config object', () => {
      let conf = {
        amqpUrl: 'ok',
        amqpPrefetch: 1,
        amqpRequeue: true,
        amqpTimeout: 5
      };

      conf = retrocompat(conf);

      assert.equal(conf.host, conf.amqpUrl);
      assert.equal(conf.prefetch, conf.amqpPrefetch);
      assert.equal(conf.requeue, conf.amqpRequeue);
      assert.equal(conf.timeout, conf.amqpTimeout);
    });

    it('should be able to override default config options based on env vars', () => {
      process.env.LOCAL_QUEUE = ':test';
      process.env.AMQP_URL = 'ok';
      process.env.AMQP_DEBUG = true;

      const conf = retrocompat();

      // ensure transport is console
      assert(conf.transport);
      assert.equal(conf.host, process.env.AMQP_URL);
      assert.equal(conf.consumerSuffix, process.env.LOCAL_QUEUE);
    });
  });

  describe('entry point', () => {
    const main = require('../src/index');

    it('should be able to merge config', () => {
      const conf = { host: 'amqp://localhost' };
      assert.equal(main(conf).connection.config.host, 'amqp://localhost');
    });

    it('should generate an uuid as hostname if no env for HOSTNAME/USER', () => {
      process.env.HOSTNAME = '';
      process.env.USER = '';

      const conf = { host: 'amqp://localhost' };
      assert.equal(main(conf).connection.config.hostname.length, uuid.v4().length);
    });

    it('should ensure prefetch is in an integer format', () => {
      const conf = { host: 'amqp://localhost', prefetch: '3' };
      assert.equal(main(conf).connection.config.prefetch, 3);
    });

    it('should set unlimited prefetch if prefetch is an invalid value', () => {
      const conf = { host: 'amqp://localhost', prefetch: '' };
      assert.equal(main(conf).connection.config.prefetch, 0);
    });

    it('should use provided prefetch', () => {
      const conf = { host: 'amqp://localhost', prefetch: 1 };
      assert.equal(main(conf).connection.config.prefetch, 1);
    });

    it('should use default rpcRimeout if none given', () => {
      const conf = { host: 'amqp://localhost' };
      assert.equal(main(conf).connection.config.rpcTimeout, 15000);
    });

    it('should use provided rpcRimeout', () => {
      const conf = { host: 'amqp://localhost', rpcTimeout: 999 };
      assert.equal(main(conf).connection.config.rpcTimeout, 999);
    });
  });
});
