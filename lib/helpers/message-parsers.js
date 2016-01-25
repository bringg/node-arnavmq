module.exports.in  = function(_msg) {
  if (_msg.properties.contentType === 'application/json') {
    return JSON.parse(_msg.content.toString());
  }

  return _msg.content.toString();
};

module.exports.out = function(content, options) {
  if (typeof content === 'object') {
    content = JSON.stringify(content);
    options.contentType = 'application/json';
  }

  return new Buffer(content);
};
