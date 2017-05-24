/* eslint no-console: off */
const consumer = require('../../src/index')().consumer;

/* eslint no-param-reassign: "off" */
consumer.consume('circleArea', (msg) => {
  msg = JSON.parse(msg);

  const area = (parseInt(msg.r, 10) ** 2) * Math.PI;

  console.info('Circle area is: ', area);

  return area;
});

consumer.consume('squareArea', (msg) => {
  msg = JSON.parse(msg);

  const area = parseInt(msg.l, 10) ** 2;

  console.info('Square area is: ', area);

  return area;
});

consumer.consume('triangleArea', (msg) => {
  msg = JSON.parse(msg);

  const area = parseInt(msg.b, 10) * parseInt(msg.h, 10) * 0.5;

  console.info('Triangle area is: ', area);

  return area;
});
