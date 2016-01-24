var winston = require('winston');

var isLogEnabled = true;

var enableDisableLog = function (_isLogEnabled) {
  if (typeof _isLogEnabled === 'boolean') {
    isLogEnabled = _isLogEnabled;
  }
};

var log = function (_type) {
  if (isLogEnabled) {
    winston[_type].apply(null, Array.prototype.slice.call(arguments, 1));
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
