const { exec } = require('child-process-promise');

module.exports.start = () => exec('docker run -d --name=rabbitmq-bunnymq -p 5672:5672 rabbitmq:3.6; true && '
    + 'docker start rabbitmq-bunnymq');

module.exports.stop = () => exec('docker stop rabbitmq-bunnymq');
module.exports.rm = () => exec('docker rm -f rabbitmq-bunnymq || true');
