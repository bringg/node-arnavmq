var producer = require('../../index')().producer;

producer.connect()
.then(function (_channel) {
  producer.produce('queueName', { message: 'hello world!' });
});
