const consumer = require('../../src/index')().consumer;
const { logger } = require('@dialonce/boot')();

consumer.connect()
.then(() => {
  consumer.consume('queueName', () =>
    new Promise((resolve) => {
      setTimeout(resolve(true), 5000);
    })
  )
  .then(logger.info); // true if message has been acknowledged, else false
});
