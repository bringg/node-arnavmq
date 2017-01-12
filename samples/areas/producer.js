const producer = require('../../src/index')().producer;

producer.produce('circleArea', { toDo: 'Calculate circle area', r: 10 });

producer.produce('squareArea', { toDo: 'Calculate square area', l: 12 });

producer.produce('triangleArea', { toDo: 'Calculate triangle area', b: 2, h: 7 });
