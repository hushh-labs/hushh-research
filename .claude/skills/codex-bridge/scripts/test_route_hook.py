#!/usr/bin/env python3
# Generated compatibility shim; edit .agents/adapters/claude/codex-bridge/scripts/test_route_hook.py.
from pathlib import Path
import runpy
import sys
root = next(p for p in Path(__file__).resolve().parents if (p / "AGENTS.md").is_file() and (p / ".agents").is_dir())
source = root / '.agents/adapters/claude/codex-bridge/scripts/test_route_hook.py'
sys.path.insert(0, str(source.parent))
runpy.run_path(str(source), run_name="__main__")
