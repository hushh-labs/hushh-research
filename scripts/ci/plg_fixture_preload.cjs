/* Only for an independently admitted private Dev/UAT qualification revision. */
'use strict';

// The Main-owned producer bundles this file/config into an immutable image.
// Deployment still requires its independent shared guard and provider readback;
// runtime reads below bind only the fixed isolated backend before forwarding.

const fs = require('node:fs');
const { createProviderBoundFixtureFetch } = require('./plg_fixture_fetch.cjs');

function refuse() { throw new Error('PLG fixture preload refused'); }
if (process.env.PLG_FIXTURE_FETCH_ENABLE !== '1') refuse();
const descriptor = fs.openSync('/opt/plg-fixture/transport.json', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
let config;
try {
  const stat = fs.fstatSync(descriptor);
  if (!stat.isFile() || stat.size < 1 || stat.size > 8192 || (stat.mode & 0o022) !== 0) refuse();
  config = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
} finally { fs.closeSync(descriptor); }

const runtime = {
  project: process.env.GOOGLE_CLOUD_PROJECT,
  service: process.env.K_SERVICE,
  revision: process.env.K_REVISION,
  backendUrl: process.env.PYTHON_API_URL || process.env.BACKEND_URL,
};
const original = globalThis.fetch.bind(globalThis);
const metadataBase = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/';
async function metadata(path) {
  // Native workload identity only, independent of Next's traced dependencies.
  const response = await original(metadataBase + path, {
    headers: {'Metadata-Flavor': 'Google'}, redirect: 'manual', signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200 || response.headers.get('metadata-flavor') !== 'Google') refuse();
  const raw = await boundedBody(response, 16_384);
  return raw.toString('utf8');
}
async function workload() {
  const email = (await metadata('email')).trim();
  if (email !== `plg-qualification-frontend@${config.project}.iam.gserviceaccount.com`) refuse();
}
async function boundedBody(response, limit) {
  const length = response.headers.get('content-length');
  if (length && (!/^[0-9]+$/.test(length) || Number(length) > limit)) refuse();
  if (!response.body) refuse();
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) refuse();
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks);
}
globalThis.fetch = createProviderBoundFixtureFetch(config, runtime, original, async (audience) => {
  await workload();
  return (await metadata('identity?audience=' + encodeURIComponent(audience) + '&format=full')).trim();
}, async (url) => {
  // The provider module constructs this fixed Google API URL; never accept
  // a config-selected endpoint or forward an owner Authorization header here.
  const expected = `https://us-central1-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/${config.project}/`;
  if (url !== expected + 'services/consent-protocol-plg-qual' &&
      url !== expected + 'revisions/' + config.backendRevision) refuse();
  let response;
  try {
    await workload();
    const token = JSON.parse(await metadata('token')).access_token;
    if (typeof token !== 'string' || !token) refuse();
    response = await original(url, {headers: {authorization: 'Bearer ' + token},
      redirect: 'manual', signal: AbortSignal.timeout(20_000)});
    if (response.status !== 200) refuse();
    return JSON.parse((await boundedBody(response, 1_048_576)).toString('utf8'));
  } catch { refuse(); }
});
