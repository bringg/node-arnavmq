const logLevels = require('./logLevels');

function empty() {}

const emptyTransport = {
  log: empty
};
// Initialize all log levels to be "empty".
Object.keys(logLevels).forEach((level) => { emptyTransport[logLevels[level]] = empty; });

module.exports = {
  /**
   * Default transport to prevent any printing in the terminal
   * @type {Object} - empty logger overwriting the console object methods
   */
  emptyTransport,

  /**
   * A function to generate a pause in promise chaining
   * @param  {number} timer How much ws to wait
   * @return {Promise}      A Promise that will resolve when timer is expired
   */
  timeoutPromise: (timer) => new Promise((resolve) => {
    setTimeout(resolve, timer);
  })
};
