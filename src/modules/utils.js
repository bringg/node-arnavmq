'use strict';

/**
 * A function to generate a pause in promise chaining
 * @param  {number} timer How much ws to wait
 * @return {Promise}      A Promise that will resolve when timer is expired
 */
module.exports.timeoutPromise = (timer) => {
  return new Promise((resolve) => {
    setTimeout(resolve, timer);
  });
};

/**
 * Merge second object into first object (modify first object in memory, NO COPY)
 * @param  {object} first  the first object that will receive content from second parameter
 * @param  {object} second the second object to merge in first parameter
 * @return {object}        merge result
 */
module.exports.mergeObjects = (first, second) => {
  for (var attrname in second) {
    first[attrname] = second[attrname];
  }
  return first;
};


/**
 * Default logger to prevent any printing in the terminal
 * @type {Object} - empty logger overwriting the console object methods
 */
module.exports.emptyLogger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
  log: () => {}
};
