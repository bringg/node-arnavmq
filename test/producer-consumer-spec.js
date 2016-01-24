
var assert = require('assert');
var producer = require('../index')().producer;
var consumer = require('../index')().consumer;
var uuid = require('node-uuid');

var fixtures = {
  queues: ['test-queue-0', 'test-queue-1', 'test-queue-2']
};

var letters = 0;

describe('Producer/Consumer msg delevering:', function() {
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

  it('should be able to consume message sended by producer to queue [test-queue-0]', function (done) {
    producer.produce(fixtures.queues[0], { msg: uuid.v4() })
    .then(function (response) {
      assert(response === true);
      ++letters;
    })
    .then(function () {
      return consumer.consume(fixtures.queues[0], function (_msg) {
        assert(typeof _msg === 'object');
      });
    })
    .then(function (response) {
      assert(response === true);
      --letters;
    })
    .then(done);
  });

  it('should not be able to consume message sended by producer to queue [test-queue-1]', function (done) {
    producer.produce(fixtures.queues[1], { msg: uuid.v4() })
    .then(function (response) {
      assert(response === true);
      ++letters;
      setTimeout(done, 2000);
    })
    .then(function () {
      return consumer.consume(fixtures.queues[0], function (_msg) {
        assert(typeof _msg === 'object');
      });
    })
    .then(function (response) {
      assert(response === true);
      --letters;
    })
    .then(done);
  });

  it('should be able to consume message sended by producer to queue [test-queue-1], and the message of the previous test case', function (done) {
    producer.produce(fixtures.queues[1], { msg: uuid.v4() })
    .then(function (response) {
      assert(response === true);
      ++letters;
    })
    .then(function () {
      /*jshint unused: false*/
      return new Promise(function (resolve, reject) {
        consumer.consume(fixtures.queues[1], function (_msg) {
          assert(typeof _msg === 'object');
          --letters;
          if (!letters) return resolve(true);
        });
      });
    })
    .then(function (response) {
      assert(response === true);
    })
    .then(function () {
      return consumer.disconnect();
    })
    .then(function () {
      return producer.disconnect();
    })
    .then(done);
  });

  it('should be able to consume all message populated by producer to all queues [test-queue-0, test-queue-1, test-queue-2]', function (done) {
    producer.produce(fixtures.queues[2], { msg: uuid.v4() })
    .then(function (response) {
      assert(response === true);
      ++letters;
    })
    .then(function () {
      return producer.produce(fixtures.queues[1], { msg: uuid.v4() });
    })
    .then(function (response) {
      assert(response === true);
      ++letters;
    })
    .then(function () {
      return producer.produce(fixtures.queues[0], { msg: uuid.v4() });
    })
    .then(function (response) {
      assert(response === true);
      ++letters;
    })
    .then(function () {
      return consumer.consume(fixtures.queues[2], function (_msg) {
        assert(typeof _msg === 'object');
      });
    })
    .then(function (response) {
      assert(response === true);
      --letters;
    })
    .then(function () {
      return consumer.consume(fixtures.queues[1], function (_msg) {
        assert(typeof _msg === 'object');
      });
    })
    .then(function (response) {
      assert(response === true);
      --letters;
    })
    .then(function () {
      return consumer.consume(fixtures.queues[0], function (_msg) {
        assert(typeof _msg === 'object');
      });
    })
    .then(function (response) {
      assert(response === true);
      --letters;
    })
    .then(function () {
      return consumer.disconnect();
    })
    .then(function () {
      return producer.disconnect();
    })
    .then(done);
  });
});

describe('Producer/Consumer msg requeueing:', function () {
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

  it('should be able to consume message, but throw error so the message is requeued again on queue [test-queue-0]', function (done) {
    var attempt = 3;

    producer.produce(fixtures.queues[0], { msg: uuid.v4() })
    .then(function (response) {
      assert(response === true);
      ++letters;
    })
    .then(function () {
      /*jshint unused: false*/
      return new Promise(function (resolve, reject) {
        consumer.consume(fixtures.queues[0], function (_msg) {
          assert(typeof _msg === 'object');

          --attempt;
          if (!attempt) {
            return resolve(true);
          } else {
            throw new Error('Any kind of error');
          }
        });
      });
    })
    .then(function (response) {
      assert(response === true);
      --letters;
    })
    .then(function () {
      return consumer.disconnect();
    })
    .then(function () {
      return producer.disconnect();
    })
    .then(done);
  });
});
