const { serializeError, deserializeError } = require('serialize-error');
/**
 * Incoming message parser - parse message based on headers
 * @param  {object} msg An amqp.node incoming message
 * @return {any}      a string, object, number to send. Something stringifiable
 */
module.exports.in = (msg) => {
  // if sender put a json header, we parse it to avoid the pain for the consumer
  if (msg.content) {
    if (!msg.properties.contentLength) {
      msg.properties.contentLength = msg.content.length;
    }

    if (msg.properties.contentType === 'application/json') {
      const content = JSON.parse(msg.content.toString());
      if (content && content.error && content.error instanceof Object) {
        content.error = deserializeError(content.error);
      }
      return content;
    }

    if (msg.content.length) {
      return msg.content.toString();
    }
  }

  return undefined;
};

/**
 * Outgoing message parser - add header tags for receiver processing
 * @param  {any} content a string, object, number to send. Something serializable / bufferable
 * @param  {object} options amqp.node message options object
 * @return {Buffer}         node.js Buffer object, sent by amqp.node
 */
module.exports.out = (content, options) => {
  let parsedContent = content;
  const falsie = [undefined, null];
  if (!falsie.includes(content) && typeof content !== 'string') {
    if (parsedContent.error instanceof Error) {
      parsedContent.error = serializeError(parsedContent.error);
    }
    // if content is not a string, we JSONify it (JSON.parse can handle numbers, etc. so we can skip all the checks)
    parsedContent = JSON.stringify(parsedContent);
    options.contentType = 'application/json';
  } else if (falsie.includes(parsedContent)) {
    return Buffer.from([]);
  }

  return Buffer.from(parsedContent, 'utf-8');
};
