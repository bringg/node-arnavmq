
var producer = require('../../index')().producer;

var i = 0;
var interval;

// interval = setInterval(function () {
//   producer.produce('queue-prefetch' + i, { message: 'start-' + i }, { rpc: true })
//   .then(function (result) {
//     // console.log('result:', result);
//   });

//   ++i;
//   if (i >= 20) {
//     interval = clearInterval(interval);
//   }
// }, 1000);

producer.connect()
.then(function (_res) {
  // console.log('result:', _res);
});

// producer.connect()
// .then(function (_res) {
//   console.log('result:', _res);
// });

// producer.connect()
// .then(function (_res) {
//   console.log('result:', _res);
// });

