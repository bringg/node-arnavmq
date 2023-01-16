const docker = require('./docker');

exports.mochaHooks = {
  async beforeAll() {
    await docker.start();
  },
};
