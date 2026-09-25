#!/usr/bin/env python3
"""Bind reviewed pod release notes to the image selected by the governed build."""

from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "pod_release_contract", ROOT / "consent-protocol/hushh_mcp/services/pod_release.py"
)
assert SPEC is not None and SPEC.loader is not None
contract = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(contract)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--descriptor", type=Path, required=True)
    parser.add_argument("--image-reference-file", type=Path, required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--environment", choices=["dev"], required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    image = args.image_reference_file.read_text().strip()
    descriptor = contract.validate_descriptor(json.loads(args.descriptor.read_text()))
    descriptor["version"] += "+" + args.source_sha[:12] + "." + image.rsplit(":", 1)[-1][:8]
    release = contract.validate_release(
        {
            "schemaVersion": 1,
            "descriptor": descriptor,
            "image": image,
            "sourceRevision": args.source_sha,
            "releasedAt": datetime.now(timezone.utc).isoformat(),
            "publisher": {
                "environment": args.environment,
                "workflow": "deploy-dev",
                "runId": args.run_id,
            },
        },
        target_image=image,
        environment=args.environment,
    )
    encoded = json.dumps(release, separators=(",", ":"), sort_keys=True).encode()
    args.output.write_bytes(encoded + b"\n")
    args.output.with_suffix(".b64").write_text(base64.b64encode(encoded).decode() + "\n")


if __name__ == "__main__":
    main()
