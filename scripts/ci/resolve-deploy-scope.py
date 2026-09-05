#!/usr/bin/env python3
"""Resolve Cloud Run deploy scope from explicit operator input or changed paths."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Iterable


EXPLICIT_SCOPES = {"all", "backend", "frontend"}
AUTO_SCOPE = "auto"

FRONTEND_PREFIXES = (
    "hushh-webapp/",
)
BACKEND_PREFIXES = (
    "consent-protocol/",
)
FRONTEND_EXACT_PATHS = {
    "deploy/frontend.cloudbuild.yaml",
    "scripts/ops/sync_frontend_runtime_secrets.py",
}
BACKEND_EXACT_PATHS = {
    "deploy/backend.cloudbuild.yaml",
    "scripts/ops/sync_backend_runtime_secrets.py",
}
NEUTRAL_PREFIXES = (
    ".codex/",
    "docs/",
    ".github/workflows/",
    "scripts/ci/",
)
NEUTRAL_EXACT_PATHS = {
}

# These files together define one account-lifecycle compatibility boundary.
# A narrow manual override is unsafe while any of them differs from either
# deployed service: it can activate schema/runtime deletion semantics without
# the web/native invalidation UX, or ship that UX against an older backend.
ACCOUNT_LIFECYCLE_ATOMIC_PREFIXES = (
    "deploy/account-deletion/",
    "hushh-webapp/lib/auth/session-",
    "hushh-webapp/lib/capacitor/session-privacy",
    "hushh-webapp/android/app/src/main/java/com/hussh/app/plugins/HushhSessionPrivacy/",
)
ACCOUNT_LIFECYCLE_ATOMIC_EXACT_PATHS = {
    "consent-protocol/db/migrations/201_account_deletion_tombstones.sql",
    "consent-protocol/db/migrations/rollback/201_account_deletion_tombstones.rollback.sql",
    "consent-protocol/hushh_mcp/services/account_deletion_lifecycle_service.py",
    "hushh-webapp/ios/App/App/Plugins/HushhSessionPrivacyPlugin.swift",
}


@dataclass(frozen=True)
class ScopeDecision:
    scope: str
    deploy_backend: bool
    deploy_frontend: bool
    backend_changed_files: tuple[str, ...]
    frontend_changed_files: tuple[str, ...]
    shared_changed_files: tuple[str, ...]
    neutral_changed_files: tuple[str, ...]
    reason: str

    def as_outputs(self) -> dict[str, object]:
        return {
            "scope": self.scope,
            "deploy_backend": self.deploy_backend,
            "deploy_frontend": self.deploy_frontend,
            "backend_changed_files": list(self.backend_changed_files),
            "frontend_changed_files": list(self.frontend_changed_files),
            "shared_changed_files": list(self.shared_changed_files),
            "neutral_changed_files": list(self.neutral_changed_files),
            "reason": self.reason,
        }


def normalize_path(raw_path: str) -> str:
    path = raw_path.strip().replace("\\", "/")
    if not path:
        return ""
    normalized = PurePosixPath(path).as_posix()
    return normalized[2:] if normalized.startswith("./") else normalized


def classify_path(path: str) -> str:
    path = normalize_path(path)
    if not path:
        return "neutral"
    if path in FRONTEND_EXACT_PATHS or path.startswith(FRONTEND_PREFIXES):
        return "frontend"
    if path in BACKEND_EXACT_PATHS or path.startswith(BACKEND_PREFIXES):
        return "backend"
    if path in NEUTRAL_EXACT_PATHS or path.startswith(NEUTRAL_PREFIXES):
        return "neutral"
    return "shared"


def run_git_diff(base_sha: str, target_sha: str) -> list[str]:
    if not base_sha or not target_sha:
        return []
    if base_sha == target_sha:
        return []
    command = ["git", "diff", "--name-only", f"{base_sha}..{target_sha}"]
    result = subprocess.run(command, check=True, text=True, capture_output=True)
    return [normalize_path(line) for line in result.stdout.splitlines() if line.strip()]


def unique_sorted(values: Iterable[str]) -> tuple[str, ...]:
    return tuple(sorted(dict.fromkeys(value for value in values if value)))


def account_lifecycle_atomic_files(paths: Iterable[str]) -> tuple[str, ...]:
    matches = []
    for raw_path in paths:
        path = normalize_path(raw_path)
        if path in ACCOUNT_LIFECYCLE_ATOMIC_EXACT_PATHS or path.startswith(
            ACCOUNT_LIFECYCLE_ATOMIC_PREFIXES
        ):
            matches.append(path)
    return unique_sorted(matches)


def changed_files_between_service_bases(
    *, target_sha: str, backend_base_sha: str, frontend_base_sha: str
) -> tuple[str, ...]:
    backend_diff = run_git_diff(backend_base_sha, target_sha)
    frontend_diff = run_git_diff(frontend_base_sha, target_sha)
    return unique_sorted([*backend_diff, *frontend_diff])


def explicit_decision(scope: str) -> ScopeDecision:
    return ScopeDecision(
        scope=scope,
        deploy_backend=scope in {"all", "backend"},
        deploy_frontend=scope in {"all", "frontend"},
        backend_changed_files=(),
        frontend_changed_files=(),
        shared_changed_files=(),
        neutral_changed_files=(),
        reason=f"explicit:{scope}",
    )


def auto_decision(
    *,
    target_sha: str,
    backend_base_sha: str,
    frontend_base_sha: str,
) -> ScopeDecision:
    if not backend_base_sha or not frontend_base_sha:
        return ScopeDecision(
            scope="all",
            deploy_backend=True,
            deploy_frontend=True,
            backend_changed_files=(),
            frontend_changed_files=(),
            shared_changed_files=(),
            neutral_changed_files=(),
            reason="auto:fallback_missing_deployed_sha",
        )

    candidate_files = changed_files_between_service_bases(
        target_sha=target_sha,
        backend_base_sha=backend_base_sha,
        frontend_base_sha=frontend_base_sha,
    )

    backend_files: list[str] = []
    frontend_files: list[str] = []
    shared_files: list[str] = []
    neutral_files: list[str] = []

    for path in candidate_files:
        classification = classify_path(path)
        if classification == "backend":
            backend_files.append(path)
        elif classification == "frontend":
            frontend_files.append(path)
        elif classification == "shared":
            shared_files.append(path)
        else:
            neutral_files.append(path)

    lifecycle_files = account_lifecycle_atomic_files(candidate_files)
    deploy_backend = bool(backend_files or shared_files or lifecycle_files)
    deploy_frontend = bool(frontend_files or shared_files or lifecycle_files)

    if deploy_backend and deploy_frontend:
        scope = "all"
    elif deploy_backend:
        scope = "backend"
    elif deploy_frontend:
        scope = "frontend"
    else:
        scope = "all"
        deploy_backend = True
        deploy_frontend = True

    reason = "auto:changed_paths"
    if lifecycle_files:
        reason = "auto:account_lifecycle_atomic"
    elif shared_files:
        reason = "auto:shared_paths"
    elif not backend_files and not frontend_files:
        reason = "auto:fallback_no_service_paths"

    return ScopeDecision(
        scope=scope,
        deploy_backend=deploy_backend,
        deploy_frontend=deploy_frontend,
        backend_changed_files=unique_sorted(backend_files),
        frontend_changed_files=unique_sorted(frontend_files),
        shared_changed_files=unique_sorted(shared_files),
        neutral_changed_files=unique_sorted(neutral_files),
        reason=reason,
    )


def resolve_decision(
    *,
    requested_scope: str,
    target_sha: str,
    backend_base_sha: str,
    frontend_base_sha: str,
) -> ScopeDecision:
    if requested_scope == AUTO_SCOPE:
        return auto_decision(
            target_sha=target_sha,
            backend_base_sha=backend_base_sha,
            frontend_base_sha=frontend_base_sha,
        )
    if requested_scope not in EXPLICIT_SCOPES:
        raise ValueError(f"Unsupported deploy scope: {requested_scope}")
    if requested_scope == "all":
        return explicit_decision(requested_scope)

    if not backend_base_sha or not frontend_base_sha:
        raise ValueError(
            "A narrow manual deploy cannot prove the account-lifecycle boundary "
            "because a deployed service SHA is missing; choose scope=all"
        )
    candidate_files = changed_files_between_service_bases(
        target_sha=target_sha,
        backend_base_sha=backend_base_sha,
        frontend_base_sha=frontend_base_sha,
    )
    lifecycle_files = account_lifecycle_atomic_files(candidate_files)
    if lifecycle_files:
        raise ValueError(
            "A narrow manual deploy would split the account-lifecycle boundary; "
            f"choose scope=all (changed: {','.join(lifecycle_files)})"
        )
    return explicit_decision(requested_scope)


def write_github_outputs(path: str, decision: ScopeDecision) -> None:
    outputs = decision.as_outputs()
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(f"scope={decision.scope}\n")
        handle.write(f"deploy_backend={str(decision.deploy_backend).lower()}\n")
        handle.write(f"deploy_frontend={str(decision.deploy_frontend).lower()}\n")
        handle.write(f"reason={decision.reason}\n")
        for key in (
            "backend_changed_files",
            "frontend_changed_files",
            "shared_changed_files",
            "neutral_changed_files",
        ):
            handle.write(f"{key}={','.join(outputs[key])}\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--requested-scope", required=True)
    parser.add_argument("--target-sha", required=True)
    parser.add_argument("--backend-base-sha", default="")
    parser.add_argument("--frontend-base-sha", default="")
    parser.add_argument("--github-output", default="")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    requested_scope = args.requested_scope.strip() or AUTO_SCOPE
    try:
        decision = resolve_decision(
            requested_scope=requested_scope,
            target_sha=args.target_sha.strip(),
            backend_base_sha=args.backend_base_sha.strip(),
            frontend_base_sha=args.frontend_base_sha.strip(),
        )
    except (ValueError, subprocess.CalledProcessError) as exc:
        print(str(exc), file=sys.stderr)
        return 2

    if args.github_output:
        write_github_outputs(args.github_output, decision)

    payload = decision.as_outputs()
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(
            "scope={scope} deploy_backend={deploy_backend} "
            "deploy_frontend={deploy_frontend} reason={reason}".format(**payload)
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
