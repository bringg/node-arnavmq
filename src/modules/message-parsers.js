/**
 * Incoming message parser - parse message based on headers
 * @param  {object} _msg An amqp.node incoming message
 * @return {any}      a string, object, number to send. Something stringifiable
 */
module.exports.in = (_msg) => {
  //if sender put a json header, we parse it to avoid the pain for the consumer
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

/**
 * Outgoing message parser - add header tags for receiver processing
 * @param  {any} content a string, object, number to send. Something serializable / bufferable
 * @param  {object} options amqp.node message options object
 * @return {Buffer}         node.js Buffer object, sent by amqp.node
 */
module.exports.out = (content, options) => {
  if (content !== undefined && typeof content !== 'string') {
    //if content is not a string, we JSONify it (JSON.parse can handle numbers, etc. so we can skip all the checks)
    content = JSON.stringify(content);
    options.contentType = 'application/json';
  } else if (content === undefined) {
    return new Buffer(0);
  }

  return new Buffer(content);
};
