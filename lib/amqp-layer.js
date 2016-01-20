var amqp = require('amqplib');
var winston = require('winston');

var amqpUrl, intervalID;

function connect(_amqpUrl) {
  amqpUrl = amqpUrl || _amqpUrl || process.env.AMQP_URL || 'amqp://localhost';

  return amqp.connect(amqpUrl)
  .then(function (_connection) {
    _connection.on('close', reconnect);
    _connection.on('error', reconnect);

    intervalID = clearInterval(intervalID);

    return _connection.createChannel()
    .then(function (_channel) {
      return _channel;
    });
  }).catch(function (err) {
    winston.error(err);
    reconnect();
  });
}

function reconnect() {
  if (!intervalID) {
    intervalID = setInterval(connect, 1000);
  }
}

module.exports = function () {
  return {
    connect: connect,
    reconnect: reconnect
  };
};
