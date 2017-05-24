/* eslint no-console: off */
const consumer = require('../../src/index')().consumer;

consumer.connect()
.then(() => {
  consumer.consume('queueName', () =>
    new Promise((resolve) => {
      setTimeout(resolve(true), 5000);
    })
  )
  .then(console.info); // true if message has been acknowledged, else false
});
