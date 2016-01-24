var consumer = require('../../index')().consumer;

consumer.consume('circleArea', function (_msg) {
  _msg = JSON.parse(_msg);

  var area = Math.pow(parseInt(_msg.r), 2) * Math.PI;

  console.log('Circle area is: ', area);

  return area;
});

consumer.consume('squareArea', function (_msg) {
  _msg = JSON.parse(_msg);

  var area = Math.pow(parseInt(_msg.l), 2);

  console.log('Square area is: ', area);

  return area;
});

consumer.consume('triangleArea', function (_msg) {
  _msg = JSON.parse(_msg);

  var area = parseInt(_msg.b) * parseInt(_msg.h) * 1 / 2;

  console.log('Triangle area is: ', area);

  return area;
});
