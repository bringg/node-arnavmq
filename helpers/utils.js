
module.exports.getValidUrl = function(_urls) {
  for (var i = 0, l = _urls.length; i < l; ++i) {
    if (_urls[i] && typeof _urls[i] === 'string' && (_urls[i].indexOf('amqp://') === 0 || _urls[i].indexOf('amqps://') === 0)) {
      return _urls[i];
    }
  }

  return 'amqp://localhost';
};

module.exports.parseMsg  = function(_msg) {
  if (_msg.properties.contentType === 'application/json') {
    return JSON.parse(_msg.content.toString());
  }

  return _msg.content.toString();
};
