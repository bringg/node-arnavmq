'use strict';

module.exports.in = (_msg) => {
  if (_msg.properties.contentType === 'application/json') {
    try {
      return JSON.parse(_msg.content.toString());
    } catch(e) {}
  }

  return _msg.content.toString();
};

module.exports.out = (content, options) => {
  if (content !== undefined && typeof content !== 'string') {
    content = JSON.stringify(content);
    options.contentType = 'application/json';
  }

  return new Buffer(content);
};
