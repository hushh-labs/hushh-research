#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Reproduce host discovery and command adapters from the canonical .agents sources."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
INVENTORY = Path('.agents/skills/agent-orchestration-governance/references/platform-source-inventory.json')
MARKER = '<!-- Generated host adapter; edit the canonical .agents source. -->'


def frontmatter(source: str) -> str:
    match = re.match(r'\A---\n.*?\n---(?:\n|$)', source, re.S)
    if not match:
        raise ValueError('Canonical discovery source has no YAML frontmatter')
    return match[0].rstrip()


def command_shim(root: Path, destination: Path, canonical: str) -> bytes:
    if destination.suffix == '.py':
        shim = f'''#!/usr/bin/env python3
# Generated compatibility shim; edit {canonical}.
from pathlib import Path
import runpy
import sys
root = next(p for p in Path(__file__).resolve().parents if (p / "AGENTS.md").is_file() and (p / ".agents").is_dir())
source = root / {canonical!r}
sys.path.insert(0, str(source.parent))
runpy.run_path(str(source), run_name="__main__")
'''
    else:
        ascent = '/'.join(['..'] * (len(destination.relative_to(root).parts) - 1))
        shim = f'''#!/usr/bin/env bash
# Generated compatibility shim; edit {canonical}.
set -euo pipefail
root="$(cd "$(dirname "${{BASH_SOURCE[0]}}")/{ascent}" && pwd)"
exec bash "$root/{canonical}" "$@"
'''
    return shim.encode()


def expected_outputs(root: Path) -> dict[Path, bytes]:
    inventory = json.loads((root / INVENTORY).read_text())
    outputs: dict[Path, bytes] = {}
    skills = root / '.agents/skills'
    for source in sorted(skills.glob('*/SKILL.md')):
        relative = source.relative_to(root).as_posix()
        targets = []
        if source.with_name('skill.json').is_file():
            targets.append(root / '.codex/skills' / source.parent.name / 'SKILL.md')
        if relative in inventory.get('practice_sources', {}):
            targets.append(root / '.claude/skills' / source.parent.name / 'SKILL.md')
            installed = root / '.codex/skills' / source.parent.name / 'SKILL.md'
            if installed.is_file():
                targets.append(installed)
        for target in targets:
            outputs[target] = (frontmatter(source.read_text()) + f'\n\nRead `{relative}` and follow it.\n').encode()
    for entry in inventory.get('host_adapters', {}).values():
        source = root / entry['source']
        target = root / entry['target']
        text = source.read_text()
        # Keep host-native inline shell expansion and frontmatter reproducible.
        fm = frontmatter(text)
        outputs[target] = (fm + '\n\n' + MARKER + '\n' + text[len(fm):].lstrip()).encode()
        for command in sorted(source.parent.rglob('*')):
            if not command.is_file() or '__pycache__' in command.parts:
                continue
            suffix = command.relative_to(source.parent)
            if suffix.suffix not in {'.py', '.sh'}:
                continue
            destination = target.parent / suffix
            canonical = command.relative_to(root).as_posix()
            outputs[destination] = command_shim(root, destination, canonical)
    for entry in inventory.get('compatibility_commands', []):
        source = root / entry['source']
        if not source.is_file():
            raise ValueError(f'Missing canonical command: {entry["source"]}')
        destination = root / entry['target']
        outputs[destination] = command_shim(root, destination, entry['source'])
    return outputs


def findings(root: Path) -> list[str]:
    try:
        outputs = expected_outputs(root)
    except (OSError, ValueError, KeyError) as error:
        return [f'Cannot resolve canonical host adapters: {error}']
    errors = [f'{path.relative_to(root)}: missing or stale generated host adapter'
              for path, expected in outputs.items()
              if not path.is_file() or path.read_bytes() != expected]
    for host in ('.claude', '.codex'):
        for path in sorted((root / host / 'skills').rglob('*')):
            if path.suffix not in {'.py', '.sh', '.md'} or not path.is_file() or path in outputs:
                continue
            if '__pycache__' in path.parts:
                continue
            with path.open(encoding='utf-8') as source:
                prefix = source.read(2048)
            if MARKER in prefix or '# Generated compatibility shim; edit .agents/' in prefix:
                errors.append(f'{path.relative_to(root)}: orphan generated host adapter')
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if args.write:
        for path, content in expected_outputs(REPO_ROOT).items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
            if path.suffix in {'.py', '.sh'}:
                path.chmod(0o755)
    errors = findings(REPO_ROOT)
    if errors:
        print('\n'.join(errors))
        return 1
    print('Host discovery and command adapters match canonical .agents sources.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
