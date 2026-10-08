import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectSources, sourceRevision, syncSearchContracts, validateControlCoverage } from './sync-search-contracts.mjs';

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
