/*    Copyright 2016 - 2021 Firewalla Inc 
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

'use strict';

const log = require('../../../net2/logger.js')(__filename);
const fs = require('fs');
const f = require('../../../net2/Firewalla.js');
const VPNClient = require('../VPNClient.js');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const exec = require('child-process-promise').exec;
const {Address4, Address6} = require('ip-address');
const {BigInteger} = require('jsbn');
const sysManager = require('../../../net2/SysManager.js');
const YAML = require('../../../vendor_lib/yaml');
const iptables = require('../../../net2/Iptables.js');
const wrapIptables = iptables.wrapIptables;
const routing = require('../../routing/routing.js');
const scheduler = require('../../../util/scheduler.js');

class DockerBaseVPNClient extends VPNClient {

  static async listProfileIds() {
    const dirPath = f.getHiddenFolder() + `/run/docker_vpn_client/${this.getProtocol()}`;
    const files = await fs.readdirAsync(dirPath);
    const profileIds = files.filter(filename => filename.endsWith('.settings')).map(filename => filename.slice(0, filename.length - ".settings".length));
    return profileIds;
  }

  _getSettingsPath() {
    return `${f.getHiddenFolder()}/run/docker_vpn_client/${this.constructor.getProtocol()}/${this.profileId}.settings`;
  }

  _getSubnetFilePath() {
    return `${f.getHiddenFolder()}/run/docker_vpn_client/${this.constructor.getProtocol()}/${this.profileId}.subnet`;
  }

  async _getRemoteIP() {
    const subnet = await fs.readFileAsync(this._getSubnetFilePath(), {encoding: "utf8"}).then(content => content.trim()).catch((err) => null);
    if (subnet) {
      return Address4.fromBigInteger(new Address4(subnet).bigInteger().add(new BigInteger("2"))).correctForm(); // IPv4 address of gateway in container always ends with .2 in /24 subnet
    }
    return null;
  }

  async destroy() {
    await super.destroy();
    await fs.unlinkAsync(this._getSettingsPath()).catch((err) => {});
    await fs.unlinkAsync(this._getSubnetFilePath()).catch((err) => {});
    await exec(`rm -rf ${this._getConfigDirectory()}`).catch((err) => {
      log.error(`Failed to remove config directory ${this._getConfigDirectory()}`, err.message);
    });
    await exec(`rm -rf ${this._getWorkingDirectory()}`).catch((err) => {
      log.error(`Failed to remove working directory ${this._getWorkingDirectory()}`, err.message);
    });
  }

  async getVpnIP4s() {
    const subnet = await fs.readFileAsync(this._getSubnetFilePath(), {encoding: "utf8"}).then(content => content.trim()).catch((err) => null);
    if (subnet)
      return Address4.fromBigInteger(new Address4(subnet).bigInteger().add(new BigInteger("1"))).correctForm(); // bridge ipv4 address always ends with .1 in /24 subnet
  }

  _generateRamdomNetwork() {
    const ipRangeRandomMap = {
      "10.0.0.0/8": 16,
      "172.16.0.0/12": 12,
      "192.168.0.0/16": 8
    };
    let index = 0;
    while (true) {
      index = index % 3;
      const startAddress = Object.keys(ipRangeRandomMap)[index]
      const randomBits = ipRangeRandomMap[startAddress];
      const randomOffsets = Math.floor(Math.random() * Math.pow(2, randomBits)) * 256; // align with 8-bit, i.e., /24
      const subnet = Address4.fromBigInteger(new Address4(startAddress).bigInteger().add(new BigInteger(randomOffsets.toString()))).correctForm();
      if (!sysManager.inMySubnets4(subnet))
        return subnet + "/24";
      else
        index++;
    }
  }

  async _updateComposeYAML() {
    // update docker-compose.yaml in working directory, main purpose is to generate randomized subnet for docker bridge network
    const composeFilePath = this._getWorkingDirectory() + "/docker-compose.yaml";
    const config = await fs.readFileAsync(composeFilePath, {encoding: "utf8"}).then(content => YAML.parse(content)).catch((err) => {
      log.error(`Failed to read docker-compose.yaml from ${composeFilePath}`, err.message);
      return;
    });
    if (config) {
      if (config.networks && config.networks.hasOwnProperty("default")) {
        config.networks.default = config.networks.default || {};
        config.networks.default["driver_opts"] = { "com.docker.network.bridge.name": this.getInterfaceName() };
        let subnet = await fs.readFileAsync(this._getSubnetFilePath(), {encoding: "utf8"}).then(content => content.trim()).catch((err) => null);
        if (!subnet) {
          subnet = this._generateRamdomNetwork(); // this returns a /24 subnet
          await fs.writeFileAsync(this._getSubnetFilePath(), subnet, {encoding: "utf8"}).catch((err) => {});
        }
        config.networks.default.ipam = {config: [{subnet}]};
        const key = Object.keys(config.services)[0]; // there has to be only one service being defined in docker-compose.yaml
        if (key) {
          const service = config.services[key];
          if (service && service.networks && service.networks.default) {
            service.networks.default["ipv4_address"] = await this._getRemoteIP();
          }
          service["container_name"] = this.getInterfaceName();
          // rewrite services section in docker-compose.yaml
          config.services = {};
          config.services[this.getInterfaceName()] = service;
        }
        await fs.writeFileAsync(composeFilePath, YAML.stringify(config), {encoding: "utf8"});
      } else {
        // network name has to be "default" in docker-compose.yaml
        log.error(`default network is not found in ${composeFilePath}`);
      }
    }
  }

  async _start() {
    await this.__prepareAssets();
    await exec(`mkdir -p ${this._getWorkingDirectory()}`);
    await exec(`cp -f -r ${this._getConfigDirectory()}/* ${this._getWorkingDirectory()}`);
    await this._updateComposeYAML();
    await exec(`sudo systemctl start docker-compose@${this.profileId}`);
    const remoteIP = await this._getRemoteIP();
    if (remoteIP)
      await exec(wrapIptables(`sudo iptables -w -t nat -A FW_POSTROUTING -s ${remoteIP} -j MASQUERADE`));
    let t = 0;
    while (t < 30) {
      const carrier = await fs.readFileAsync(`/sys/class/net/${this.getInterfaceName()}/carrier`, {encoding: "utf8"}).then(content => content.trim()).catch((err) => null);
      if (carrier === "1") {
        const remoteIP = await this._getRemoteIP();
        if (remoteIP) {
          // add the container IP to wan_routable so that packets from wan interfaces can be routed to the container
          await routing.addRouteToTable(remoteIP, null, this.getInterfaceName(), "wan_routable", null, 4);
        }
        break;
      }
      t++;
      await scheduler.delay(1000);
    }
  }

  async _stop() {
    const remoteIP = await this._getRemoteIP();
    if (remoteIP)
      await exec(wrapIptables(`sudo iptables -w -t nat -D FW_POSTROUTING -s ${remoteIP} -j MASQUERADE`)).catch((err) => {});
    await exec(`sudo systemctl stop docker-compose@${this.profileId}`);
  }

  async getRoutedSubnets() {
    const isLinkUp = await this._isLinkUp();
    if (isLinkUp) {
      const results = [];
      // no need to add the whole subnet to the routed subnets, only need to route the container's IP address
      const remoteIP = await this._getRemoteIP();
      if (remoteIP)
        results.push(remoteIP);
      return results;
    } else {
      return [];
    }
  }

  _getWorkingDirectory() {
    return `${f.getHiddenFolder()}/run/docker/${this.profileId}`;
  }

  _getConfigDirectory() {
    return `${f.getHiddenFolder()}/run/docker_vpn_client/${this.constructor.getProtocol()}/${this.profileId}`;
  }

  async _isLinkUp() {
    const serviceUp = await exec(`sudo docker container ls -f "name=${this.getInterfaceName()}" --format "{{.Status}}"`).then(result => result.stdout.trim().startsWith("Up ")).catch((err) => {
      log.error(`Failed to run docker container ls on ${this.profileId}`, err.message);
      return false;
    });
    if (serviceUp)
      return this.__isLinkUpInsideContainer();
    else
      return false;
  }

  // this needs to be implemented by child class
  async __isLinkUpInsideContainer() {
    return true;
  }

  // docker-based vpn client need to implement this function to fetch files and put them to config directory, e.g., docker-compose.yaml, corresponding files/directories to be mapped as volumes,
  // they will be put in the same directory so relative path can still be used in docker-compose
  async __prepareAssets() {

  }

  // this needs to be implemented by child class
  async _getDNSServers() {
    
  }

  // this needs to be implemented by child class
  static getProtocol() {
    
  }
}

module.exports = DockerBaseVPNClient;