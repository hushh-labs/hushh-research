#!/usr/bin/env python3
"""Find the environment variables that are not actually configuration.

A flag earns its keep by holding DIFFERENT values in different environments.
One that reads the same everywhere is a constant with extra steps, and it costs
more than it looks: a branch nobody exercises, a second code path that rots, a
`false` somewhere that quietly disables a feature everyone believes shipped, and
one more thing to check when something does not appear.

Where a lane's value actually lives -- and the mistake this file made
--------------------------------------------------------------------
The first version of this script read four files: `hushh-webapp/.env.local.local`,
`.env.dev.local`, `.env.uat.local`, `.env.prod.local`. Those are **gitignored,
per-developer overrides**. They are not what any lane deploys, and on a machine
where all four happen to exist they look exactly like lane configuration.

Measured 2026-09-11, that error produced a confident and wrong answer. It
reported `NEXT_PUBLIC_ONE_WALLET_CARD_ENABLED` as `false` in every lane and
concluded the wallet card was dark everywhere. UAT and production both deploy
it `true` -- `.github/workflows/deploy-uat.yml:883` passes
`_ONE_WALLET_CARD_ENABLED=true` to the frontend build and `:672` to the
backend. What was actually false was the founder's own laptop. A tool that
reads the wrong file does not fail; it answers, and the answer is the shape of
a real finding.

It reported 37 backend flags as "set in no lane" for the same reason: backend
values arrive as Cloud Build substitutions, which none of those four files
contain.

So a lane's value is read from, in order:
  1. the workflow's `--substitutions` string for that lane's build step
  2. the cloudbuild file's own `substitutions:` defaults
  3. the code's own default at the read site (not parsed here; reported as UNSET)

The developer overrides are still read, and still reported -- as what they are.

This reports four classes, and deliberately deletes nothing. Which constant is
correct -- on or off -- is a product decision, and a script that guessed would
be worse than the flags.

  UNIFORM      same value in every deployed lane. Not configuration.
  DEAD         referenced in code, set in no lane and no default. Never runs.
  ORPHANED     set in a lane, referenced by no code. Pure noise.
  LOCAL_DRIFT  a developer override that disagrees with every deployed lane.
               Not a defect in the product; the reason a bug reproduces on one
               machine and nowhere else.

Usage:
    python3 scripts/ops/audit_env_toggles.py
    python3 scripts/ops/audit_env_toggles.py --json-out report.json
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
WEBAPP = REPO / "hushh-webapp"

# Gitignored, per-developer. Read to detect local drift, NEVER as a lane value.
DEVELOPER_OVERRIDE_FILES = {
    "local": WEBAPP / ".env.local.local",
    "dev": WEBAPP / ".env.dev.local",
    "uat": WEBAPP / ".env.uat.local",
    "prod": WEBAPP / ".env.prod.local",
}

# What a lane actually deploys.
LANE_WORKFLOWS = {
    "dev": REPO / ".github/workflows/deploy-dev.yml",
    "uat": REPO / ".github/workflows/deploy-uat.yml",
    "prod": REPO / ".github/workflows/deploy-production.yml",
}
CLOUDBUILD_DEFAULTS = [
    REPO / "deploy/backend.cloudbuild.yaml",
    REPO / "deploy/frontend.cloudbuild.yaml",
]

# A substitution is named `_FOO`; the env var it becomes is `FOO`, and for the
# frontend build it may become `NEXT_PUBLIC_FOO` via a --build-arg.
_SUBSTITUTION = re.compile(r"_([A-Z][A-Z0-9_]*)=([^#,\"\s]*)")

TOGGLE_SHAPE = re.compile(r"(_ENABLED|_DISABLED|_FLAG|_ON|_OFF)$|^(ENABLE|DISABLE|USE)_")

SEARCH_ROOTS = [
    WEBAPP / "lib",
    WEBAPP / "components",
    WEBAPP / "app",
    REPO / "consent-protocol" / "hushh_mcp",
    REPO / "consent-protocol" / "api",
]


def referenced_env_names() -> set[str]:
    """Every env var the code actually reads.

    Deliberately over-matches. Most reads here do not go through `os.getenv`
    directly -- they go through a wrapper (`_env_bool("X", True)`,
    `_is_truthy_env("X")`, `runtime_settings`' name table) or split the call
    across lines, and a pattern anchored to `os.getenv(` misses all of them.

    Measured 2026-09-11: the anchored version reported
    `ONE_EMAIL_WEBHOOK_AUTH_ENABLED`, `ONE_EMAIL_KYC_STRICT_CLIENT_ZK_ENABLED`
    and `HUSHH_PROD_PHONE_TEST_ENABLED` as read by nothing. All three are read,
    two of them gate authentication. A false ORPHAN is an invitation to delete
    a live security control, so this errs toward counting a name that is merely
    mentioned. The cost is a flag that stays; the cost of the other error is a
    webhook that stops checking who is calling it.
    """
    pattern = (
        r"process\.env\.[A-Z][A-Z0-9_]+"
        # Any ALL-CAPS quoted identifier: covers every wrapper and line break.
        r"|\"[A-Z][A-Z0-9_]{3,}\""
        r"|'[A-Z][A-Z0-9_]{3,}'"
    )
    names: set[str] = set()
    for root in SEARCH_ROOTS:
        if not root.exists():
            continue
        result = subprocess.run(
            ["grep", "-rhoE", pattern, str(root)],
            capture_output=True,
            text=True,
            check=False,
        )
        for hit in result.stdout.splitlines():
            match = re.search(r"[A-Z][A-Z0-9_]+", hit)
            if match:
                names.add(match.group(0))
    return names


def _substitution_values(path: Path) -> dict[str, str]:
    """Every `_NAME=value` a lane's build passes, from its workflow or config."""
    if not path.exists():
        return {}
    found: dict[str, str] = {}
    for name, value in _SUBSTITUTION.findall(path.read_text(encoding="utf-8")):
        # A later assignment in the same file wins, matching gcloud's behaviour
        # for a repeated substitution key.
        found[name] = value.strip()
    return found


def _cloudbuild_defaults() -> dict[str, str]:
    """`substitutions:` blocks -- the value a lane gets when it passes none."""
    defaults: dict[str, str] = {}
    for path in CLOUDBUILD_DEFAULTS:
        if not path.exists():
            continue
        in_block = False
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith("substitutions:"):
                in_block = True
                continue
            if in_block and line and not line.startswith((" ", "\t", "#")):
                in_block = False
            if not in_block:
                continue
            match = re.match(r'\s+_([A-Z][A-Z0-9_]*):\s*"?([^"#]*)"?', line)
            if match:
                defaults.setdefault(match.group(1), match.group(2).strip())
    return defaults


def substitution_aliases() -> dict[str, str]:
    """Substitution name -> the env var it is actually deployed as.

    A cloudbuild's `--set-env-vars` and `--build-arg` lines are where a
    substitution is renamed, and the rename is not always cosmetic. The live
    example is `HUSSH_TECH_CLIENT_ENABLED=${_HUSHH_TECH_CLIENT_ENABLED}`:
    the substitution carries the code spelling HUSHH and the env var carries
    the brand spelling HUSSH, deliberately, and the two must not be
    "corrected" into agreement. Without following the mapping this script
    reported that substitution as read by nothing, which is the one class of
    finding that licenses deleting it.
    """
    aliases: dict[str, str] = {}
    for path in CLOUDBUILD_DEFAULTS:
        if not path.exists():
            continue
        for env_name, sub_name in re.findall(
            r"([A-Z][A-Z0-9_]*)=\$\{_([A-Z][A-Z0-9_]*)\}", path.read_text(encoding="utf-8")
        ):
            aliases[sub_name] = env_name
    return aliases


def lane_values(name: str, defaults: dict[str, str]) -> dict[str, str | None]:
    """What each DEPLOYED lane sets this to, or None when it sets nothing.

    `NEXT_PUBLIC_X` is carried to the frontend build as the substitution `_X`,
    so both spellings are checked before falling back to the cloudbuild default.
    """
    bare = name[len("NEXT_PUBLIC_") :] if name.startswith("NEXT_PUBLIC_") else name
    values: dict[str, str | None] = {}
    for lane, path in LANE_WORKFLOWS.items():
        passed = _substitution_values(path)
        value = passed.get(name) or passed.get(bare)
        if value is None:
            value = defaults.get(name) or defaults.get(bare)
        values[lane] = value or None
    return values


def developer_values(name: str) -> dict[str, str | None]:
    values: dict[str, str | None] = {}
    for lane, path in DEVELOPER_OVERRIDE_FILES.items():
        value = None
        if path.exists():
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.startswith(f"{name}="):
                    value = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
        values[lane] = value
    return values


def audit() -> dict:
    referenced = referenced_env_names()
    toggles = sorted(n for n in referenced if TOGGLE_SHAPE.search(n))
    defaults = _cloudbuild_defaults()

    uniform, dead, varying, local_drift = [], [], [], []
    for name in toggles:
        values = lane_values(name, defaults)
        overrides = developer_values(name)
        distinct = set(values.values())

        if distinct == {None}:
            dead.append({"name": name, "values": values})
        elif len(distinct) == 1:
            uniform.append({"name": name, "value": next(iter(distinct)), "values": values})
        else:
            varying.append({"name": name, "values": values})

        # A developer override that disagrees with every lane is why a bug
        # reproduces on one machine and nowhere else. It is not a product
        # defect and must never be reported as one.
        deployed = {v for v in values.values() if v is not None}
        set_locally = {v for v in overrides.values() if v is not None}
        if deployed and set_locally and not (set_locally & deployed):
            local_drift.append(
                {"name": name, "deployed": sorted(deployed), "on_this_machine": overrides}
            )

    aliases = substitution_aliases()
    orphaned = []
    for lane, path in LANE_WORKFLOWS.items():
        for name in _substitution_values(path):
            if not TOGGLE_SHAPE.search(name):
                continue
            spellings = {name, f"NEXT_PUBLIC_{name}"}
            # The name it is actually deployed as, which may differ on purpose.
            if name in aliases:
                spellings.add(aliases[name])
            if not (spellings & referenced):
                orphaned.append({"name": name, "lane": lane})

    return {
        "toggles_found": len(toggles),
        "env_names_referenced": len(referenced),
        "varying": varying,
        "uniform": uniform,
        "dead": dead,
        "orphaned": orphaned,
        "local_drift": local_drift,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json-out", type=Path)
    args = parser.parse_args()

    report = audit()

    print("\nENVIRONMENT TOGGLE AUDIT")
    print("=" * 68)
    print(f"env names read by code   {report['env_names_referenced']}")
    print(f"shaped like a toggle     {report['toggles_found']}")
    print(f"  genuinely varying      {len(report['varying'])}")
    print(f"  uniform (a constant)   {len(report['uniform'])}")
    print(f"  dead (set nowhere)     {len(report['dead'])}")
    print(f"  orphaned (read by no code) {len(report['orphaned'])}")
    print(f"  local drift (this machine) {len(report['local_drift'])}\n")

    if report["varying"]:
        print("EARNS ITS KEEP -- differs by lane")
        for item in report["varying"]:
            print(f"   {item['name']}")
            print(f"      {item['values']}")

    if report["uniform"]:
        print("\nNOT CONFIGURATION -- same value in every lane, inline it")
        for item in report["uniform"]:
            print(f"   {item['name']:52} = {item['value']}")

    if report["dead"]:
        print("\nDEAD -- code reads it, no lane sets it, the branch never runs")
        for item in report["dead"]:
            print(f"   {item['name']}")

    if report["orphaned"]:
        print("\nORPHANED -- set in a lane, read by nothing")
        for item in report["orphaned"]:
            print(f"   {item['name']}  ({item['lane']})")

    if report["local_drift"]:
        print("\nLOCAL DRIFT -- this machine disagrees with every deployed lane")
        print("   Not a product defect. This is why something reproduces here and nowhere else.")
        for item in report["local_drift"]:
            on_machine = {k: v for k, v in item["on_this_machine"].items() if v is not None}
            print(f"   {item['name']}")
            print(f"      deployed        {item['deployed']}")
            print(f"      on this machine {on_machine}")

    if args.json_out:
        args.json_out.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"\nwrote {args.json_out}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
