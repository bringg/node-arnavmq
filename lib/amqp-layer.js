var amqp = require('amqplib');
var winston = require('winston');

var amqpUrl, intervalID, connection, channel, connected, connecting;

connecting = false;
connected = false;

function connect(_amqpUrl) {
  connecting = true;

  amqpUrl = amqpUrl || _amqpUrl || process.env.AMQP_URL || 'amqp://localhost';

  return amqp.connect(amqpUrl)
  .then(function (_connection) {
    connected = true;

    connection = _connection;

    connection.on('close', reconnect);
    connection.on('error', reconnect);

    intervalID = clearInterval(intervalID);

    return connection.createChannel()
    .then(function (_channel) {
      channel = _channel;

      return channel;
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
