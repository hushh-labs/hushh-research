// Synthetic exact-W4 route execution; never a hosted/provider acceptance.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { createFixtureFetch } = require('./plg_fixture_fetch.cjs');
const sha = '2a860818549f2d6c16d1f98bd8fb9cebe01a1f84';
const checkout = process.env.PLG_TEST_SOURCE_CHECKOUT || process.cwd();
const source = execFileSync('git', ['-C', checkout, 'show', `${sha}:hushh-webapp/app/api/one/[...path]/route.ts`], {encoding: 'utf8'});
const javascript = stripTypeScriptTypes(source, {mode: 'transform'});
const service = 'https://private-service.example.run.app';
const target = 'https://tag---private-service.example.run.app';
const config = {
  schemaVersion: 1, environment: 'dev', project: 'hushh-pda-dev',
  frontendService: 'hushh-webapp-plg-qual', frontendRevision: 'hushh-webapp-plg-qual-rev1',
  backendServiceUid: '1111-2222', backendRevisionUid: '3333-4444',
  backendRevision: 'consent-protocol-plg-qual-rev1',
  backendServiceUrl: service, backendCandidateUrl: target,
};
const runtime = {project: config.project, service: config.frontendService,
  revision: config.frontendRevision, backendUrl: target};

async function loadRoute(observed) {
  const wrapped = createFixtureFetch(config, runtime, async request => {
    observed.push({url: request.url, authorization: request.headers.get('authorization'),
      serviceAuthorization: request.headers.get('x-serverless-authorization'),
      redirect: request.redirect, method: request.method,
      body: request.method === 'PUT' ? await request.text() : ''});
    return new Response('{"ok":true}', {status: 200, headers: {'content-type': 'application/json'}});
  }, async audience => { assert.equal(audience, service); return 'fixture-service-token'; });
  const context = vm.createContext({fetch: wrapped, Request, Response, Headers, AbortSignal,
    AbortController, DOMException, TextDecoder, Uint8Array, setTimeout, clearTimeout});
  const route = new vm.SourceTextModule(javascript, {context});
  const modules = {
    'next/server': {NextRequest: class NextRequest {}},
    '@/app/api/_utils/backend': {getPythonApiUrl: () => target},
    '@/lib/vault/one-chat-key': {ONE_CHAT_KEY_HEADER: 'x-one-chat-key'},
    '@/app/api/_utils/request-id': {
      createUpstreamHeaders: () => new Headers(), resolveRequestId: () => 'synthetic',
      withRequestIdJson: (_id, value, options) => new Response(JSON.stringify(value), options),
    },
    '@/lib/utils/request-timeouts': {resolveSlowRequestTimeoutMs: value => value},
  };
  await route.link(async specifier => {
    assert.ok(Object.hasOwn(modules, specifier), `unreviewed import ${specifier}`);
    const values = modules[specifier];
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, {context});
  });
  await route.evaluate();
  return route.namespace;
}

for (const method of ['GET', 'PUT']) test(`exact W4 ${method} preference route reaches installed synthetic adapter`, async () => {
  const observed = [];
  const route = await loadRoute(observed);
  const body = JSON.stringify({enabled: false, frequency: 'weekly', expectedRevision: 2,
    disclosureVersion: 'one-email-updates-v1', surface: 'account'});
  const request = {
    headers: new Headers({authorization: 'Bearer synthetic-owner-token', 'content-type': 'application/json'}),
    nextUrl: {search: ''}, method, signal: new AbortController().signal,
    text: async () => body,
  };
  const response = await route[method](request, {params: Promise.resolve({path: ['plg', 'preferences']})});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(observed, [{url: `${target}/api/one/plg/preferences`, authorization: 'Bearer synthetic-owner-token',
    serviceAuthorization: 'Bearer fixture-service-token', redirect: 'manual', method, body: method === 'PUT' ? body : ''}]);
});

test('exact W4 route cannot send another backend route through synthetic adapter', async () => {
  const observed = [];
  const route = await loadRoute(observed);
  const request = {headers: new Headers({authorization: 'Bearer synthetic-owner-token'}),
    nextUrl: {search: ''}, method: 'GET', signal: new AbortController().signal};
  const response = await route.GET(request, {params: Promise.resolve({path: ['unreviewed']})});
  assert.equal(response.status, 502);
  assert.equal(observed.length, 0);
});
