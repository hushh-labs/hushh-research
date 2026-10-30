"use strict";

const net = require("net");

/**
 * Checks if a port is free.
 *
 * Binds to 0.0.0.0 rather than 127.0.0.1: the frontend (next dev / the
 * standalone server) actually binds all interfaces (0.0.0.0 + ::), so a
 * 127.0.0.1-only probe can report a port "free" while another already-running
 * instance holds it on 0.0.0.0, which then crashes with EADDRINUSE once the
 * real server tries to bind (confirmed live: two instances both got told
 * port 3001 was free). 0.0.0.0 is a superset check that's still correct for
 * the backend, which binds 127.0.0.1-only.
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
    server.listen(port, "0.0.0.0");
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
