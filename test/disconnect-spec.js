var docker = require('./docker');
var assert = require('assert');
var producer = require('../src/index')().producer;
var consumer = require('../src/index')().consumer;
var utils = require('../src/modules/utils');

describe('disconnections', function() {
  before(function() {
    this.timeout(20000);
    return docker.start();
  });

  after(() => {
    return docker.stop();
  });

  describe('regular pub/sub', function() {
    var queue = 'disco:test';

    it('should be able to re-register to consume messages between connection failures', function(done) {
      this.timeout(20000);
      var counter = 0;
      return consumer.consume(queue, function() {
        counter++;
        if (counter === 50) {
          done();
        }
      })
      .then(() => {
        return producer.produce(queue);
      })
      .then(() => utils.timeoutPromise(500))
      .then(() => {
        assert(counter);
      })
      .then(() => {
        return docker.stop();
      })
      .then(() => {
        for(var i = counter; i < 50; i++) {
          producer.produce(queue);
        }
      })
      .then(() => {
        return docker.start();
      });
    });
  });

  describe('RPC', function() {
    var queue = 'disco:test:2';

    it('should be able to re-register to consume messages between connection failures', function(done) {
      this.timeout(20000);
      var counter = 0;
      var checkReceived = function(counter) {
        if (counter === 50) done();
      };

      return consumer.consume(queue, function() {
        counter++;
        return counter;
      })
      .then(() => {
        return producer.produce(queue, undefined, { rpc: true }).then(checkReceived);
      })
      .then(() => utils.timeoutPromise(500))
      .then(() => {
        assert(counter);
      })
      .then(() => {
        return docker.stop();
      })
      .then(() => {
        for(var i = counter; i < 50; i++) {
          producer.produce(queue, undefined, { rpc: true }).then(checkReceived);
        }
      })
      .then(() => {
        return docker.start();
      });
    });
  });
});
