var assert = require('assert');
var producer = require('../index')().producer;
var consumer = require('../index')().consumer;
var uuid = require('node-uuid');

var fixtures = {
  queues: ['rpc-queue-0']
};

describe('Producer/Consumer RPC messaging:', function() {
  before(function (done) {
    return consumer.connect()
    .then(function (_channel) {
      assert(_channel !== undefined);
      assert(_channel !== null);
    })
    .then(function () {
      return producer.connect();
    })
    .then(function (_channel) {
      assert(_channel !== undefined);
      assert(_channel !== null);
    })
    .then(done);
  });

  it('should be able to create a consumer that returns a message if called as RPC [rpc-queue-0]', function (done) {
    consumer.consume(fixtures.queues[0], function () {
      return 'Power Ranger Red';
    })
    .then(function(created) {
      assert.equal(created, true);
    })
    .then(done);
  });

  it('should be able to produce a RPC message and get a response [rpc-queue-0]', function (done) {
    producer.produce(fixtures.queues[0], { msg: uuid.v4() })
    .then(function (response) {
      assert.equal(response, 'Power Ranger Red');
    })
    .then(done);
  });
});
