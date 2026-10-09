import test from 'node:test';
import assert from 'node:assert/strict';
import { backSourceRevision, validateHistoryBypasses } from './verify-back-navigation.mjs';

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
