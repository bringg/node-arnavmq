const { exec } = require('child-process-promise');

const docker = process.env.CIRCLECI === 'true'
  ? 'ssh remote-docker \\ docker'
  : 'docker';

module.exports.run = () => exec(`${docker}  run -d --name=rabbitmq-bunnymq -p 5672:5672 rabbitmq:3.7`);
module.exports.start = () => exec(`${docker} start rabbitmq-bunnymq`);
module.exports.stop = () => exec(`${docker} stop rabbitmq-bunnymq`);
module.exports.rm = () => exec(`${docker} rm -f rabbitmq-bunnymq || true`);
