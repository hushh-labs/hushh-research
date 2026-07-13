#!/usr/bin/env python3
"""Generate the canonical product-agent registry from strict YAML manifests."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parent
AGENTS_ROOT = ROOT / "hushh_mcp" / "agents"
OUTPUT = REPO_ROOT / "contracts" / "agents" / "product-agent-registry.v2.json"

sys.path.insert(0, str(ROOT))

from hushh_mcp.hushh_adk.manifest import ManifestLoader  # noqa: E402


def build_registry() -> dict[str, object]:
    manifests = []
    seen_ids: dict[str, Path] = {}
    for path in sorted(AGENTS_ROOT.glob("*/agent.yaml")):
        manifest = ManifestLoader.load(str(path))
        if manifest.id in seen_ids:
            raise ValueError(
                f"duplicate product-agent id {manifest.id!r}: {seen_ids[manifest.id]} and {path}"
            )
        seen_ids[manifest.id] = path
        projection = manifest.model_dump(mode="json", exclude={"system_instruction"})
        projection["manifest_path"] = str(path.relative_to(REPO_ROOT))
        projection["system_instruction_sha256"] = (
            __import__("hashlib").sha256(manifest.system_instruction.encode("utf-8")).hexdigest()
        )
        manifests.append(projection)

    return {
        "schema_version": "2.0.0",
        "source": "consent-protocol/hushh_mcp/agents/*/agent.yaml",
        "agents": manifests,
    }


def render(registry: dict[str, object]) -> str:
    return json.dumps(registry, indent=2, sort_keys=True) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    rendered = render(build_registry())
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_text(encoding="utf-8") != rendered:
            print(f"stale product-agent registry: {OUTPUT}", file=sys.stderr)
            return 1
        print(f"Product-agent registry is current ({len(build_registry()['agents'])} agents).")
        return 0
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(rendered, encoding="utf-8")
    print(f"Generated {OUTPUT.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
