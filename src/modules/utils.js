const uuid = require('uuid');

function empty() {}

const emptyLogger = {
  info: empty,
  debug: empty,
  warn: empty,
  error: empty,
  log: empty,
};

function setCorrelationId(options) {
  if (options.correlationId) {
    return options.correlationId;
  }
  const corrId = uuid.v4();
  const updatedOptions = options;
  updatedOptions.correlationId = corrId;

  return corrId;
}

module.exports = {
  /**
   * Default logger to prevent any printing in the terminal
   * @type {Object} - empty logger overwriting the console object methods
   */
  emptyLogger,

  /**
   * A function to generate a pause in promise chaining
   * @param  {number} timer How much ws to wait
   * @return {Promise}      A Promise that will resolve when timer is expired
   */
  timeoutPromise: (timer) =>
    new Promise((resolve) => {
      setTimeout(resolve, timer);
    }),

  /**
   * Generates a uuid and sets it as the 'correlationId' of the given message properties, if there isn't any already.
   */
  setCorrelationId,
};
