import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectSources, sourceRevision, syncSearchContracts, validateControlCoverage } from './sync-search-contracts.mjs';
import { runUiChecks } from '../architecture/verify-ui-contracts.mjs';
import { execFileSync } from 'node:child_process';
import { syncReviewReceipt } from '../architecture/ui-review-receipts.mjs';

const fixtureGitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

test('source drift includes imported components and dynamic imports, independent of line endings', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'search-contract-'));
  try {
    await fs.mkdir(path.join(root, 'app'), {recursive: true});
    await fs.mkdir(path.join(root, 'components'));
    await fs.writeFile(path.join(root, 'app/page.tsx'), 'import "@/components/tabs";\nimport("../components/dialog");\n');
    await fs.writeFile(path.join(root, 'components/tabs.tsx'), 'export const tab = "old";\n');
    await fs.writeFile(path.join(root, 'components/dialog.tsx'), 'import settings from \"./settings.json\"; export const dialog = settings;\n');
    await fs.writeFile(path.join(root, 'components/settings.json'), '{\"label\":\"Search\"}');
    const initial = await collectSources(root, ['app/page.tsx']);
    assert.equal(initial.size, 4);
    assert.equal(sourceRevision(initial), sourceRevision(new Map([...initial].map(([file,text]) => [file,text.replaceAll('\n','\r\n')]))));
    await fs.writeFile(path.join(root, 'components/tabs.tsx'), 'export const tab = "new";\n');
    assert.notEqual(sourceRevision(initial), sourceRevision(await collectSources(root, ['app/page.tsx'])));
  } finally { await fs.rm(root, {recursive:true, force:true}); }
});

test('check never repairs stale contracts; new pages require authored route coverage', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'search-contract-'));
  try {
    await fs.mkdir(path.join(root, 'app'), {recursive:true});
    await fs.mkdir(path.join(root, 'lib/navigation'), {recursive:true});
    const contract = path.join(root, 'app/page.voice-action-contract.json');
    await fs.writeFile(contract, JSON.stringify({surface_id:'chat', actions:[]}));
    await fs.writeFile(path.join(root, 'app/page.tsx'), 'export default function Page() {return null;}');
    await fs.writeFile(path.join(root, 'lib/navigation/app-route-layout.contract.json'), JSON.stringify([{route:'/',shellVerification:{file:'app/page.tsx'}}]));
    const original = await fs.readFile(contract, 'utf8');
    await assert.rejects(syncSearchContracts(root, true), /stale/);
    assert.equal(await fs.readFile(contract,'utf8'),original);
    await syncSearchContracts(root);
    await syncSearchContracts(root,true);
    await fs.writeFile(path.join(root, 'app/layout.tsx'), 'export default function Layout() {return null;}');
    await assert.rejects(syncSearchContracts(root,true), /stale/);
    await syncSearchContracts(root);
    await fs.mkdir(path.join(root,'app/new'));
    await fs.writeFile(path.join(root,'app/new/page.tsx'),'export default function New() {return null;}');
    await assert.rejects(syncSearchContracts(root,true), /needs a web route\/search contract/);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});


test('new search controls need semantic action coverage even after regeneration', () => {
  const sources = new Map([['app/page.tsx', '<button data-voice-control-id="new_search_action" />']]);
  assert.throws(() => validateControlCoverage(sources, [{actions:[]}]), /new_search_action/);
  assert.doesNotThrow(() => validateControlCoverage(sources, [{actions:[{control_ids:['new_search_action']}]}]));
});

test('combined UI check runs both owners and fails when either owner fails', async () => {
  for (const failed of ['Back', 'Search']) {
    const ran = [];
    const checks = ['Back', 'Search'].map(name => [name, async () => {
      ran.push(name);
      if (name === failed) throw new Error(`${name} drift`);
    }]);
    assert.equal(await runUiChecks(checks), false);
    assert.deepEqual(ran, ['Back', 'Search']);
  }
  assert.equal(await runUiChecks([['Back', async () => {}], ['Search', async () => {}]]), true);
});

test('independent reviewed UI branches merge without stamp conflicts, but combined drift still fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-review-merge-'));
  const git = (...args) => execFileSync('git', args, {cwd:root, env:fixtureGitEnv, stdio:'pipe'});
  const commit = () => { git('add', '.'); git('commit', '-m', 'review fixture'); };
  try {
    await fs.mkdir(path.join(root, 'app'), {recursive:true});
    await fs.mkdir(path.join(root, 'components'));
    await fs.mkdir(path.join(root, 'lib/navigation'), {recursive:true});
    await fs.writeFile(path.join(root, 'app/page.tsx'), 'import "@/components/a"; import "@/components/b";');
    await fs.writeFile(path.join(root, 'components/a.tsx'), 'export const a = 0;');
    await fs.writeFile(path.join(root, 'components/b.tsx'), 'export const b = 0;');
    const contract = path.join(root, 'app/page.voice-action-contract.json');
    const authored = JSON.stringify({surface_id:'chat', actions:[], search:{query_defaults:{tab:'all'}}});
    await fs.writeFile(contract, authored);
    await fs.writeFile(path.join(root, 'lib/navigation/app-route-layout.contract.json'), JSON.stringify([{route:'/',shellVerification:{file:'app/page.tsx'}}]));
    await syncSearchContracts(root);
    git('init', '-b', 'baseline');
    git('config', 'user.name', 'UI fixture');
    git('config', 'user.email', 'ui-fixture@example.test');
    git('config', 'commit.gpgsign', 'false');
    commit();
    for (const branch of ['a','b']) {
      git('checkout', '-b', branch, 'baseline');
      await fs.writeFile(path.join(root, `components/${branch}.tsx`), `export const ${branch} = 1;`);
      await syncSearchContracts(root);
      assert.equal(await fs.readFile(contract,'utf8'), authored);
      commit();
    }
    git('checkout', 'a');
    git('merge', '--no-edit', 'b');
    assert.equal(git('diff', '--name-only', '--diff-filter=U').toString(), '');
    const receipts = await fs.readdir(path.join(root,'contracts/ui-review/search'));
    assert.equal(receipts.length, 3);
    await assert.rejects(syncSearchContracts(root,true), /stale/);
    assert.deepEqual(await fs.readdir(path.join(root,'contracts/ui-review/search')), receipts);
    await syncSearchContracts(root);
    await syncSearchContracts(root,true);
    assert.equal(await fs.readFile(contract,'utf8'), authored);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('review receipts are immutable, fail closed, and never repair evidence during check', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-review-receipt-'));
  try {
    const revision = 'a'.repeat(64);
    for (const kind of ['back','search']) {
      await assert.rejects(syncReviewReceipt(root,kind,revision,{source_module_count:2},true), /stale/);
      await syncReviewReceipt(root,kind,revision,{source_module_count:2});
      await syncReviewReceipt(root,kind,revision,{source_module_count:2});
      await syncReviewReceipt(root,kind,revision,{source_module_count:2},true);
      const receipt = path.join(root,'contracts/ui-review',kind,`${revision}.json`);
      const original = await fs.readFile(receipt,'utf8');
      await fs.writeFile(receipt,original.replaceAll('\n','\r\n'));
      await syncReviewReceipt(root,kind,revision,{source_module_count:2},true);
      await assert.rejects(syncReviewReceipt(root,kind,revision,{source_module_count:3},true), /Invalid immutable/);
      await assert.rejects(syncReviewReceipt(root,kind,revision,{source_module_count:3}), /Invalid immutable/);
      await assert.rejects(syncReviewReceipt(root,kind,'b'.repeat(64),{source_module_count:2},true), /stale/);
    }
    await assert.rejects(syncReviewReceipt(root,'back','../invalid',{}), /Invalid UI/);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('unrelated PRs inherit a merged baseline without receipts; relevant and untracked drift still blocks', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-review-base-'));
  const root = path.join(repo, 'hushh-webapp');
  const previousBase = process.env.UI_CONTRACT_BASE_SHA;
  const previousCi = process.env.CI;
  const previousEvent = process.env.GITHUB_EVENT_PATH;
  const git = (...args) => execFileSync('git', args, { cwd: repo, env:fixtureGitEnv, encoding: 'utf8', stdio: 'pipe' });
  try {
    await fs.mkdir(path.join(root, 'app'), { recursive: true });
    await fs.mkdir(path.join(root, 'components'), { recursive: true });
    await fs.mkdir(path.join(root, 'lib/navigation'), { recursive: true });
    const inputs = ['app/page.tsx', 'components/config.json'];
    await fs.writeFile(path.join(root, inputs[0]), 'export default function Page(){return null;}');
    await fs.writeFile(path.join(root, inputs[1]), '{"query":"all"}');
    await fs.writeFile(path.join(root, 'lib/navigation/app-route-layout.contract.json'), '[]');
    git('init', '-b', 'main');
    git('config', 'user.name', 'UI fixture');
    git('config', 'user.email', 'ui-fixture@example.test');
    git('config', 'commit.gpgsign', 'false');
    git('add', '.'); git('commit', '-m', 'merged baseline with inherited reviews');
    process.env.UI_CONTRACT_BASE_SHA = git('rev-parse', 'HEAD').trim();
    const revision = 'c'.repeat(64);
    const check = kind => syncReviewReceipt(root, kind, revision, {}, true, inputs);
    await fs.writeFile(path.join(root, 'app/favicon.ico'), 'new branding');
    for (const kind of ['back', 'search']) await check(kind);
    const targetBase = process.env.UI_CONTRACT_BASE_SHA;
    delete process.env.UI_CONTRACT_BASE_SHA;
    process.env.CI = 'true';
    process.env.GITHUB_EVENT_PATH = path.join(repo, 'event.json');
    await fs.writeFile(process.env.GITHUB_EVENT_PATH, JSON.stringify({ pull_request: { base: { sha: targetBase } } }));
    for (const kind of ['back', 'search']) await check(kind);
    await fs.writeFile(process.env.GITHUB_EVENT_PATH, JSON.stringify({ merge_group: { base_sha: targetBase } }));
    for (const kind of ['back', 'search']) await check(kind);
    await fs.writeFile(process.env.GITHUB_EVENT_PATH, '{}');
    for (const kind of ['back', 'search']) await assert.rejects(check(kind), /stale/);
    process.env.UI_CONTRACT_BASE_SHA = targetBase;
    await assert.rejects(fs.access(path.join(root, 'contracts/ui-review')));
    for (const file of [...inputs, 'lib/navigation/app-route-layout.contract.json']) {
      const original = await fs.readFile(path.join(root, file), 'utf8');
      await fs.writeFile(path.join(root, file), original + '\nchanged');
      for (const kind of ['back', 'search']) await assert.rejects(check(kind), /stale/);
      await fs.writeFile(path.join(root, file), original);
    }
    await fs.writeFile(path.join(root, 'components/new.tsx'), 'history.back();');
    for (const kind of ['back', 'search']) await assert.rejects(check(kind), /stale/);
    await fs.unlink(path.join(root, 'components/new.tsx'));
    await fs.unlink(path.join(root, inputs[1]));
    // A deleted imported JSON no longer appears in the current import graph.
    for (const kind of ['back', 'search']) {
      await assert.rejects(syncReviewReceipt(root, kind, revision, {}, true, [inputs[0]]), /stale/);
    }
    git('restore', '.');
    await fs.unlink(path.join(root, inputs[0]));
    for (const kind of ['back', 'search']) await assert.rejects(check(kind), /stale/);
    git('restore', '.');
    process.env.UI_CONTRACT_BASE_SHA = 'f'.repeat(40);
    for (const kind of ['back', 'search']) await assert.rejects(check(kind), /stale/);
    git('checkout', '--orphan', 'unrelated-history');
    git('add', '.'); git('commit', '-m', 'not an ancestor');
    process.env.UI_CONTRACT_BASE_SHA = git('rev-parse', 'HEAD').trim();
    git('checkout', 'main');
    for (const kind of ['back', 'search']) await assert.rejects(check(kind), /stale/);
  } finally {
    if (previousBase === undefined) delete process.env.UI_CONTRACT_BASE_SHA;
    else process.env.UI_CONTRACT_BASE_SHA = previousBase;
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousEvent === undefined) delete process.env.GITHUB_EVENT_PATH;
    else process.env.GITHUB_EVENT_PATH = previousEvent;
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('legacy Search stamp migration preserves nested authored metadata', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'search-migrate-'));
  try {
    await fs.mkdir(path.join(root,'app'),{recursive:true});
    await fs.mkdir(path.join(root,'lib/navigation'),{recursive:true});
    await fs.writeFile(path.join(root,'app/page.tsx'),'export default function Page(){return null;}');
    await fs.writeFile(path.join(root,'lib/navigation/app-route-layout.contract.json'),JSON.stringify([{route:'/',shellVerification:{file:'app/page.tsx'}}]));
    const authored = {surface_id:'chat',actions:[{control_ids:['existing']}],search:{query_defaults:{tab:'all'},legacy_control_exemptions:{old:'reviewed reason'}}};
    const contract = path.join(root,'app/page.voice-action-contract.json');
    await fs.writeFile(contract,JSON.stringify({...authored,search:{...authored.search,source_revision:null,source_module_count:0}},null,2));
    await assert.rejects(syncSearchContracts(root,true),/legacy source stamps/);
    await syncSearchContracts(root);
    assert.deepEqual(JSON.parse(await fs.readFile(contract,'utf8')),authored);
    await syncSearchContracts(root,true);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
