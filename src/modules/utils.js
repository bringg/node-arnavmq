const uuid = require('uuid');

function empty() {}

const emptyLogger = {
  info: empty,
  debug: empty,
  warn: empty,
  error: empty,
  log: empty,
};

/**
 * Generates a new correlation id to be used for message publication, or returns the correlation id from the options if one already exists.
 * @param {object} options The options object for publishing a message.
 * @returns {string} The correlation id.
 */
function getCorrelationId(options) {
  if (options.correlationId) {
    return options.correlationId;
  }
  return uuid.v4();
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

  getCorrelationId,
};
