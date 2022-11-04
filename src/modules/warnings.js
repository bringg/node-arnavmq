/**
 * This script is kind of dictionary for possible different types of warning in the lib.
 * Warning object is a value (string code is a key) and has the following structure:
 * @type {code: string, detail: string, message: string}
 */
module.exports = {
  ARNAVMQ_MSG_TIMEOUT_DEPRECATED: {
    code: 'ARNAVMQ_MSG_TIMEOUT_DEPRECATED',
    message: 'using timeout option on message level is deprecated',
    detail: 'Please use expiration instead'
  }
};
