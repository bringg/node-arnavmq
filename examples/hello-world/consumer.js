var consumer = require('../../index')({
  isLogEnabled: true,
  amqpUrl: 'amqp://localhost',
  prefetch: process.env.AMQP_PREFETCH || 1,
  isRequeueEnabled: true
}).consumer;

consumer.connect()
.then(function (_channel) {
  consumer.consume('queueName', function (_msg) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        resolve(true);
      }, 5000);
    });
  })
  .then(function (response) {
    console.log(response); // true if message has been acknowledged, else false
  });
});
