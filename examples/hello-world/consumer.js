var consumer = require('../../index')({
  isLogEnabled: true,
  amqpUrl: 'amqp://localhost',
  prefetch: process.env.AMQP_PREFETCH || 1,
  isRequeueEnabled: true
}).consumer;

consumer.connect()
.then(function (_channel) {
  consumer.consume('queueName', function (_msg) {
    setTimeout(function () {
      return true;
    }, 5000);
  });
});
