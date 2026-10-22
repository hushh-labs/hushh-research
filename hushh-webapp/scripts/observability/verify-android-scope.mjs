// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Hushh Research
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const test = fileURLToPath(new URL('../../../.codex/skills/analytics-observability-governance/scripts/test_inspect_android_scope.py', import.meta.url));
const command = process.platform === 'win32' ? 'python' : 'python3';
const result = spawnSync(command, [test], { stdio: 'inherit', timeout: 30_000 });
if (result.error) {
  console.error('Offline Android scope verification requires a working Python 3 interpreter.');
  process.exit(1);
}
process.exit(result.status ?? 1);
