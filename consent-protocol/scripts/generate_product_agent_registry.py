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
# The backend image is built with Docker context `consent-protocol`, so the
# repo-root copy above is not in the image at all. Mirror it inside the context.
# See hushh_mcp/services/generated_contracts.py for the full reasoning.
BACKEND_OUTPUT = ROOT / "contracts" / "agents" / "product-agent-registry.v2.json"
OUTPUTS = (OUTPUT, BACKEND_OUTPUT)

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
        # as_posix, not str: the artifact is committed and CI verifies it with
        # --check on Linux, so a Windows run must not rewrite every path to
        # backslashes and make the check fail for everyone.
        projection["manifest_path"] = path.relative_to(REPO_ROOT).as_posix()
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
        stale = [
            target
            for target in OUTPUTS
            if not target.exists() or target.read_text(encoding="utf-8") != rendered
        ]
        if stale:
            for target in stale:
                print(f"stale product-agent registry: {target}", file=sys.stderr)
            return 1
        print(f"Product-agent registry is current ({len(build_registry()['agents'])} agents).")
        return 0
    for target in OUTPUTS:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(rendered, encoding="utf-8")
        print(f"Generated {target.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
