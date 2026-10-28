'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { checkConfig, createFixtureFetch, createProviderBoundFixtureFetch } = require('./plg_fixture_fetch.cjs');

function fixture() {
  const config = {
    schemaVersion: 1, environment: 'dev', project: 'hushh-pda-dev',
    frontendService: 'hushh-webapp-plg-qual', frontendRevision: 'hushh-webapp-plg-qual-rev1',
    backendServiceUid: '1111-2222', backendRevisionUid: '3333-4444',
    backendRevision: 'consent-protocol-plg-qual-rev1',
    backendServiceUrl: 'https://private-service.example.run.app',
    backendCandidateUrl: 'https://tag---private-service.example.run.app',
  };
  const runtime = { project: config.project, service: config.frontendService,
    revision: config.frontendRevision, backendUrl: config.backendCandidateUrl };
  return { config, runtime };
}

test('preserves owner authorization while sending separate service identity', async () => {
  const { config, runtime } = fixture();
  let request; let audience;
  const wrapped = createFixtureFetch(config, runtime, async value => {
    request = value; return new Response('{}', {status: 200});
  }, async value => { audience = value; return 'fixture-id-token'; });
  await wrapped(`${config.backendCandidateUrl}/api/one/plg/preferences`, {
    method: 'PUT', headers: {authorization: 'Bearer firebase-owner-token', 'content-type': 'application/json'},
    body: '{"marketing":false}',
  });
  assert.equal(audience, config.backendServiceUrl);
  assert.equal(request.headers.get('authorization'), 'Bearer firebase-owner-token');
  assert.equal(request.headers.get('x-serverless-authorization'), 'Bearer fixture-id-token');
  assert.equal(request.redirect, 'manual');
  assert.equal(await request.text(), '{"marketing":false}');
});

test('rejects unreviewed backend path, method, query, caller-supplied service header and missing owner', async () => {
  const { config, runtime } = fixture();
  let calls = 0;
  const wrapped = createFixtureFetch(config, runtime, async () => { calls++; return new Response(); }, async () => 'fixture-token');
  const path = `${config.backendCandidateUrl}/api/one/plg/preferences`;
  for (const [url, init] of [
    [path + '?token=secret', {headers: {authorization: 'Bearer user'}}],
    [path, {method: 'POST', headers: {authorization: 'Bearer user'}}],
    [path, {headers: {'x-serverless-authorization': 'Bearer attacker', authorization: 'Bearer user'}}],
    [path, {}],
    [`${config.backendCandidateUrl}/api/one/unreviewed`, {headers: {authorization: 'Bearer user'}}],
  ]) await assert.rejects(wrapped(url, init), /PLG fixture transport refused/);
  assert.equal(calls, 0);
});

test('passes unrelated fetches through unchanged without minting service identity', async () => {
  const { config, runtime } = fixture();
  let captured; let mints = 0;
  const wrapped = createFixtureFetch(config, runtime, async (input, init) => {
    captured = {input, init}; return new Response(null, {status: 204});
  }, async () => { mints++; return 'fixture-token'; });
  const original = 'https://metadata.example.test/other';
  const init = {method: 'GET', headers: {'x-test': 'kept'}};
  const response = await wrapped(original, init);
  assert.equal(response.status, 204);
  assert.equal(captured.input, original);
  assert.equal(captured.init, init);
  assert.equal(mints, 0);
});

test('rejects redirects and sanitizes credential and network errors', async () => {
  const { config, runtime } = fixture();
  const path = `${config.backendCandidateUrl}/api/one/plg/preferences`;
  const init = {headers: {authorization: 'Bearer user'}};
  const redirect = createFixtureFetch(config, runtime, async () => new Response(null, {status: 302, headers: {location: 'https://evil.example/'}}), async () => 'fixture-token');
  await assert.rejects(redirect(path, init), /PLG fixture transport refused/);
  const badToken = createFixtureFetch(config, runtime, async () => new Response(), async () => { throw Error('secret-token'); });
  await assert.rejects(badToken(path, init), error => error.message === 'PLG fixture transport refused');
  const badNetwork = createFixtureFetch(config, runtime, async () => { throw Error('secret-header'); }, async () => 'fixture-token');
  await assert.rejects(badNetwork(path, init), error => error.message === 'PLG fixture transport refused');
});

test('rejects production, wrong project/service/revision, noncanonical origins and missing pinned identity', () => {
  const { config, runtime } = fixture();
  for (const changed of [
    {...config, environment: 'production'}, {...config, project: 'hushh-ai-prod'},
    {...config, backendCandidateUrl: config.backendServiceUrl},
    {...config, backendCandidateUrl: 'https://attacker.invalid'},
    {...config, backendServiceUid: ''}, {...config, backendRevision: 'unreviewed'},
    {...config, extra: 'unreviewed'},
  ]) assert.throws(() => checkConfig(changed, runtime), /PLG fixture transport refused/);
  assert.throws(() => checkConfig(config, {...runtime, service: 'shared-frontend'}), /PLG fixture transport refused/);
  assert.throws(() => checkConfig(config, {...runtime, revision: 'wrong-revision'}), /PLG fixture transport refused/);
});

test('allows only read-only health without an owner token', async () => {
  const { config, runtime } = fixture();
  let observed;
  const wrapped = createFixtureFetch(config, runtime, async request => { observed = request; return new Response(); }, async () => 'fixture-token');
  await wrapped(`${config.backendCandidateUrl}/health`);
  assert.equal(observed.method, 'GET');
  assert.equal(observed.headers.get('authorization'), null);
  assert.equal(observed.headers.get('x-serverless-authorization'), 'Bearer fixture-token');
});

test('actual preload refuses startup without explicit fixture enablement', () => {
  const preload = path.join(__dirname, 'plg_fixture_preload.cjs');
  const result = spawnSync(process.execPath, ['--require', preload, '-e', 'process.exit(0)'], {
    encoding: 'utf8', env: {...process.env, PLG_FIXTURE_FETCH_ENABLE: '0'},
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PLG fixture preload refused/);
});

test('actual preload uses native workload metadata, checks fixed provider and preserves owner token', async () => {
  const { config } = fixture();
  const tag = 'q0123456789ab';
  config.backendRevision = 'consent-protocol-plg-qual-' + tag;
  config.backendServiceUrl = 'https://consent-protocol-plg-qual-fixed-uc.a.run.app';
  config.backendCandidateUrl = 'https://' + tag + '---consent-protocol-plg-qual-fixed-uc.a.run.app';
  const service = {metadata: {name: 'consent-protocol-plg-qual', uid: config.backendServiceUid,
    resourceVersion: 'rv1', generation: 1}, status: {observedGeneration: 1,
    url: config.backendServiceUrl, conditions: [{type: 'Ready', status: 'True'}],
    traffic: [{revisionName: config.backendRevision, tag, url: config.backendCandidateUrl, percent: 100}]}};
  const revision = {metadata: {name: config.backendRevision, uid: config.backendRevisionUid,
    labels: {'serving.knative.dev/service': 'consent-protocol-plg-qual'}},
    status: {conditions: [{type: 'Ready', status: 'True'}]}};
  let forwards = 0;
  const original = async (input, init) => {
    if (input instanceof Request) {
      forwards++;
      assert.equal(input.url, config.backendCandidateUrl + '/api/one/plg/preferences');
      assert.equal(input.headers.get('authorization'), 'Bearer owner');
      assert.equal(input.headers.get('x-serverless-authorization'), 'Bearer native-id-token');
      return new Response('{}');
    }
    if (input.startsWith('http://metadata.google.internal/')) {
      assert.equal(init.headers['Metadata-Flavor'], 'Google');
      let value;
      if (input.endsWith('/email')) value = 'plg-qualification-frontend@hushh-pda-dev.iam.gserviceaccount.com';
      else if (input.endsWith('/token')) value = JSON.stringify({access_token: 'native-access-token'});
      else {
        assert.equal(new URL(input).searchParams.get('audience'), config.backendServiceUrl);
        value = 'native-id-token';
      }
      return new Response(value, {headers: {'Metadata-Flavor': 'Google'}});
    }
    assert.match(input, /^https:\/\/us-central1-run\.googleapis\.com\//);
    assert.equal(init.headers.authorization, 'Bearer native-access-token');
    return new Response(JSON.stringify(input.includes('/services/') ? service : revision));
  };
  const sandbox = {process: {env: {PLG_FIXTURE_FETCH_ENABLE: '1',
    GOOGLE_CLOUD_PROJECT: config.project, K_SERVICE: config.frontendService,
    K_REVISION: config.frontendRevision, BACKEND_URL: config.backendCandidateUrl}},
    fetch: original, Buffer, AbortSignal,
    require: name => {
      if (name !== 'node:fs') return require(name);
      return {constants: fs.constants, openSync: () => 1, closeSync: () => {},
        fstatSync: () => ({isFile: () => true, size: 2048, mode: 0o444}),
        readFileSync: () => JSON.stringify(config)};
    }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'plg_fixture_preload.cjs'), 'utf8'), sandbox);
  await sandbox.fetch(config.backendCandidateUrl + '/api/one/plg/preferences', {headers: {authorization: 'Bearer owner'}});
  assert.equal(forwards, 1);
});

test('binds owner forwarding to fresh fixed-provider UID and tag reads, refusing forged URL or replaced service', async () => {
  const { config, runtime } = fixture();
  const tag = 'q0123456789ab';
  config.backendRevision = 'consent-protocol-plg-qual-' + tag;
  config.backendServiceUrl = 'https://consent-protocol-plg-qual-fixed-uc.a.run.app';
  config.backendCandidateUrl = 'https://' + tag + '---consent-protocol-plg-qual-fixed-uc.a.run.app';
  runtime.backendUrl = config.backendCandidateUrl;
  const service = {
    metadata: {name: 'consent-protocol-plg-qual', uid: config.backendServiceUid, resourceVersion: 'rv1', generation: 3},
    status: {observedGeneration: 3, url: config.backendServiceUrl,
      conditions: [{type: 'Ready', status: 'True'}],
      traffic: [{revisionName: config.backendRevision, tag, url: config.backendCandidateUrl, percent: 100}]},
  };
  const revision = {
    metadata: {name: config.backendRevision, uid: config.backendRevisionUid,
      labels: {'serving.knative.dev/service': 'consent-protocol-plg-qual'}},
    status: {conditions: [{type: 'Ready', status: 'True'}]},
  };
  let mints = 0; let forwards = 0; const reads = [];
  const make = (selectedConfig, selectedRuntime, serviceRead = () => service) =>
    createProviderBoundFixtureFetch(selectedConfig, selectedRuntime, async request => {
      forwards++;
      assert.equal(request.headers.get('authorization'), 'Bearer owner');
      return new Response('{}');
    }, async () => { mints++; return 'service-token'; }, async url => {
      reads.push(url);
      assert.match(url, /^https:\/\/us-central1-run\.googleapis\.com\/apis\/serving\.knative\.dev\/v1\/namespaces\/hushh-pda-dev\//);
      return structuredClone(url.includes('/services/') ? serviceRead() : revision);
    });
  const init = {headers: {authorization: 'Bearer owner'}};
  await make(config, runtime)(config.backendCandidateUrl + '/api/one/plg/preferences', init);
  assert.equal(reads.length, 3);
  assert.equal(mints, 1); assert.equal(forwards, 1);
  for (const changed of [
    {...service, metadata: {...service.metadata, uid: 'replaced'}},
    {...service, status: {...service.status, observedGeneration: 2}},
    {...service, status: {...service.status, conditions: [{type: 'Ready', status: 'False'}]}},
    {...service, status: {...service.status, traffic: []}},
  ]) await assert.rejects(make(config, runtime, () => changed)(config.backendCandidateUrl + '/api/one/plg/preferences', init));
  const forged = {...config, backendCandidateUrl: 'https://attacker.run.app'};
  await assert.rejects(make(forged, {...runtime, backendUrl: forged.backendCandidateUrl})(forged.backendCandidateUrl + '/api/one/plg/preferences', init));
  let calls = 0;
  await assert.rejects(make(config, runtime, () => ++calls === 1 ? service :
    {...service, metadata: {...service.metadata, resourceVersion: 'rv2'}})(config.backendCandidateUrl + '/api/one/plg/preferences', init));
  assert.equal(mints, 1); assert.equal(forwards, 1);
});
