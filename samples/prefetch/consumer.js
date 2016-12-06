const consumer = require('../../src/index')().consumer;

let i = 0;
let interval;

interval = setInterval(() => {
  consumer.consume(`queue-prefetch${i}`, msg =>
    Promise.resolve(JSON.stringify(msg))
  );

  i += 1;
  if (i >= 100) {
    interval = clearInterval(interval);
  }
}, 500);
