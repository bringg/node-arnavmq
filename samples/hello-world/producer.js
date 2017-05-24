/* eslint no-console: off */
const producer = require('../../src/index')().producer;

producer.connect()
.then(() => {
  producer.produce('queueName', { message: 'hello world!' })
  .then(console.info); // true if message has been sent, else false
});
