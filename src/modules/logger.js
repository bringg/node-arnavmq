const { emptyLogger } = require('./utils');

let instance = emptyLogger;

module.exports = {
  /**
   * Sets the logger for the application.
   * Will set a new logger when the application configuration changes.
   * @param {object} logger The logger object.
   */
  setLogger(logger) {
    if (logger) {
      instance = logger;
    }
  },

  logger: Object.freeze({
    /**
     * Log a debug event.
     * @param {Object} event The log event.
     * @param {string} event.message A message describing the event.
     * @param {Error} [event.error] An 'Error' object if one is present.
     * @param {Object} [event.params] An object containing additional context for the event.
     */
    debug(event) {
      instance.debug(event);
    },

    /**
     * Log an info event.
     * @param {Object} event The log event.
     * @param {string} event.message A message describing the event.
     * @param {Error} [event.error] An 'Error' object if one is present.
     * @param {Object} [event.params] An object containing additional context for the event.
     */
    info(event) {
      instance.info(event);
    },

    /**
     * Log a warning event.
     * @param {Object} event The log event.
     * @param {string} event.message A message describing the event.
     * @param {Error} [event.error] An 'Error' object if one is present.
     * @param {Object} [event.params] An object containing additional context for the event.
     */
    warn(event) {
      instance.warn(event);
    },

    /**
     * Log an error event.
     * @param {Object} event The log event.
     * @param {string} event.message A message describing the event.
     * @param {Error} [event.error] An 'Error' object if one is present.
     * @param {Object} [event.params] An object containing additional context for the event.
     */
    error(event) {
      instance.error(event);
    },
  }),
};
