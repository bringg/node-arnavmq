const producer = require('../../src/index')().producer;
const { logger } = require('@dialonce/boot')();

producer.connect()
.then(() => {
  producer.produce('queueName', { message: 'hello world!' })
  .then(logger.info); // true if message has been sent, else false
});
