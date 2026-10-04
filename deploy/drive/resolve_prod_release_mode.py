#!/usr/bin/env python3
"""Preserve the serving production Drive state unless a deploy explicitly changes it."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path
from typing import Any

PROJECT = "hushh-pda"
CANDIDATE_SECRET = re.compile(
    r"BACKEND_RUNTIME_CONFIG_JSON_DRIVE_[1-9][0-9]*_[1-9][0-9]*\Z"
)
DRIVE_FLAGS = (
    "google_drive_connection",
    "google_drive_live",
    "google_drive_picker",
    "drive_document_indexing",
    "drive_document_sharing",
    "google_drive_chat_reads",
    "connector_production_all_users",
)


class DriveReleaseStateError(RuntimeError):
    """A redacted failure when the serving production state is ambiguous."""


def _active_state(revision: dict[str, Any], runtime: dict[str, Any]) -> bool:
    containers = (revision.get("spec") or {}).get("containers") or []
    if len(containers) != 1 or not isinstance(containers[0], dict):
        raise DriveReleaseStateError("Serving backend container set is ambiguous")
    items = containers[0].get("env") or []
    if not isinstance(items, list):
        raise DriveReleaseStateError("Serving backend environment is unavailable")
    env = {
        item.get("name"): item.get("value") for item in items if isinstance(item, dict)
    }
    refs = {
        item.get("name"): ((item.get("valueFrom") or {}).get("secretKeyRef") or {}).get(
            "name"
        )
        for item in items
        if isinstance(item, dict)
    }
    if (
        env.get("HUSHH_DEPLOY_ENV") != "production"
        or runtime.get("environment") != "production"
    ):
        raise DriveReleaseStateError("Serving backend is not attested as production")
    secret_name = refs.get("BACKEND_RUNTIME_CONFIG_JSON")
    if not isinstance(secret_name, str):
        raise DriveReleaseStateError("Serving backend runtime secret is unavailable")
    drain = str(env.get("DRIVE_WORK_DRAIN_ENABLED") or "false").lower()
    if drain not in {"true", "false"}:
        raise DriveReleaseStateError("Serving backend Drive drain state is ambiguous")
    flags = {key: str(runtime.get(key) or "false").lower() for key in DRIVE_FLAGS}
    if any(value not in {"true", "false"} for value in flags.values()):
        raise DriveReleaseStateError("Serving backend Drive flags are ambiguous")
    if drain == "true":
        if not CANDIDATE_SECRET.fullmatch(secret_name) or set(flags.values()) != {
            "true"
        }:
            raise DriveReleaseStateError("Serving live Drive release is incomplete")
        return True
    if (
        any(value == "true" for value in flags.values())
        or (
            secret_name != "BACKEND_RUNTIME_CONFIG_JSON"
            and not CANDIDATE_SECRET.fullmatch(secret_name)
        )
    ):
        raise DriveReleaseStateError("Serving disabled Drive release is inconsistent")
    return False


def resolve_mode(
    *,
    requested_mode: str,
    backend_deploy: bool,
    revision: dict[str, Any] | None,
    runtime: dict[str, Any] | None,
) -> tuple[bool, bool]:
    if requested_mode not in {"preserve", "enable", "disable"}:
        raise DriveReleaseStateError("Unsupported production Drive release mode")
    if requested_mode != "preserve" and not backend_deploy:
        raise DriveReleaseStateError(
            "Changing production Drive requires a backend release"
        )
    previous_active = (
        False if revision is None else _active_state(revision, runtime or {})
    )
    active = (
        previous_active if requested_mode == "preserve" else requested_mode == "enable"
    )
    return previous_active, active


def verify_target_support(
    *,
    active: bool,
    backend_deploy: bool,
    target_sha: str,
    required_ancestor: str,
) -> None:
    """An older image can preserve Drive off, but cannot supply new production support."""
    if not active or not backend_deploy:
        return
    if not all(
        re.fullmatch(r"[0-9a-f]{40}", sha) for sha in (target_sha, required_ancestor)
    ):
        raise DriveReleaseStateError("Production Drive target ancestry is unavailable")
    result = subprocess.run(
        ["git", "merge-base", "--is-ancestor", required_ancestor, target_sha],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        raise DriveReleaseStateError(
            "Live production Drive requires a target SHA containing "
            "production Drive runtime support"
        )


def _serving_runtime_secret(revision: dict[str, Any]) -> str:
    containers = (revision.get("spec") or {}).get("containers") or []
    if len(containers) != 1 or not isinstance(containers[0], dict):
        raise DriveReleaseStateError("Serving backend container set is ambiguous")
    names = [
        ((item.get("valueFrom") or {}).get("secretKeyRef") or {}).get("name")
        for item in (containers[0].get("env") or [])
        if isinstance(item, dict) and item.get("name") == "BACKEND_RUNTIME_CONFIG_JSON"
    ]
    if len(names) != 1 or not isinstance(names[0], str) or not names[0]:
        raise DriveReleaseStateError("Serving backend runtime secret is unavailable")
    if names[0] != "BACKEND_RUNTIME_CONFIG_JSON" and not CANDIDATE_SECRET.fullmatch(
        names[0]
    ):
        raise DriveReleaseStateError("Serving backend runtime secret is unreviewed")
    return names[0]


def _read_runtime(project: str, secret: str) -> dict[str, Any]:
    result = subprocess.run(
        [
            "gcloud",
            "secrets",
            "versions",
            "access",
            "latest",
            f"--secret={secret}",
            f"--project={project}",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        raise DriveReleaseStateError("Serving backend runtime config is unavailable")
    try:
        config = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise DriveReleaseStateError(
            "Serving backend runtime config is invalid"
        ) from exc
    if not isinstance(config, dict):
        raise DriveReleaseStateError("Serving backend runtime config is invalid")
    return config


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument(
        "--mode", choices=("preserve", "enable", "disable"), required=True
    )
    parser.add_argument("--backend-deploy", choices=("true", "false"), required=True)
    parser.add_argument("--previous-revision", default="")
    parser.add_argument("--revision-json", type=Path, required=True)
    parser.add_argument("--github-output", type=Path, required=True)
    parser.add_argument("--target-sha", required=True)
    parser.add_argument("--required-ancestor", required=True)
    args = parser.parse_args()
    if args.project != PROJECT:
        parser.error("Production Drive release mode requires the production project")
    try:
        revision = None
        runtime = None
        if args.previous_revision:
            revision = json.loads(args.revision_json.read_text(encoding="utf-8"))
            if (revision.get("metadata") or {}).get("name") != args.previous_revision:
                raise DriveReleaseStateError(
                    "Serving backend revision changed during preflight"
                )
            runtime = _read_runtime(args.project, _serving_runtime_secret(revision))
        previous, active = resolve_mode(
            requested_mode=args.mode,
            backend_deploy=args.backend_deploy == "true",
            revision=revision,
            runtime=runtime,
        )
        verify_target_support(
            active=active,
            backend_deploy=args.backend_deploy == "true",
            target_sha=args.target_sha,
            required_ancestor=args.required_ancestor,
        )
    except DriveReleaseStateError as exc:
        parser.exit(1, f"{exc}\n")
    except (OSError, ValueError, TypeError):
        parser.exit(1, "Production Drive release state could not be verified\n")
    with args.github_output.open("a", encoding="utf-8") as output:
        output.write(f"previous_active={str(previous).lower()}\n")
        output.write(f"active={str(active).lower()}\n")
    print(
        json.dumps({"mode": args.mode, "previous_active": previous, "active": active})
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
