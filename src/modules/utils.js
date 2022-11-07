function empty() {}

const emptyLogger = {
  info: empty,
  debug: empty,
  warn: empty,
  error: empty,
  log: empty
};

module.exports = {
  /**
   * Default transport to prevent any printing in the terminal
   * @type {Object} - empty logger overwriting the console object methods
   */
  emptyLogger,

  /**
   * @deprecated
   * For backwards compatibility with the `transport` configuration.
   */
  emptyTransport: emptyLogger,

  /**
   * A function to generate a pause in promise chaining
   * @param  {number} timer How much ws to wait
   * @return {Promise}      A Promise that will resolve when timer is expired
   */
  timeoutPromise: (timer) => new Promise((resolve) => {
    setTimeout(resolve, timer);
  }),

  /**
   * A function that allows to emit warnings for a specified code. The idea is to
   * limit a warning emission to one per a specific code.
   * @param warning - {code: string, detail: string, message: string}
   */
  emitWarn: function emitWarn(warning) {
    const { code, message, detail } = warning;
    if (!emitWarn.warned) {
      emitWarn.warned = {};
    }
    if (!emitWarn.warned[code]) {
      emitWarn.warned[code] = true;
      process.emitWarning(message, { code, detail });
    }
  }
};
