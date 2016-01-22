

module.exports.isValidUrl = function(_url) {
  if (_url && typeof _url === 'string' && _url.indexOf('amqp://') === 0) {
    return true;
  }

  return false;
};

module.exports.parseMsg  = function(_msg) {
  if (_msg.properties.contentType === 'application/json') {
    return JSON.parse(_msg.content.toString());
  }

  return _msg.content.toString();
};
