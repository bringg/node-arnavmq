var amqp = require('amqplib');

var amqpUrl, amqpConnection, intervalID;

function connect(_amqpUrl) {
  amqpUrl = amqpUrl || _amqpUrl || process.env.AMQP_URL || 'amqp://localhost';

  return amqp.connect(amqpUrl)
  .then(function (_connection) {
    amqpConnection = _connection;

    _connection.on('close', reconnect);
    _connection.on('error', reconnect);

    intervalID = clearInterval(intervalID);

    return createChannel();
  });
}

function createChannel() {
  return amqpConnection.createChannel()
  .then(function (_channel) {
    _channel.on('close', recreateChannel);
    _channel.on('error', recreateChannel);

    intervalID = clearInterval(intervalID);

    return _channel;
  });
}

function recreateChannel() {
  if (!intervalID) {
    intervalID = setInterval(createChannel, 1000);
  }
}

function reconnect() {
  if (!intervalID) {
    intervalID = setInterval(connect, 1000);
  }
}

function disconnect() {
  if (amqpConnection) {
    amqpConnection.close();
  }
}

module.exports = function () {
  return {
    connect: connect,
    reconnect: reconnect,
    disconnect: disconnect
  };
};
