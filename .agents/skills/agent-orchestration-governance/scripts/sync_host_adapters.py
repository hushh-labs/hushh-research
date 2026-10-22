#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Validate native host entrypoints as links to the unified .agents tree.

Codex discovers .agents/skills natively. Claude still needs .claude discovery;
relative links expose canonical content without copying prompts or scripts.
Writing never removes a regular file/directory or another session's worktree.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
INVENTORY = Path('.agents/skills/agent-orchestration-governance/references/platform-source-inventory.json')


def expected_links(root: Path) -> dict[Path, Path]:
    inventory = json.loads((root / INVENTORY).read_text())
    links = {
        root / '.claude/skills' / source.parent.name: source.parent
        for source in sorted((root / '.agents/skills').glob('*/SKILL.md'))
    }
    for entry in inventory.get('host_adapters', {}).values():
        target, source = root / entry['target'], root / entry['source']
        # An explicitly classified host alias may adapt a governed skill's
        # invocation syntax, as the previous generator already did.
        links[target.parent] = source.parent
    for entry in inventory.get('imports', {}).values():
        if entry.get('discovery_path'):
            links[root / entry['discovery_path']] = root / entry['local_skill_path']
    native = {
        '.codex/config.toml': '.agents/adapters/codex/config.toml',
        '.codex/agents': '.agents/subagents',
        '.claude/settings.json': '.agents/adapters/claude/settings.json',
        '.claude/agents': '.agents/adapters/claude/agents',
    }
    links.update({root / host: root / source for host, source in native.items()})
    return links


def findings(root: Path) -> list[str]:
    try:
        links = expected_links(root)
    except (OSError, ValueError, KeyError) as error:
        return [f'Cannot resolve canonical host adapters: {error}']
    errors = []
    for target, source in links.items():
        valid = target.is_symlink() and str(target.readlink()) == os.path.relpath(source, target.parent)
        try:
            valid = valid and target.resolve(strict=True) == source.resolve(strict=True)
            source.resolve(strict=True).relative_to((root / '.agents').resolve())
        except (OSError, ValueError):
            valid = False
        if not valid:
            errors.append(f'{target.relative_to(root).as_posix()}: must link to {source.relative_to(root).as_posix()}')
    obsolete = root / '.codex/skills'
    if obsolete.exists() and any(obsolete.iterdir()):
        errors.append('.codex/skills: duplicate discovery; use native .agents/skills')
    discovery = root / '.claude/skills'
    if discovery.is_dir():
        errors.extend(f'{p.relative_to(root).as_posix()}: unregistered host discovery entry'
                      for p in discovery.iterdir() if p not in links)
    return errors


def write_links(root: Path) -> None:
    links = expected_links(root)
    # Preflight all entries before changing any link. Local files are never
    # overwritten, even if they resemble a former generated bridge.
    occupied = [str(p.relative_to(root)) for p in links if p.exists() and not p.is_symlink()]
    if occupied:
        raise ValueError('Preserve and migrate existing entries first: ' + ', '.join(occupied))
    for target, source in links.items():
        source.resolve(strict=True).relative_to((root / '.agents').resolve())
        target.parent.resolve().relative_to(root.resolve())
        if target.is_symlink() and str(target.readlink()) != os.path.relpath(source, target.parent):
            raise ValueError(f'Preserve the existing local link first: {target.relative_to(root).as_posix()}')
    for target, source in links.items():
        if not source.exists():
            raise ValueError(f'Missing canonical source: {source.relative_to(root).as_posix()}')
        target.parent.mkdir(parents=True, exist_ok=True)
        relative = os.path.relpath(source, target.parent)
        if target.is_symlink() and str(target.readlink()) == relative:
            continue
        target.symlink_to(relative, target_is_directory=source.is_dir())


def self_test() -> list[str]:
    """Core boundary: no lost settings, duplicate discovery or local-link overwrite."""
    import tempfile
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        inventory = root / INVENTORY
        inventory.parent.mkdir(parents=True)
        inventory.write_text('{}')
        for name in ('.agents/subagents', '.agents/adapters/claude/agents'):
            (root / name).mkdir(parents=True)
        for name in ('.agents/adapters/codex/config.toml', '.agents/adapters/claude/settings.json',
                     '.agents/skills/example/SKILL.md'):
            source = root / name
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_text('Synthetic source')
        write_links(root)
        write_links(root)  # Existing correct links remain idempotent on every host.
        assert not findings(root)
        source = root / '.agents/adapters/codex/config.toml'
        source.unlink()
        assert any('.codex/config.toml' in x for x in findings(root))
        source.write_text('Synthetic source')
        target = root / '.claude/skills/example'
        target.unlink()
        target.symlink_to('../outside')
        assert findings(root)
        try:
            write_links(root)
        except ValueError:
            pass
        else:
            return ['a redirected local link must not be overwritten']
        assert target.readlink().as_posix() == '../outside'
        target.unlink()
        target.mkdir()
        private = target / 'SKILL.md'
        private.write_text('Unreviewed local work')
        try:
            write_links(root)
        except ValueError:
            pass
        else:
            return ['a regular local source must not be overwritten']
        assert private.read_text() == 'Unreviewed local work'
        assert findings(root)
    return []


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    try:
        if args.write:
            write_links(REPO_ROOT)
        errors = findings(REPO_ROOT)
    except (OSError, ValueError, KeyError) as error:
        errors = [str(error)]
    if errors:
        print('\n'.join(errors))
        return 1
    print('Host entrypoints link to unified .agents sources; no copied skill discovery.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
