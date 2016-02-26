var producer = require('../../index')().producer;

producer.connect()
.then(function (_channel) {
  producer.produce('queueName', { message: 'hello world!' })
  .then(function (response) {
    console.log(response); // true if message has been sent, else false
  });
});
