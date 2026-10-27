"""Isolated production candidate writes using the existing runtime config owner."""

from __future__ import annotations

import argparse
import json
import re
from typing import Any, Callable


def valid_candidate_secret(name: str) -> bool:
    return re.fullmatch(r"BACKEND_RUNTIME_CONFIG_JSON_DRIVE_[1-9][0-9]*_[1-9][0-9]*", name) is not None


def validate_candidate_only(args: argparse.Namespace) -> bool:
    enabled = getattr(args, "production_drive_candidate_only", False)
    if enabled is False:
        return False
    if enabled is not True or args.project != "hushh-pda" or args.environment != "production" or not valid_candidate_secret(args.production_drive_candidate_secret):
        raise ValueError("Candidate-only mode requires the production project, environment and per-release Drive secret")
    return True


def split_candidate_config(args: argparse.Namespace, config: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    if args.environment != "production" or not args.production_drive_candidate_secret:
        return config, None
    # Existing serving revisions may read canonical :latest at runtime.
    # Every release gets its own candidate, including a Drive-disabled release.
    return None, dict(config)


def print_sync_summary(project: str, synced: list[str], config: dict[str, Any], **metadata: Any) -> None:
    print(json.dumps({"project": project, "synced_secrets": sorted(set(synced)),
                      "backend_runtime_config_keys": sorted(config), **metadata}, indent=2))


def _read_candidate(project: str, secret: str, run: Callable[..., Any]) -> dict[str, Any] | None:
    result = run(["gcloud", "secrets", "versions", "access", "latest", "--secret", secret, "--project", project], check=False)
    if result.returncode == 0:
        try:
            value = json.loads(result.stdout)
            if not isinstance(value, dict):
                raise ValueError
            return value
        except (TypeError, ValueError) as error:
            raise ValueError("Existing Drive candidate config is invalid; refusing to replace it") from error
    if "NOT_FOUND" not in result.stderr:
        raise ValueError("Existing Drive candidate config could not be verified")
    described = run(["gcloud", "secrets", "describe", secret, "--project", project, "--format=value(name)"], check=False)
    if described.returncode == 0 or "NOT_FOUND" not in described.stderr:
        raise ValueError("Drive candidate absence could not be verified")
    return None


def sync_candidate_only(args: argparse.Namespace, config: dict[str, Any], run: Callable[..., Any], upsert: Callable[[str, str, str], None]) -> int:
    if not validate_candidate_only(args):
        raise ValueError("Candidate-only mode must be explicit")
    if config.get("environment") != "production" or config.get("google_cloud_project") != args.project:
        raise ValueError("Drive candidate configuration belongs to a different runtime")
    secret = args.production_drive_candidate_secret
    existing = _read_candidate(args.project, secret, run)
    if existing is not None and existing != config:
        raise ValueError("Existing Drive candidate differs from requested policy; refusing to replace it")
    if existing is None:
        upsert(args.project, secret, json.dumps(config, separators=(",", ":"), sort_keys=True))
    print_sync_summary(args.project, [secret] if existing is None else [], config,
                       candidate_only=True, candidate_secret=secret, candidate_reused=existing is not None)
    return 0
