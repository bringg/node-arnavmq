'use strict';

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


module.exports.emptyLogger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
  log: () => {}
};
