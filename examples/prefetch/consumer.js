var consumer = require('../../index')().consumer;

var i = 0;
var interval;

interval = setInterval(function () {
  consumer.consume('queue-prefetch' + i, function (_msg) {
    return Promise.resolve(JSON.stringify(_msg));
  });

  ++i;
  if (i >= 100) {
    interval = clearInterval(interval);
  }
}, 500);
