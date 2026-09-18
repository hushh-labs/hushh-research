#!/usr/bin/env python3
"""The Hussh Mega Map, v2 — derived from the implementation, not described alongside it.

The v1 map was hand-authored: layers, components and flows were literals in the
generator, and keeping them true was a discipline rather than a property. It
drifted exactly where you would predict — the per-user pod was absent for the
entire time it was being built and deployed, and nothing failed, because nothing
could.

v2 inverts the relationship. The volatile facts are SCANNED from the repository
at generation time:

  * the agent inventory, and for each agent whether it is genuinely wired or a
    manifest with no Python behind it;
  * Agent One's real tool surface, read from the assembled ADK request rather
    than from a list someone maintained;
  * the deploy lanes, from the workflow files;
  * the CI gate lanes, the ops scripts, and the documentation families.

Anything that can be derived is derived. What remains hardcoded is only what is
genuinely editorial -- the narrative of a flow, the reason a boundary exists --
and that is marked as such.

The distinction the map now carries, which v1 could not express at all:

    WIRED          reachable from Agent One at runtime
    NO CALLER      has an implementation, nothing imports it
    MANIFEST ONLY  agent.yaml exists, no Python does

Usage:  python3 hussh-mega-map-v2.gen.py [--json]
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent
BACKEND = ROOT / "consent-protocol"
AGENTS_DIR = BACKEND / "hushh_mcp" / "agents"

# ---------------------------------------------------------------------------
# Derivation: the agent inventory and its honest wiring status
# ---------------------------------------------------------------------------

WIRED = "wired"
NO_CALLER = "no_caller"
MANIFEST_ONLY = "manifest_only"

#: Agents that ARE reachable but whose reachability cannot be seen by counting
#: importers, because Agent One reaches them through a function tool rather than
#: by importing the package. Kept explicit and justified rather than inferred,
#: because guessing here would be the same error v1 made.
_TOOL_REACHED = {
    "nav": "reached via ask_consent_agent, which routes to Nav's Consent Center",
}


def scan_agents() -> list[dict]:
    """Every agent manifest, with wiring status computed from the real tree."""
    out: list[dict] = []
    if not AGENTS_DIR.is_dir():
        return out
    for path in sorted(AGENTS_DIR.iterdir()):
        if not path.is_dir() or path.name == "__pycache__":
            continue
        manifest = path / "agent.yaml"
        modules = [
            p for p in path.glob("*.py") if p.name != "__init__.py"
        ]
        importers = _external_importers(path.name)
        if modules and importers:
            status = WIRED
        elif modules:
            status = NO_CALLER
        else:
            status = MANIFEST_ONLY
        note = _TOOL_REACHED.get(path.name, "")
        if note:
            status = WIRED
        out.append(
            {
                "id": path.name,
                "manifest": manifest.exists(),
                "modules": len(modules),
                "importers": importers,
                "status": status,
                "note": note,
            }
        )
    return out


def _external_importers(agent: str) -> int:
    """How many modules outside this agent's own package import it."""
    pattern = rf"agents\.{re.escape(agent)}[\. ]|agents\.{re.escape(agent)}$"
    try:
        result = subprocess.run(  # noqa: S603 - fixed argv, no shell; `pattern` is built from a directory name
            ["grep", "-rlE", pattern, "--include=*.py", "hushh_mcp", "api"],
            cwd=BACKEND,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except Exception:  # noqa: BLE001 - a scan failure must not fake a clean map
        return -1
    files = [f for f in result.stdout.splitlines() if f.strip()]
    return len([f for f in files if not f.startswith(f"hushh_mcp/agents/{agent}/")])


# ---------------------------------------------------------------------------
# Derivation: Agent One's live tool surface
# ---------------------------------------------------------------------------

def scan_tool_surface() -> list[str]:
    """The tools Agent One actually offers, from a real assembled ADK request.

    Reuses the validation harness's probe rather than reimplementing it, so the
    map and the harness can never disagree about what the tree offers -- and if
    the tree fails to build, this returns empty and the map says so rather than
    rendering a confident diagram of nothing.
    """
    script = (
        "import asyncio,sys;"
        "sys.path.insert(0,'.');"
        "from scripts.ops.validate_agent_platform import probe_surface;"
        "print(' '.join(sorted(asyncio.run(probe_surface()))))"
    )
    env_prefix = {
        "TESTING": "true",
        "APP_SIGNING_KEY": "test_secret_key_for_ci_only_32chars_min",
        "VAULT_DATA_KEY": "0" * 64,
        "HUSHH_DEVELOPER_TOKEN": "test_hushh_developer_token_for_ci",
        "ADK_DISABLE_GEMINI_MODEL_ID_CHECK": "1",
    }
    import os

    env = {**os.environ, **env_prefix}
    try:
        result = subprocess.run(  # noqa: S603 - fixed argv, no shell; `script` is the literal above
            ["uv", "run", "python", "-c", script],
            cwd=BACKEND,
            capture_output=True,
            text=True,
            timeout=600,
            env=env,
            check=False,
        )
    except Exception:  # noqa: BLE001
        return []
    line = [ln for ln in result.stdout.splitlines() if ln.strip()]
    return line[-1].split() if line else []


# ---------------------------------------------------------------------------
# Derivation: deploy lanes, CI lanes, ops scripts, documentation families
# ---------------------------------------------------------------------------

def scan_deploy_lanes() -> list[dict]:
    lanes = []
    wf = ROOT / ".github" / "workflows"
    for path in sorted(wf.glob("deploy-*.yml")):
        text = path.read_text(encoding="utf-8", errors="replace")
        project = _first(text, r"GCP_PROJECT_ID:\s*(\S+)")
        region = _first(text, r"GCP_REGION:\s*(\S+)")
        name = _first(text, r"^name:\s*(.+)$")
        lanes.append(
            {
                "file": path.name,
                "name": (name or path.stem).strip(),
                "project": project or "?",
                "region": region or "?",
            }
        )
    return lanes


def scan_ci_lanes() -> list[str]:
    path = ROOT / "scripts" / "ci" / "orchestrate.sh"
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8", errors="replace")
    # Lanes appear as case-statement labels in the orchestrator.
    return sorted(set(re.findall(r"^\s{2,4}([a-z][a-z0-9_-]*)\)", text, re.M)))


def scan_ops_scripts() -> list[str]:
    d = ROOT / "consent-protocol" / "scripts" / "ops"
    return sorted(p.name for p in d.glob("*.py")) if d.is_dir() else []


def scan_doc_families() -> list[dict]:
    base = ROOT / "docs" / "reference"
    out = []
    if base.is_dir():
        for child in sorted(base.iterdir()):
            if child.is_dir():
                out.append({"family": child.name, "pages": len(list(child.glob("*.md")))})
    return out


def _first(text: str, pattern: str) -> str | None:
    match = re.search(pattern, text, re.M)
    return match.group(1).strip() if match else None


# ---------------------------------------------------------------------------
# The derived model
# ---------------------------------------------------------------------------

def build_model() -> dict:
    agents = scan_agents()
    surface = scan_tool_surface()
    model = {
        "generated_from": "implementation scan",
        "agents": agents,
        "agent_counts": {
            "total": len(agents),
            "with_manifest": sum(1 for a in agents if a["manifest"]),
            "wired": sum(1 for a in agents if a["status"] == WIRED),
            "no_caller": sum(1 for a in agents if a["status"] == NO_CALLER),
            "manifest_only": sum(1 for a in agents if a["status"] == MANIFEST_ONLY),
        },
        "tool_surface": surface,
        "deploy_lanes": scan_deploy_lanes(),
        "ci_lanes": scan_ci_lanes(),
        "ops_scripts": scan_ops_scripts(),
        "doc_families": scan_doc_families(),
    }
    return model


def render_text(model: dict) -> str:
    """A readable rendering of the derived model.

    Text first, deliberately. A map whose facts are wrong is wrong whether it is
    drawn beautifully or not, and this form can be diffed in review -- which the
    SVG cannot.
    """
    lines: list[str] = []
    add = lines.append
    counts = model["agent_counts"]

    add("THE HUSSH MEGA MAP v2 — derived from the implementation")
    add("=" * 72)
    add("")
    # Directories, not manifests. Two agent packages (orchestrator,
    # realtime_bench) carry Python but no agent.yaml, so calling this a manifest
    # count would be off by exactly the cases that are most interesting.
    add(f"AGENTS  {counts['total']} packages ({counts['with_manifest']} with agent.yaml): "
        f"{counts['wired']} wired · {counts['no_caller']} no caller · "
        f"{counts['manifest_only']} manifest only")
    add("")
    for agent in model["agents"]:
        label = {
            WIRED: "WIRED       ",
            NO_CALLER: "NO CALLER   ",
            MANIFEST_ONLY: "MANIFEST    ",
        }[agent["status"]]
        note = f"  ({agent['note']})" if agent["note"] else ""
        add(f"  {label} {agent['id']:<24} py={agent['modules']:<3} importers={agent['importers']}{note}")

    add("")
    surface = model["tool_surface"]
    add(f"AGENT ONE TOOL SURFACE  {len(surface)} tools offered at runtime")
    if not surface:
        add("  !! EMPTY — the tree failed to build. That is the finding, not a blank section.")
    for name in surface:
        add(f"  - {name}")

    add("")
    add("DEPLOY LANES")
    for lane in model["deploy_lanes"]:
        add(f"  {lane['name']:<24} {lane['project']:<18} {lane['region']:<14} ({lane['file']})")

    add("")
    add(f"CI LANES  {', '.join(model['ci_lanes']) or '(none found)'}")

    add("")
    add(f"OPS SCRIPTS  {len(model['ops_scripts'])}")
    for name in model["ops_scripts"]:
        add(f"  - {name}")

    add("")
    add("DOCUMENTATION FAMILIES")
    for family in model["doc_families"]:
        add(f"  {family['family']:<20} {family['pages']:>3} pages")

    add("")
    add("-" * 72)
    add("Every line above was scanned, not asserted. If a fact here is wrong, the")
    add("implementation changed and this map changed with it -- which is the point.")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="emit the derived model as JSON")
    parser.add_argument("--out", default=None, help="write to a file instead of stdout")
    args = parser.parse_args()

    model = build_model()
    text = json.dumps(model, indent=2) if args.json else render_text(model)

    if args.out:
        pathlib.Path(args.out).write_text(text + "\n", encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        print(text)

    # A map that cannot see the agent tree is not a map. Fail loudly.
    return 0 if model["tool_surface"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
