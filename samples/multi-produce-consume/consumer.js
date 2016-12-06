const consumer = require('../../src/index')().consumer;

let interval;
let i = 0;

interval = setInterval(() => {
  consumer.consume(`queueName-${i}`, msg =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve(`res:${JSON.stringify(msg)}`);
      }, 3000);
    })
  );

  i += 1;
  if (i >= 5) {
    interval = clearInterval(interval);
  }
}, 1000);
