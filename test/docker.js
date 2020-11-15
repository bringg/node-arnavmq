const { exec } = require('child-process-promise');

const docker = 'docker';
const containerName = 'arnavmq-tests';

module.exports.run = () => exec(`${docker} run --detach --name=${containerName} -p 5672:5672 rabbitmq:3.8-alpine`);
module.exports.start = () => exec(`${docker} start ${containerName}`);
module.exports.stop = () => exec(`${docker} stop ${containerName}`);
module.exports.rm = () => exec(`${docker} rm --force --volumes ${containerName} || true`);
