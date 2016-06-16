var producer = require('../../index')().producer;

var i = 0;
var interval;

interval = setInterval(function () {
  producer.produce('queueName-' + i, { message: 'start-' + i }, { rpc: true });

  ++i;
  if (i >= 5) {
    interval = clearInterval(interval);
  }
}, 2000);
