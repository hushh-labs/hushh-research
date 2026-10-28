/* Qualification-only server fetch adapter; not a production transport.
 * Hosted admission must authenticate the config against live provider state,
 * bind its hash to the fixture attempt, and prove this hook is actually active.
 */
'use strict';

const TARGETS = Object.freeze({ dev: 'hushh-pda-dev', uat: 'hushh-pda-uat' });
const FIELDS = [
  'backendCandidateUrl', 'backendRevision', 'backendRevisionUid', 'backendServiceUid',
  'backendServiceUrl', 'environment', 'frontendRevision', 'frontendService', 'project',
  'schemaVersion',
].sort();

function refuse() { throw new Error('PLG fixture transport refused'); }

function origin(value) {
  if (typeof value !== 'string' || value.length > 512) refuse();
  let url;
  try { url = new URL(value); } catch { refuse(); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.run.app') ||
      url.username || url.password || url.port || url.pathname !== '/' ||
      url.search || url.hash || value !== url.origin) refuse();
  return url.origin;
}

function checkConfig(config, runtime) {
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      JSON.stringify(Object.keys(config).sort()) !== JSON.stringify(FIELDS) ||
      config.schemaVersion !== 1 || !Object.hasOwn(TARGETS, config.environment) ||
      config.project !== TARGETS[config.environment] ||
      config.frontendService !== 'hushh-webapp-plg-qual' ||
      runtime.project !== config.project || runtime.service !== config.frontendService ||
      runtime.revision !== config.frontendRevision ||
      !/^hushh-webapp-plg-qual-[a-z0-9-]+$/.test(config.frontendRevision) ||
      !/^consent-protocol-plg-qual-[a-z0-9-]+$/.test(config.backendRevision) ||
      !/^[a-z0-9-]{1,128}$/.test(config.backendServiceUid) ||
      !/^[a-z0-9-]{1,128}$/.test(config.backendRevisionUid)) refuse();
  const target = origin(config.backendCandidateUrl);
  const audience = origin(config.backendServiceUrl);
  if (target === audience || origin(runtime.backendUrl) !== target) refuse();
  return { target, audience };
}

function createFixtureFetch(config, runtime, originalFetch, identityToken) {
  const { target, audience } = checkConfig(config, runtime);
  if (typeof originalFetch !== 'function' || typeof identityToken !== 'function') refuse();
  return async function fixtureFetch(input, init) {
    let requested;
    try {
      requested = new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : input);
    } catch { refuse(); }
    // Preserve ordinary W4 and GoogleAuth traffic unchanged. Only the fixed
    // isolated backend origin is subject to this narrow transport adapter.
    if (requested.origin !== target) return originalFetch(input, init);
    let request;
    try { request = new Request(input, init); } catch { refuse(); }
    const url = new URL(request.url);
    const permitted = url.origin === target && !url.username && !url.password &&
      !url.search && !url.hash &&
      ((url.pathname === '/health' && request.method === 'GET') ||
       (url.pathname === '/api/one/plg/preferences' && ['GET', 'PUT'].includes(request.method)));
    if (!permitted || request.headers.has('x-serverless-authorization')) refuse();
    if (url.pathname !== '/health' && !/^Bearer [^\s]+$/.test(request.headers.get('authorization') || '')) refuse();
    let token;
    try { token = await identityToken(audience); } catch { refuse(); }
    if (typeof token !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token)) refuse();
    const headers = new Headers(request.headers);
    headers.set('X-Serverless-Authorization', 'Bearer ' + token);
    let response;
    try { response = await originalFetch(new Request(request, { headers, redirect: 'manual' })); }
    catch { refuse(); }
    if (!response || (response.status >= 300 && response.status < 400)) refuse();
    return response;
  };
}

function createProviderBoundFixtureFetch(config, runtime, originalFetch, identityToken, providerRead) {
  // Readback is a fresh snapshot, not a substitute for the hosted durable fence.
  const { verifyProviderBinding } = require('./plg_fixture_provider.cjs');
  return createFixtureFetch(config, runtime, originalFetch, async audience => {
    await verifyProviderBinding(config, runtime, providerRead);
    return identityToken(audience);
  });
}

module.exports = { checkConfig, createFixtureFetch, createProviderBoundFixtureFetch };
