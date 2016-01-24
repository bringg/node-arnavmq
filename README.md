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

consumer.connect('amqp://localhost')
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

## Logging
You can enable logs for the module by setting the env var BUNNYMQ_DEBUG to any value. If you have winston installed, it will use it, otherwise it will fallback to console.

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
