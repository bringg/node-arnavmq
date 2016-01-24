var producer = require('../../index')({
  isLogEnabled: true,
  amqpUrl: 'amqp://localhost',
  prefetch: process.env.AMQP_PREFETCH || 1,
  isRequeueEnabled: true
}).producer;

producer.connect()
.then(function (_channel) {
  producer.produce('queueName', { message: 'hello world!' })
  .then(function (response) {
    console.log(response); // true if message has been sent, else false
  });
});
