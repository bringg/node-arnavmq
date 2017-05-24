/* eslint no-console: off */
const producer = require('../../src/index')().producer;

let i = 0;
let interval;

interval = setInterval(() => {
  producer.produce(`queue-prefetch${i}`, { message: `start-${i}` }, { rpc: true })
  .then(console.info);

  i += 1;
  if (i >= 100) {
    interval = clearInterval(interval);
  }
}, 500);
