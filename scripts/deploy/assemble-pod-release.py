#!/usr/bin/env python3
"""Bind reviewed pod release notes to the image selected by the governed build."""

from __future__ import annotations

import argparse
import base64
import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "pod_release_contract", ROOT / "consent-protocol/hushh_mcp/services/pod_release.py"
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("pod release contract is unavailable")
contract = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(contract)


def browser_qualifications(config: Path, *, image: str, source_sha: str) -> dict:
    """Optional reviewed pins; no file means no Browser qualification offer."""
    if not config.exists():
        return {}
    if config.stat().st_size > 8192:
        raise ValueError("Browser qualification pins exceed their bound")
    pins = json.loads(config.read_text())
    if not isinstance(pins, list) or not 1 <= len(pins) <= 2:
        raise ValueError("invalid Browser qualification pins")
    qualifications = []
    for pin in pins:
        if not isinstance(pin, dict) or set(pin) != {"receipt", "sha256"}:
            raise ValueError("invalid Browser qualification pin")
        relative = pin["receipt"]
        if not isinstance(relative, str):
            raise ValueError("invalid Browser qualification receipt path")
        receipt = (config.parent / relative).resolve(strict=True)
        # Only reviewed source artifacts beside the pin; never arbitrary files,
        # URLs, parent traversal or following a link out of the artifact tree.
        if not receipt.is_relative_to(config.parent.resolve()) or not receipt.is_file():
            raise ValueError("Browser qualification receipt is outside its reviewed tree")
        with receipt.open("rb") as stream:
            raw = stream.read(65537)
        qualifications.append(
            contract.qualification_from_receipt(
                raw,
                expected_sha256=pin["sha256"],
                image_digest=contract.image_digest(image),
                source_revision=source_sha,
            )
        )
    return {"browserQualifications": qualifications}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--descriptor", type=Path, required=True)
    parser.add_argument("--image-reference-file", type=Path, required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--environment", choices=["dev"], required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--browser-qualifications",
        type=Path,
        default=ROOT / "deploy/pod-browser-qualifications.json",
    )
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
            **browser_qualifications(
                args.browser_qualifications, image=image, source_sha=args.source_sha
            ),
        },
        target_image=image,
        environment=args.environment,
    )
    encoded = json.dumps(release, separators=(",", ":"), sort_keys=True).encode()
    args.output.write_bytes(encoded + b"\n")
    args.output.with_suffix(".b64").write_text(base64.b64encode(encoded).decode() + "\n")


if __name__ == "__main__":
    main()
