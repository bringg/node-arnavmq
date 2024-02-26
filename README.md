# ArnavMQ

[![npm](https://img.shields.io/npm/v/arnavmq.svg)](https://www.npmjs.com/package/arnavmq)
[![CI](https://github.com/bringg/node-arnavmq/workflows/CI/badge.svg)](https://github.com/bringg/node-arnavmq/actions?query=branch%3Amaster)

**Disclaimer**:

This project is a hard-fork of [dial-once/node-bunnymq](https://github.com/dial-once/node-bunnymq).
The original project seems like not maintained anymore, in fact most recent releases in the original repo were driven by the people who are maintaining this fork.

Many thanks the original authors of `bunnymq` for their work and for such an easy to use library.
With this fork we aim to fix all outstading bugs, make the library more stable, and continue adding features as needed.

In order to avoid confusion with the original project we decided to rename it to `ArnavMQ`.
Arnav (**ארנב**) is a Hebrew word which means Rabbit, yes how original ;) .

## About

**ArnavMQ** is an `amqp.node` wrapper to ease common AMQP usages (RPC, pub/sub, channel/connection handling etc...)

### Features

- Subscriber (consumer)
- Publisher (producer)
- RPC (get answers from subscriber automatically)
- Auto connect/reconnect/queue messages
- Handle errors and re-queing when message callback fails
- Messages types caring using AMQP headers for content type (send as objects and receive as objects)

## Installation

```shell
npm install arnavmq
```

## Basic usage

### Publisher

Producer (publisher), can send messages to a named queue.

```javascript
const arnavmq = require('arnavmq')({ host: 'amqp://localhost' });
arnavmq.publish('queue:name', 'Hello World!');
```

### Subscriber

Consumer (subscriber), can handle messages from a named queue.

```javascript
const arnavmq = require('arnavmq')({ host: 'amqp://localhost' });

arnavmq.subscribe('queue:name', function (msg) {
  // msg is the exact item sent by a producer as payload
  // if it is an object, it is already parsed as object
});
```

You can pass to consumer options, like:

```javascript
const arnavmq = require('arnavmq')({ host: 'amqp://localhost' });

const options = {
  persistent: true,
  durable: true,
  channel: {
    // You can override the global prefetch for this specific consumer
    //
    // Calling multiple times to "subscribe" with same queue but different custom prefetch
    // will throw an error
    prefetch: 10,
  },
};

arnavmq.subscribe('queue:name', options, function (msg) {
  // msg is the exact item sent by a producer as payload
  // if it is an object, it is already parsed as object
});
```

## RPC Support

You can create RPC requests easily by adding the `rpc: true` option to the `produce` call:

```javascript
arnavmq.subscribe('queue:name', function () {
  return 'hello world!'; // you can also return a promise if you want to do async stuff
});

arnavmq.publish('queue:name', { message: 'content' }, { rpc: true, timeout: 1000 }).then(function (consumerResponse) {
  console.log(consumerResponse); // prints hello world!
});
```

The optional `timeout` option results in a rejection when no answer has been received after the given amount of milliseconds.
When '0' is given, there will be no timeout for this call.
This value will overwrite the default timeout set in the config in `rpcTimeout`.

## Routing keys

You can send publish commands with routing keys (thanks to @nekrasoft)

```javascript
arnavmq.publish('queue:name', { message: 'content' }, { routingKey: 'my-routing-key' });
```

## Hooks

You can register callbacks to be invoked on certain events:

```javascript
const arnavmq = require('arnavmq')({
  host: 'amqp://localhost',
  // Can pass hooks directly on connection configuration.
  hooks: {
    connection: {
      beforeConnect: () => {
        /*...*/
      },
    },
  },
});

arnavmq.hooks.connection.afterConnect(({ connection, config }) => {
  console.log('Connected to ' + config.host);
});

arnavmq.hooks.producer.beforeProduce(({ properties /*... other parameters ...*/ }) => {
  // Message properties and other options objects can be changed, for example to set a message id:
  properties.messageId = randomUUID();
});

// Can register a single callback at a time or multiple callbacks at once.
arnavmq.hooks.consumer.afterProcessMessage([afterProcessCallback1, afterProcessCallback2]);
```

For full details of the available hooks and callback signatures, check the documentation on the files:

- [Connection](src/modules/hooks/connection_hooks.js)
- [Consumer](src/modules/hooks/consumer_hooks.js)
- [Producer](src/modules/hooks/producer_hooks.js)

## Config

You can specify a config object, properties and default values are:

```javascript
const arnavmq = require('arnavmq')({
  // amqp connection string
  host: 'amqp://localhost',

  // number of fetched messages at once on the channel
  prefetch: 5,

  // requeue put back message into the broker if consumer crashes/trigger exception
  requeue: true,

  // time between two reconnect (ms)
  timeout: 1000,

  // the maximum number of retries when trying to send a message before throwing error when failing. If set to '0' will not retry. If set to less then '0', will retry indefinitely.
  producerMaxRetries: -1,

  // default timeout for RPC calls. If set to '0' there will be none.
  rpcTimeout: 1000,

  // suffix all queues names
  // ex: service-something with suffix :ci becomes service-suffix:ci etc.
  consumerSuffix: '',

  // generate a hostname so we can track this connection on the broker (rabbitmq management plugin)
  hostname: process.env.HOSTNAME || process.env.USER || uuid.v4(),

  /**
   * A logger object with a log function for each of the log levels ("debug", "info", "warn", or "error").
   * Each log function receives one parameter containing a log event with the following fields:
   * * message - A string message describing the event. Always present.
   * * error - An 'Error' object in case one is present.
   * * params - An optional object containing extra parameters that can provide extra context for the event.
   */
  logger: utils.emptyLogger,
});
```

You can override any or no of the property above.

**Note:** if you enable the debug mode using the `AMQP_DEBUG=true` env var, but you do not attach any logger, the module will fallback to console.

## Documentation & resources

Find more about RabbitMQ in the links below:

- <http://www.rabbitmq.com/getstarted.html>
- <https://www.cloudamqp.com/blog/2015-05-18-part1-rabbitmq-for-beginners-what-is-rabbitmq.html>
- <http://spring.io/blog/2010/06/14/understanding-amqp-the-protocol-used-by-rabbitmq/>

## Tests

Requirements:

- docker
- npm

Run `npm i` once and then `npm test` to launch the test suite.

## License

The MIT License [MIT](LICENSE)
