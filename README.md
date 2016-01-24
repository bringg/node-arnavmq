# BunnyMq
BunnyMq is a RabbitMq wrapper build on top of [amqp.node](https://github.com/squaremo/amqp.node) to ease process of sending/receiving messages.

![mongoat gif](./medias/bunny.gif)

## Features
- Consume message from named queue
- Produce message to named queue
- Publish/Subscribe (comming soon)
- Routing keys (comming soon)

## Installation
```
npm install bunnymq
```

## Basic usage

### Consumer
Consumer also called subscriber, is responsible of handling message from the queue with which is binded.

```javascript
var consumer = require('bunnymq')().consumer;

consumer.connect('amqp://localhost') // you can passe url or use it in config or env var as explained below in section env vars the default is 'amqp://localhost'
.then(function (_channel) {
    consumer.consume('queueName', function (_msg) {
        // do something with _msg, the mgs will be acknowledged
        
        // if you throw an error, the msg will be requeued
        // ex: throw new Error('any kind of error');
    }); 
});
```

NB: you can use consumer.consume without making a connect, it will be called internally:

```javascript
var consumer = require('bunnymq')().consumer;

consumer.consume('queueName', function (_msg) {
});
```


### Producer
Producer also called publisher, is responsible of sending message to the queue with which is binded.

```javascript
var producer = require('bunnymq')().producer;

producer.connect('amqp://localhost')
.then(function (_channel) {
    producer.produce('queueName', message); // message can be of any type 
});
```

NB: you can use producer.produce without making a connect, it will be called internally:

```javascript
var consumer = require('bunnymq')().consumer;

consumer.consume('queueName', function (_msg) {
});
```

## Env vars

### Logging
You can enable logs for the module by setting the env var ```BUNNYMQ_DEBUG``` to any value. If you have winston installed, it will use it, otherwise it will fallback to console.

### Prefetch
You can set the env var ```BUNNYMQ_PREFETCH``` to the prefetch number you want.

### Connection
You can set the env var ```BUNNYMQ_URL``` to a valid amqp or ampqs url.

## Config
You can specify a config object as below:

```javascript
  var BunnyMq = require('bunnymq')({
    amqpUrl: 'amqp://localhost', // use your amqp or amqps url
    prefetch: 1, // use your prefetch number
    isRequeueEnabled: true // to allow requeueing 
  });

  var consumer = BunnyMq.consumer;  
  var producer = BunnyMq.producer;  
```

If you don't specify a config object, BunnyMq will use the default one which looks like:
```javascript

// index.js file
var defaultConfig = {
  amqpUrl: process.env.BUNNYMQ_URL || 'amqp://localhost', // use env var or fallback url 
  prefetch: process.env.BUNNYMQ_PREFETCH || 1, // use env var or fallback to 1
  isRequeueEnabled: true
};

module.exports = function(config) {
  require('./lib/boot/logger');

  return {
    producer: require('./lib/producer')(config || defaultConfig),
    consumer: require('./lib/consumer')(config || defaultConfig)
  };
};

```

NB: the priority is always given to the config then the env vars then fallback to default values, so if you want to use env vars you can use them directly without specifying the config object or use a config object which looks like the default one.

## Resources    
 - http://www.rabbitmq.com/getstarted.html
 - https://www.cloudamqp.com/blog/2015-05-18-part1-rabbitmq-for-beginners-what-is-rabbitmq.html
 - http://spring.io/blog/2010/06/14/understanding-amqp-the-protocol-used-by-rabbitmq/


## Tests
1. Ensure that you have an instance of a rabbitMq server running locally
2. Run tests ``` npm test```

Or to show up code coverage ``` npm run cover ```
it will generate ``` ./coverage ``` folder

## Contribution
Please read our [Contributing Guidlines](CONTRIBUTING.md) before submitting a pull request or an issue !

## License
The MIT License [MIT](LICENSE)

Copyright (c) 2015 Dial Once
