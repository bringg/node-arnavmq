var producer = require('../../index')().producer;

producer.connect('amqp://localhost')
.then(function (_channel) {
  producer.produce('queueName', { message: 'hello world!' });
});
