var winston = require('winston');

var isLogEnabled = true;

var enableDisableLog = function (_isLogEnabled) {
  if (typeof _isLogEnabled === 'boolean') {
    isLogEnabled = _isLogEnabled;
  }
};

var log = function (_type, _message, _metadata) {
  if (isLogEnabled) {
    winston[_type](_message, _metadata || '');
  }
};

module.exports = function (_isLogEnabled) {
  if (typeof _isLogEnabled === 'boolean') {
    isLogEnabled = _isLogEnabled;
  }

  return {
    enableDisableLog: enableDisableLog,
    log: log
  };
};
