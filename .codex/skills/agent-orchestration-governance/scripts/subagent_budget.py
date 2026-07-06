#!/usr/bin/env python3
"""Compute the safe repo-scoped subagent fan-out budget.

This is a static guardrail. The Codex host does not expose live open-thread
state to this script, so callers must pass any known open child count.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError as exc:  # pragma: no cover
    raise SystemExit(f"tomllib is required: {exc}") from exc


DEFAULT_ROOT = Path(__file__).resolve().parents[4]
CONFIG_RELATIVE_PATH = Path(".codex/config.toml")
DEFAULT_RECOVERY_SLOT = 1
DEFAULT_MAX_NEW_LANES = 2
EXPECTED_MAX_THREADS = 6
EXPECTED_MAX_DEPTH = 1


@dataclass(frozen=True)
class SubagentBudget:
    max_threads: int
    max_depth: int
    open_agents: int
    recovery_slot: int
    requested_lanes: int
    default_max_new_lanes: int
    close_hung: bool
    effective_available_slots: int
    recommended_new_lanes: int
    safe_to_spawn_requested_lanes: bool
    live_state_source: str
    guidance: list[str]
    errors: list[str]


def _load_agent_config(root: Path) -> tuple[int | None, int | None, list[str]]:
    config_path = root / CONFIG_RELATIVE_PATH
    errors: list[str] = []
    if not config_path.exists():
        return None, None, [f"missing config file: {config_path}"]
    try:
        data = tomllib.loads(config_path.read_text(encoding="utf-8"))
    except Exception as exc:  # pragma: no cover - surfaced by CLI
        return None, None, [f"{config_path}: failed to parse TOML: {exc}"]
    agents = data.get("agents")
    if not isinstance(agents, dict):
        return None, None, [f"{config_path}: missing [agents] table"]
    max_threads = agents.get("max_threads")
    max_depth = agents.get("max_depth")
    if not isinstance(max_threads, int):
        errors.append(f"{config_path}: agents.max_threads must be an integer")
        max_threads = None
    if not isinstance(max_depth, int):
        errors.append(f"{config_path}: agents.max_depth must be an integer")
        max_depth = None
    return max_threads, max_depth, errors


def compute_budget(
    root: Path,
    *,
    open_agents: int,
    requested_lanes: int,
    recovery_slot: int,
    max_new_lanes: int,
    close_hung: bool,
) -> SubagentBudget:
    max_threads, max_depth, errors = _load_agent_config(root)
    if open_agents < 0:
        errors.append("open_agents must be >= 0")
    if requested_lanes < 0:
        errors.append("requested_lanes must be >= 0")
    if recovery_slot < 1:
        errors.append("recovery_slot must be >= 1")
    if max_new_lanes < 1:
        errors.append("max_new_lanes must be >= 1")
    if max_threads is not None and max_threads != EXPECTED_MAX_THREADS:
        errors.append(
            f"agents.max_threads must stay {EXPECTED_MAX_THREADS}; found {max_threads}"
        )
    if max_depth is not None and max_depth != EXPECTED_MAX_DEPTH:
        errors.append(f"agents.max_depth must stay {EXPECTED_MAX_DEPTH}; found {max_depth}")

    configured_threads = max_threads if isinstance(max_threads, int) else 0
    effective_available = configured_threads - recovery_slot - max(open_agents, 0)
    effective_available = max(0, effective_available)
    if close_hung:
        effective_available = 0
    recommended = min(max(requested_lanes, 0), max_new_lanes, effective_available)
    safe = requested_lanes <= recommended and not errors
    guidance = [
        "Keep .codex/config.toml at max_threads=6 and max_depth=1.",
        "Reserve one thread for recovery, synthesis, or governor-style follow-up.",
        "Default to two read-only evidence lanes; use more only after closing stale children.",
        "Close or summarize old child threads sequentially before spawning a new wave.",
        "If close_agent hangs once in a turn, stop close/spawn attempts and continue locally.",
        "If a child returns too much output, ask it for a compact handoff instead of re-waiting.",
    ]
    return SubagentBudget(
        max_threads=configured_threads,
        max_depth=max_depth if isinstance(max_depth, int) else 0,
        open_agents=max(open_agents, 0),
        recovery_slot=recovery_slot,
        requested_lanes=max(requested_lanes, 0),
        default_max_new_lanes=max_new_lanes,
        close_hung=close_hung,
        effective_available_slots=effective_available,
        recommended_new_lanes=recommended,
        safe_to_spawn_requested_lanes=safe,
        live_state_source="operator-supplied; live host state is not exposed to this script",
        guidance=guidance,
        errors=errors,
    )


def _text(payload: SubagentBudget) -> str:
    lines = [
        "Subagent Budget",
        f"Configured cap: max_threads={payload.max_threads}, max_depth={payload.max_depth}",
        f"Open agents supplied: {payload.open_agents}",
        f"Reserved recovery slot: {payload.recovery_slot}",
        f"Default max new lanes: {payload.default_max_new_lanes}",
        f"close_agent hung this turn: {payload.close_hung}",
        f"Requested new lanes: {payload.requested_lanes}",
        f"Effective available slots: {payload.effective_available_slots}",
        f"Recommended new lanes now: {payload.recommended_new_lanes}",
        f"Safe to spawn requested lanes: {payload.safe_to_spawn_requested_lanes}",
        f"Live state source: {payload.live_state_source}",
        "Guidance:",
    ]
    lines.extend(f"- {item}" for item in payload.guidance)
    lines.append("Errors:")
    if payload.errors:
        lines.extend(f"- {item}" for item in payload.errors)
    else:
        lines.append("- none")
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compute safe subagent fan-out budget.")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--open-agents", type=int, default=0)
    parser.add_argument("--requested-lanes", type=int, default=DEFAULT_MAX_NEW_LANES)
    parser.add_argument("--recovery-slot", type=int, default=DEFAULT_RECOVERY_SLOT)
    parser.add_argument("--max-new-lanes", type=int, default=DEFAULT_MAX_NEW_LANES)
    parser.add_argument(
        "--close-hung",
        action="store_true",
        help="Set after a close_agent call hangs/freezes in the current turn.",
    )
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    payload = compute_budget(
        args.root.resolve(),
        open_agents=args.open_agents,
        requested_lanes=args.requested_lanes,
        recovery_slot=args.recovery_slot,
        max_new_lanes=args.max_new_lanes,
        close_hung=args.close_hung,
    )
    if args.json:
        print(json.dumps(asdict(payload), indent=2))
    else:
        print(_text(payload))
    return 0 if payload.safe_to_spawn_requested_lanes else 1


if __name__ == "__main__":
    raise SystemExit(main())
