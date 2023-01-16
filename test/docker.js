const { exec } = require('child-process-promise');
const utils = require('../src/modules/utils');

class Docker {
  constructor() {
    this.name = 'arnavmq-tests';
  }

  async start() {
    // We might be already running, let's cleanup so can a have a fresh start ;)
    await exec(`docker rm --force --volumes ${this.name} || true`);

    await exec(`docker run --detach --network=bridge --name=${this.name} -p 5672:5672 rabbitmq:3.8-alpine`);
    await this.waitForReady();
  }

  /**
   * Waits for RabbitMQ server to be up & ready with retries
   */
  async waitForReady() {
    let lastErr = null;

    for (let i = 0; i < 20; i += 1) {
      try {
        await exec(`docker exec ${this.name} rabbitmqctl status`);
        return;
      } catch (err) {
        lastErr = err;
        await utils.timeoutPromise(500);
      }
    }

    throw new Error(`RabbitMQ health check failed after 20 iterations: ${lastErr.message}`);
  }

  async isRunning() {
    try {
      const res = await exec(`docker container inspect -f '{{.State.Running}}' ${this.name}`);
      return res.stdout.trim() === 'true';
    } catch (err) {
      // We will get an error if container is not runnning.
      return false;
    }
  }

  /**
   * Disconnect RabbitMQ from network - so we can't access 5672 port.
   */
  async disconnectNetwork() {
    await exec(`docker network disconnect bridge ${this.name}`);
  }

  /**
   * Connects RabbitMQ to network
   *
   * Should be used after calling "disconnectNetwork"
   */
  async connectNetwork() {
    await exec(`docker network connect bridge ${this.name}`);
  }
}

const docker = new Docker();
module.exports = docker;
