'use strict';

module.exports.in = (_msg) => {
  if (_msg.properties.contentType === 'application/json') {
    try {
      return JSON.parse(_msg.content.toString());
    } catch(e) {}
  }

  if (_msg.content.length) {
    return _msg.content.toString();
  } else {
    return undefined;
  }
};

module.exports.out = (content, options) => {
  if (content !== undefined && typeof content !== 'string') {
    content = JSON.stringify(content);
    options.contentType = 'application/json';
  } else if (content === undefined) {
    return new Buffer(0);
  }

  return new Buffer(content);
};
