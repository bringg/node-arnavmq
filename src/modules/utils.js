const crypto = require('crypto');

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
  return crypto.randomUUID();
}

/**
 * Resolves with `promise`, or rejects once `timeoutMs` elapses - whichever happens first.
 * @param {Promise} promise
 * @param {number} timeoutMs
 * @param {string} what Described in the timeout error message.
 * @return {Promise}
 */
async function withTimeout(promise, timeoutMs, what) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
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

  withTimeout,
};
