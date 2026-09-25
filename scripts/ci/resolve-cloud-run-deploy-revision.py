#!/usr/bin/env python3
"""Resolve the one Cloud Run revision created by an exact governed deployment."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--revisions-json", required=True)
    parser.add_argument("--deploy-env", required=True)
    parser.add_argument("--deploy-source", required=True)
    parser.add_argument("--deploy-sha", required=True)
    parser.add_argument("--github-run-id", required=True)
    args = parser.parse_args()

    revisions = json.loads(Path(args.revisions_json).read_text(encoding="utf-8"))
    expected = {
        "deploy-env": args.deploy_env,
        "deploy-source": args.deploy_source,
        "deploy-sha": args.deploy_sha,
        "github-run-id": args.github_run_id,
    }
    matches: list[dict] = []
    for revision in revisions:
        metadata = revision.get("metadata") or {}
        labels = metadata.get("labels") or {}
        if all(str(labels.get(key) or "") == value for key, value in expected.items()):
            matches.append(revision)

    if len(matches) != 1:
        names = [str((item.get("metadata") or {}).get("name") or "") for item in matches]
        raise SystemExit(
            "Expected exactly one Cloud Run revision for governed deployment "
            f"labels {expected!r}; found {len(matches)}: {names!r}"
        )

    name = str((matches[0].get("metadata") or {}).get("name") or "").strip()
    if not name:
        raise SystemExit("Matched Cloud Run revision has no metadata.name")
    print(name)


if __name__ == "__main__":
    main()
