'use strict';

module.exports.getValidUrl = (urls) => {
  for (var i = 0, l = urls.length; i < l; ++i) {
    var url = urls[i];
    if (url && typeof url === 'string' && (url.indexOf('amqp://') === 0 || url.indexOf('amqps://') === 0)) {
      return url;
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
