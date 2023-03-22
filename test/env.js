const docker = require('./docker');

exports.mochaHooks = {
  async beforeAll() {
    process.on('unhandledRejection', (reason) => {
      // This makes unhandled promise rejection fail the tests with the uncaught error. Otherwise the error is ignored.
      throw reason;
    });
    await docker.start();
  },
};
