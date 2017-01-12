const exec = require('child_process').exec;
const utils = require('../src/modules/utils');

exec('docker rm rabbitmq-bunnymq');

module.exports.start = () => {
  exec('docker run -d --name=rabbitmq-bunnymq -p 5672:5672 rabbitmq:3.6; true && docker start rabbitmq-bunnymq');
  return utils.timeoutPromise(4500);
};

module.exports.stop = () => {
  exec('docker stop rabbitmq-bunnymq');
  return utils.timeoutPromise(1000);
};
