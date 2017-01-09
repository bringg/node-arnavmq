require('dotenv').load({ silent: true });
var assert = require('assert'),
  uuid = require('node-uuid');

require('events').EventEmitter.prototype._maxListeners = process.env.MAX_EMITTERS;

describe('config', function() {

  beforeEach(function() {
    this.oldHost = process.env.HOSTNAME;
    this.oldUsr = process.env.USER;
  });

  afterEach(function() {
    process.env.HOSTNAME = this.oldHost;
    process.env.USER = this.oldUsr;
    process.env.LOCAL_QUEUE = '';
    process.env.AMQP_URL = '';
    process.env.AMQP_DEBUG = '';
  });

  describe('retrocompat', function() {

    var retrocompat = require('../src/modules/retrocompat-config');

    it('should set config as empty array if no config present', function() {
      let conf = retrocompat();
      assert.deepEqual(conf, {});
    });

    it('should be able to override default config options based on config object', function() {
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

    it('should be able to override default config options based on env vars', function() {
      process.env.LOCAL_QUEUE = ':test';
      process.env.AMQP_URL = 'ok';
      process.env.AMQP_DEBUG = true;

      let conf = retrocompat();

      //ensure transport is console
      assert(conf.transport);
      assert.equal(conf.host, process.env.AMQP_URL);
      assert.equal(conf.consumerSuffix, process.env.LOCAL_QUEUE);
    });
  });

  describe('entry point', function() {
    var main = require('../src/index');

    it('should be able to merge config', function() {
      var conf = { host: 'amqp://my-host' };
      assert.equal(main(conf).producer.conn.config.host, 'amqp://my-host');
    });

    it('should generate an uuid as hostname if no env for HOSTNAME/USER', function() {
      process.env.HOSTNAME = '';
      process.env.USER = '';

      var conf = { host: 'amqp://my-host' };
      assert.equal(main(conf).producer.conn.config.hostname.length, uuid.v4().length);
    });

    it('should ensure prefetch is in an integer format', function() {
      var conf = { host: 'amqp://my-host', prefetch: '3' };
      assert.equal(main(conf).producer.conn.config.prefetch, 3);
    });

    it('should set unlimited prefetch if prefetch is an invalid value', function() {
      var conf = { host: 'amqp://my-host', prefetch: '' };
      assert.equal(main(conf).producer.conn.config.prefetch, 0);
    });

    it('should use provided prefetch', function() {
      var conf = { host: 'amqp://my-host', prefetch: 1 };
      assert.equal(main(conf).producer.conn.config.prefetch, 1);
    });
  });
});
