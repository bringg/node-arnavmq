var winston;
try {
    winston = require('winston');
}
catch(e) {}

if (!process.env.AMQP_DEBUG) {
  global.Logger = {
    log: function() {},
    info: function() {},
    error: function() {},
    warn: function() {},
  };
} else if(winston) {
  global.Logger = winston;
} else {
  global.Logger = console;
}
