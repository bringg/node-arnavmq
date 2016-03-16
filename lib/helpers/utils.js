'use strict';

module.exports.getValidUrl = (_urls) => {
  for (var i = 0, l = _urls.length; i < l; ++i) {
    if (_urls[i] && typeof _urls[i] === 'string' && (_urls[i].indexOf('amqp://') === 0 || _urls[i].indexOf('amqps://') === 0)) {
      return _urls[i];
    }
  }

  return 'amqp://localhost';
};

module.exports.pushIfNotExist = (array, value) => {
  for (var i = 0, l = array.length; i < l; ++i) {
    if (array[i].queue === value.queue) {
      return array;
    }
  }

  array.push(value);
  return array;
};

module.exports.timeoutPromise = (timer) => {
  return new Promise((resolve) => {
    setTimeout(resolve, timer);
  });
};
