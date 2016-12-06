const producer = require('../../src/index')().producer;

let i = 0;
let interval;

interval = setInterval(() => {
  producer.produce(`queueName-${i}`, { message: `start-${i}` }, { rpc: true });

  i += 1;
  if (i >= 5) {
    interval = clearInterval(interval);
  }
}, 2000);
