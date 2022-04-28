/**
 * A function to generate a pause in promise chaining
 * @param  {number} timer How much ws to wait
 * @return {Promise}      A Promise that will resolve when timer is expired
 */
module.exports.timeoutPromise = (timer) => new Promise((resolve) => {
  setTimeout(resolve, timer);
});

function empty() {}

/**
 * Default transport to prevent any printing in the terminal
 * @type {Object} - empty logger overwriting the console object methods
 */
module.exports.emptyTransport = {
  info: empty,
  debug: empty,
  warn: empty,
  error: empty,
  log: empty
};
