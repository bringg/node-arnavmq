# node-bunnymq

![Github Actions](https://github.com/bringg/node-bunnymq/workflows/.github/workflows/tests.yml/badge.svg?branch=develop)
[![npm](https://img.shields.io/npm/v/bunnymq.svg)]()
[![npm](https://img.shields.io/npm/dt/bunnymq.svg)]()

[![npm](https://nodei.co/npm/bunnymq.png?downloads=true&downloadRank=true&stars=true)](https://nodei.co/npm/bunnymq/)

## Features
- Subscriber (consumer)
- Publisher (producer)
- RPC (get answers from subscriber automatically)
- Auto connect/reconnect/queue messages
- Handle errors / requeing when message callback fails
- Messages types caring using AMQP headers for content type (send as objects and receive as objects)

## Installation
**bunnymq requires nodejs 6 or harmony flags!** because it uses es6 features outside strict mode.
```
npm install bunnymq
```

## Basic usage
### Publisher
Producer (publisher), can send messages to a named queue.

```javascript
const bunnymq = require('bunnymq')({ host: 'amqp://localhost' });
bunnymq.publish('queue:name', 'Hello World!');
```

### Subscriber
Consumer (subscriber), can handle messages from a named queue.

```javascript
const bunnymq = require('bunnymq')({ host: 'amqp://localhost' });

bunnymq.subscribe('queue:name', function (msg) {
  //msg is the exact item sent by a producer as payload
  //if it is an object, it is already parsed as object
});
```

## RPC Support
You can create RPC requests easily by adding the `rpc: true` option to the `produce` call:
```javascript
bunnymq.subscribe('queue:name', function() {
  return 'hello world!'; //you can also return a promise if you want to do async stuff
});

bunnymq.publish('queue:name', { message: 'content' }, { rpc: true, timeout: 1000 })
.then(function(consumerResponse) {
  console.log(consumerResponse); // prints hello world!
});
```
The optional `timeout` option results in a rejection when no answer has been received after the given amount of milliseconds.
When '0' is given, there will be no timeout for this call.
This value will overwrite the default timeout set in the config in `rpcTimeout`.

## Routing keys
You can send publish commands with routing keys (thanks to @nekrasoft)
```javascript
bunnymq.publish('queue:name', { message: 'content' }, { routingKey: 'my-routing-key' });
```

## Config
You can specify a config object, properties and default values are:

```javascript
  const bunnymq = require('bunnymq')({
    host: 'amqp://localhost',
    //number of fetched messages at once on the channel
    prefetch: 5,
    //requeue put back message into the broker if consumer crashes/trigger exception
    requeue: true,
    //time between two reconnect (ms)
    timeout: 1000,
    //default timeout for RPC calls. If set to '0' there will be none.
    rpcTimeout: 1000,
    consumerSuffix: '',
    //generate a hostname so we can track this connection on the broker (rabbitmq management plugin)
    hostname: process.env.HOSTNAME || process.env.USER || uuid.v4(),
    //the transport to use to debug. if provided, bunnymq will show some logs
    transport: utils.emptyLogger
  });
```

You can override any or no of the property above.

<b>Note:</b> if you enable the debug mode using the `AMQP_DEBUG=true` env var, but you do not attach any transport logger, the module will fallback to console.

## Env vars
Deprecated as of 2.1.0, don't use env vars to configure the module, see Config section.

## Documentation & resources
To generate documentation, just run ``` npm run docs```, it will create a docs folder.

You can also find more about RabbitMq in the links below:
 - http://www.rabbitmq.com/getstarted.html
 - https://www.cloudamqp.com/blog/2015-05-18-part1-rabbitmq-for-beginners-what-is-rabbitmq.html
 - http://spring.io/blog/2010/06/14/understanding-amqp-the-protocol-used-by-rabbitmq/

## Tests
Requirements:
  - docker
  - npm

Run `npm i` once and then `npm test` to launch the test suite.

## License
The MIT License [MIT](LICENSE)
