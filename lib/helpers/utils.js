
module.exports.getValidUrl = function(_urls) {
  for (var i = 0, l = _urls.length; i < l; ++i) {
    if (_urls[i] && typeof _urls[i] === 'string' && (_urls[i].indexOf('amqp://') === 0 || _urls[i].indexOf('amqps://') === 0)) {
      return _urls[i];
    }
  }

  return 'amqp://localhost';
};


module.exports.pushIfNotExist = function (array, value) {
  for (var i = 0, l = array.length; i < l; ++i) {
    if (array[i].queue === value.queue &&
        array[i].options === value.options &&
        (array[i].callback === value.callback || array[i].msg === value.msg)) {
      return array;
    }
  }

  array.push(value);

  return array;
};
