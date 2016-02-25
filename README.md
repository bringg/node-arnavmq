# BunnyMq
BunnyMq is a [amqp.node](https://github.com/squaremo/amqp.node) wrapper to ease common AMQP usages

![bunny gif](./medias/bunny.gif)

## Features
- Consumer
- Producer
- RPC
- Auto connect/reconnect/queue messages
- Handle errors / requeing
- Messages types caring using AMQP headers for content type

## Installation
```
npm install bunnymq
```

## Basic usage
### Producer
Producer (publisher), can send messages to a named queue.

```javascript
var consumer = require('bunnymq')().producer;
producer.produce('queueName', 'Hello World!');
```

### Consumer
Consumer (subscriber), can handle messages from a named queue.

```javascript
var consumer = require('bunnymq')().consumer;

consumer.consume('queueName', function (_msg) {
  //_msg is the exact item sent by a producer as payload
  //if it is an object, it is already parsed as object
});
```

## RPC Support
You can create RPC requests easily be adding an option to the current message:
```javascript
consumer.consume('queueName', function() {
  return 'hello world!'; //you can also return a promise if you want to do async stuff
});

producer.produce('queueName', { message: 'content' }, { rpc: true })
.then(function(consumerResponse) {
  console.log(consumerResponse); // prints hello world!
});
```

## Config
You can specify a config object in the BunnyMQ main function, properties not set are using default value:

```javascript
  var BunnyMq = require('bunnymq')({
    amqpUrl: 'amqp://localhost', // default
    prefetch: 1, // default
    isRequeueEnabled: true // default
  });
```

## Env vars

### Logging
You can enable logs for the module by setting the env var ```AMQP_DEBUG``` to any value. If you have winston installed, it will use it, otherwise it will fallback to console.

### Prefetch
You can set the env var ```AMQP_PREFETCH``` to set the prefetch value of all underlying AMQP queues.

### Connection
You can set the env var ```AMQP_URL``` to a valid amqp or ampqs url.

NB: the priority is always given to the config then the env vars then fallback to default values, so if you want to use env vars you can use them directly without specifying the config object or use a config object which looks like the default one.

## Documentation & resources
To generate documentattion, just run ``` npm run docs```, it will create a docs folder.

You can also find more about RabbitMq in the links below:
 - http://www.rabbitmq.com/getstarted.html
 - https://www.cloudamqp.com/blog/2015-05-18-part1-rabbitmq-for-beginners-what-is-rabbitmq.html
 - http://spring.io/blog/2010/06/14/understanding-amqp-the-protocol-used-by-rabbitmq/

## Tests
1. Ensure that you have a RabbitMQ server running
2. Run tests ``` npm test```
3. Coverage is done with ``npm run cover``

## Contribution
If you want to contribute, you are very welcome!
Please read our [Contributing Guidlines](CONTRIBUTING.md)

## License
The MIT License [MIT](LICENSE)

Copyright (c) 2015 Dial Once
