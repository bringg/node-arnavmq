const producer = require('../../src/index')().producer;
const { logger } = require('@dialonce/boot')();

let i = 0;
let interval;

interval = setInterval(() => {
  producer.produce(`queue-prefetch${i}`, { message: `start-${i}` }, { rpc: true })
  .then(logger.info);

  i += 1;
  if (i >= 100) {
    interval = clearInterval(interval);
  }
}, 500);
