var consumer = require('../../index')().consumer;

var interval, i = 0;

interval = setInterval(function () {
  consumer.consume('queueName-' + i, function (_msg) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve('res:' + JSON.stringify(_msg));
      }, 3000);
    });
  });

  ++i;
  if (i >= 5) {
    interval = clearInterval(interval);
  }
}, 1000);
