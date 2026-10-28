/* Read-only provider identity binding for the isolated Dev/UAT transport.
 * Config provenance and shared mutation admission remain the hosted caller's
 * responsibility. This module neither installs the preload nor grants release.
 */
'use strict';

const { checkConfig } = require('./plg_fixture_fetch.cjs');
const SERVICE = 'consent-protocol-plg-qual';
const REGION = 'us-central1';

function refuse() { throw new Error('PLG fixture provider binding refused'); }

function ready(value) {
  const conditions = value?.status?.conditions;
  return Array.isArray(conditions) &&
    conditions.filter(row => row?.type === 'Ready').length === 1 &&
    conditions.some(row => row?.type === 'Ready' && row.status === 'True');
}

function checkProviderState(config, runtime, service, revision) {
  const { target, audience } = checkConfig(config, runtime);
  const metadata = service?.metadata;
  const revisionMetadata = revision?.metadata;
  const traffic = service?.status?.traffic;
  if (!metadata || !revisionMetadata || metadata.name !== SERVICE ||
      metadata.uid !== config.backendServiceUid ||
      typeof metadata.resourceVersion !== 'string' || !metadata.resourceVersion ||
      !/^[1-9][0-9]*$/.test(String(metadata.generation)) ||
      String(metadata.generation) !== String(service.status?.observedGeneration) ||
      !ready(service) || !ready(revision) ||
      revisionMetadata.name !== config.backendRevision ||
      revisionMetadata.uid !== config.backendRevisionUid ||
      revisionMetadata.labels?.['serving.knative.dev/service'] !== SERVICE ||
      !Array.isArray(traffic) || traffic.length < 1 || traffic.length > 100 ||
      service.status.url !== audience) refuse();
  const routes = traffic.filter(row => row?.url === target);
  if (routes.length !== 1 || routes[0].revisionName !== config.backendRevision ||
      typeof routes[0].tag !== 'string' || !/^q[0-9a-f]{12}$/.test(routes[0].tag) ||
      config.backendRevision !== SERVICE + '-' + routes[0].tag ||
      !new URL(target).hostname.startsWith(routes[0].tag + '---' + SERVICE + '-') ||
      traffic.some(row => row?.tag === routes[0].tag && row !== routes[0])) refuse();
  return { serviceUid: metadata.uid, resourceVersion: metadata.resourceVersion,
    revisionUid: revisionMetadata.uid };
}

async function verifyProviderBinding(config, runtime, read) {
  checkConfig(config, runtime);
  if (typeof read !== 'function') refuse();
  const base = `https://${REGION}-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/${config.project}/`;
  let service; let revision; let after;
  try {
    service = await read(base + 'services/' + SERVICE);
    revision = await read(base + 'revisions/' + config.backendRevision);
    const observed = checkProviderState(config, runtime, service, revision);
    after = await read(base + 'services/' + SERVICE);
    const final = checkProviderState(config, runtime, after, revision);
    if (JSON.stringify(observed) !== JSON.stringify(final)) refuse();
    return observed;
  } catch { refuse(); }
}

module.exports = { checkProviderState, verifyProviderBinding };
