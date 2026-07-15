"use strict";

const net = require("net");

/**
 * Checks if a port is free on 127.0.0.1.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function checkPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => {
        resolve(true);
      });
    });
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Scans sequentially starting at `startPort` until a free port is found.
 * @param {number} startPort
 * @returns {Promise<number>}
 */
async function findFreePort(startPort) {
  let port = startPort;
  while (!(await checkPortFree(port))) {
    port++;
  }
  return port;
}

module.exports = {
  findFreePort,
};
