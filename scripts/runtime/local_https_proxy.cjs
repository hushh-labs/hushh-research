// Local TLS termination for Next's standalone server (which serves HTTP only).
const { readFileSync } = require('node:fs');
const { createServer } = require('node:https');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const { X509Certificate, createPrivateKey } = require('node:crypto');

const [webDir, certPath, keyPath] = process.argv.slice(2);
const cert = readFileSync(certPath);
const key = readFileSync(keyPath);
const certificate = new X509Certificate(cert);
if (!certificate.checkHost('localhost') ||
    !certificate.checkPrivateKey(createPrivateKey(key)) ||
    Date.parse(certificate.validFrom) > Date.now() ||
    Date.parse(certificate.validTo) <= Date.now()) {
  throw new Error('Invalid or expired localhost TLS certificate. Renew it before starting.');
}

// Reuse the proxy shipped with the installed Next runtime, including WS support.
const webRequire = createRequire(resolve(webDir, 'package.json'));
const { ProxyServer } = webRequire('next/dist/compiled/httpxy');
const proxy = new ProxyServer({
  target: 'http://127.0.0.1:3001',
  ws: true,
  xfwd: true,
});
proxy.on('proxyReq', (upstream, _request, response) => {
  response.on('close', () => upstream.destroy());
});
proxy.on('proxyRes', (upstream, _request, response) => {
  response.on('close', () => upstream.destroy());
});
proxy.on('error', (_error, _request, response) => {
  if (typeof response.writeHead === 'function' && !response.headersSent) {
    response.writeHead(502);
    response.end('Local frontend unavailable');
  } else {
    response.destroy();
  }
});
const server = createServer({ cert, key }, (request, response) => {
  proxy.web(request, response).catch(() => response.destroy());
});
server.on('upgrade', (request, socket, head) => {
  proxy.ws(request, socket, {}, head).catch(() => socket.destroy());
});
server.on('error', (error) => {
  console.error(`Local HTTPS failed: ${error.message}`);
  process.exit(1);
});
const sockets = new Set();
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
function shutdown() {
  server.close();
  for (const socket of sockets) socket.destroy();
  proxy.close();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
server.listen(3000, '127.0.0.1', () => console.log('Local HTTPS: https://localhost:3000'));
