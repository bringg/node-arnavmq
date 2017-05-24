const consumer = require('../../src/index')().consumer;
const { logger } = require('@dialonce/boot')();

/* eslint no-param-reassign: "off" */
consumer.consume('circleArea', (msg) => {
  msg = JSON.parse(msg);

  const area = (parseInt(msg.r, 10) ** 2) * Math.PI;

  logger.info('Circle area is: ', area);

  return area;
});

consumer.consume('squareArea', (msg) => {
  msg = JSON.parse(msg);

  const area = parseInt(msg.l, 10) ** 2;

  logger.info('Square area is: ', area);

  return area;
});

consumer.consume('triangleArea', (msg) => {
  msg = JSON.parse(msg);

  const area = parseInt(msg.b, 10) * parseInt(msg.h, 10) * 0.5;

  logger.info('Triangle area is: ', area);

  return area;
});
