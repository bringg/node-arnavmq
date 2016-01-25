module.exports.in  = function(_msg) {
  if (_msg.properties.contentType === 'application/json') {
    try {
      return JSON.parse(_msg.content.toString());
    } catch(e) {}
  }

  return _msg.content.toString();
};

module.exports.out = function(content, options) {
  if (content) {
    content = JSON.stringify(content);
    options.contentType = 'application/json';
  }

  return new Buffer(content);
};
