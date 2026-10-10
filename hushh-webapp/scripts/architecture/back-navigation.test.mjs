import test from 'node:test';
import assert from 'node:assert/strict';
import { backSourceRevision, validateHistoryBypasses, verifyBackNavigation } from './verify-back-navigation.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('new router/history Back bypasses fail even when a reviewed owner already exists', () => {
  for (const call of ['router.back()', 'window.history.back()', 'history.go(-1)', 'history.go(delta)', 'const {go} = history; go(delta)', 'const nav = useRouter(); nav.back()', 'const h = window.history; h["back"]()', 'const {back} = history; back()', 'history.back.bind(history)()']) {
    assert.throws(() => validateHistoryBypasses(new Map([['app/new/page.tsx', call]])), /hierarchy bypass/);
  }
  assert.throws(() => validateHistoryBypasses(new Map([['app/global-error.tsx', 'history.back(); history.back();']])), /hierarchy bypass/);
  assert.doesNotThrow(() => validateHistoryBypasses(new Map([['app/new/page.tsx', '// router.back()\nconst text="history.back()"; navigateTopShellBack(params);']])));
});

test('Back fingerprints cover shared UI drift while ignoring their own stamp and line endings', () => {
  const entries = [{route:'/', backVerification:{sourceRevision:'old', cases:[{href:'/',expected:null}]}}];
  const source = new Map([['components/feature.tsx','export const step = "list";\n']]);
  const revision = backSourceRevision(source, entries);
  entries[0].backVerification.sourceRevision = 'new';
  assert.equal(revision, backSourceRevision(new Map([['components/feature.tsx','export const step = "list";\r\n']]), entries));
  assert.notEqual(revision, backSourceRevision(new Map([['components/feature.tsx','export const step = "detail";\n']]), entries));
  entries[0].backVerification.cases[0].expected = {href:'/one'};
  assert.notEqual(revision, backSourceRevision(source, entries));
});

test('fast history prefilter cannot hide escaped Back methods or aliases', () => {
  for (const source of [String.raw`router.b\u0061ck()`, String.raw`history['\u0062ack']()`, String.raw`history['\x62ack']()`, String.raw`history['\x67o'](-1)`, 'const {go: step} = history; step(-1)']) {
    assert.throws(() => validateHistoryBypasses(new Map([['app/new/page.tsx', source]])), /hierarchy bypass/);
  }
});

test('Back receipts retain drift, authored-case and bypass gates without rewriting route authority', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'back-receipt-'));
  try {
    await fs.mkdir(path.join(root,'app'),{recursive:true});
    await fs.mkdir(path.join(root,'lib/navigation'),{recursive:true});
    await fs.mkdir(path.join(root,'components/one-location/redesign'),{recursive:true});
    const hub = path.join(root,'components/one-location/redesign/location-redesign-hub.tsx');
    const source = 'const FLOW_TO_ACTION = {review: "review"};';
    await fs.writeFile(hub,source);
    await fs.writeFile(path.join(root,'app/page.tsx'),'export default function Page(){return null;}');
    const entries = [{route:'/',backVerification:{sourceRevision:'old',cases:[{href:'/',expected:null}]}},{route:'/one/location',backVerification:{cases:['now','people','links'].map(view=>({href:`/one/location?action=review&view=${view}`,expected:null}))}}];
    const contract = path.join(root,'lib/navigation/app-route-layout.contract.json');
    await fs.writeFile(contract,JSON.stringify(entries));
    await assert.rejects(verifyBackNavigation(root),/stale/);
    await verifyBackNavigation(root,true);
    const authored = await fs.readFile(contract,'utf8');
    assert.equal(Object.hasOwn(JSON.parse(authored)[0].backVerification,'sourceRevision'),false);
    await verifyBackNavigation(root);
    await fs.writeFile(hub,source+'\n// changed UI');
    await assert.rejects(verifyBackNavigation(root),/stale/);
    assert.equal(await fs.readFile(contract,'utf8'),authored);
    await verifyBackNavigation(root,true);
    assert.equal(await fs.readFile(contract,'utf8'),authored);
    const reviewed = JSON.parse(authored);
    reviewed[0].backVerification.cases[0].expected = {href:'/one'};
    await fs.writeFile(contract,JSON.stringify(reviewed));
    await assert.rejects(verifyBackNavigation(root),/stale/);
    await verifyBackNavigation(root,true);
    await fs.writeFile(hub,source+'\nhistory.back();');
    await assert.rejects(verifyBackNavigation(root,true),/hierarchy bypass/);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
