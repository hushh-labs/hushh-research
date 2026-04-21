#!/usr/bin/env python3
"""Enforce the canonical backend runtime env contract."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

ALLOWED_LEGACY_PATHS = {
    "scripts/ci/verify-runtime-config-contract.py",
    "scripts/env/bootstrap_profiles.sh",
    "scripts/ops/verify-env-secrets-parity.py",
    "scripts/ops/sync_backend_runtime_secrets.py",
}

ALLOWED_CANONICAL_RUNTIME_READ_PATHS = {
    "consent-protocol/hushh_mcp/runtime_settings.py",
    "hushh-webapp/lib/runtime/settings.ts",
}

FORBIDDEN_NAMES = (
    "SECRET_KEY",
    "VAULT_ENCRYPTION_KEY",
    "FRONTEND_URL",
    "FIREBASE_SERVICE_ACCOUNT_JSON",
    "FIREBASE_AUTH_SERVICE_ACCOUNT_JSON",
    "GMAIL_TOKEN_ENCRYPTION_KEY",
    "PLAID_TOKEN_ENCRYPTION_KEY",
    "KAI_VOICE_REALTIME_ENABLED",
    "KAI_VOICE_V1_ENABLED",
    "KAI_VOICE_V1_CANARY_PERCENT",
    "KAI_VOICE_V1_DISABLE_TOOL_EXECUTION",
    "FORCE_REALTIME_VOICE",
    "FAIL_FAST_VOICE",
    "DISABLE_VOICE_FALLBACKS",
    "OPENAI_VOICE_REALTIME_MODEL",
    "OPENAI_VOICE_STT_MODEL",
    "OPENAI_VOICE_STT_MODELS",
    "OPENAI_VOICE_INTENT_MODEL",
    "OPENAI_VOICE_INTENT_MODELS",
    "OPENAI_VOICE_TTS_MODEL",
    "OPENAI_VOICE_TTS_MODELS",
    "OPENAI_VOICE_TTS_DEFAULT_VOICE",
    "OPENAI_VOICE_TTS_FORMAT",
    "OPENAI_VOICE_TTS_PREFER_QUALITY",
)

CANONICAL_HIGH_RISK_KEYS = (
    "APP_SIGNING_KEY",
    "VAULT_DATA_KEY",
    "APP_FRONTEND_ORIGIN",
    "FIREBASE_ADMIN_CREDENTIALS_JSON",
    "GMAIL_OAUTH_TOKEN_KEY",
    "PLAID_ACCESS_TOKEN_KEY",
    "BACKEND_RUNTIME_CONFIG_JSON",
    "VOICE_RUNTIME_CONFIG_JSON",
)

FORBIDDEN_CANONICAL_SURFACE_NAMES = (
    "APP_RUNTIME_MODE",
    "RESOURCE_TARGET",
    "DB_RESOURCE_TARGET",
    "NEXT_PUBLIC_FRONTEND_URL",
    "NEXT_PUBLIC_AUTH_FIREBASE_API_KEY",
    "NEXT_PUBLIC_AUTH_FIREBASE_AUTH_DOMAIN",
    "NEXT_PUBLIC_AUTH_FIREBASE_PROJECT_ID",
    "NEXT_PUBLIC_AUTH_FIREBASE_APP_ID",
    "MCP_DEVELOPER_TOKEN",
    "FIREBASE_AUTH_VERIFIER_CREDENTIALS_JSON",
)

RUNTIME_SOURCE_PREFIXES = (
    "consent-protocol/api/",
    "consent-protocol/hushh_mcp/",
    "consent-protocol/mcp_modules/",
    "hushh-webapp/lib/",
    "hushh-webapp/app/",
)


def _tracked_files() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
    )
    entries = [item for item in result.stdout.decode("utf-8").split("\0") if item]
    return [REPO_ROOT / item for item in entries]


def _pattern(name: str) -> re.Pattern[str]:
    return re.compile(rf"(?<![A-Z0-9_]){re.escape(name)}(?![A-Z0-9_])")


def _is_runtime_source(relative: str) -> bool:
    return relative.startswith(RUNTIME_SOURCE_PREFIXES)


def _has_direct_env_read(line: str) -> bool:
    return any(
        token in line
        for token in (
            "os.getenv(",
            "os.environ[",
            "process.env.",
            "process.env[",
        )
    )


def main() -> int:
    patterns = {name: _pattern(name) for name in (*FORBIDDEN_NAMES, *FORBIDDEN_CANONICAL_SURFACE_NAMES)}
    violations: list[str] = []
    canonical_patterns = {name: _pattern(name) for name in CANONICAL_HIGH_RISK_KEYS}

    for path in _tracked_files():
        relative = path.relative_to(REPO_ROOT).as_posix()
        if relative in ALLOWED_LEGACY_PATHS:
            continue
        if not path.exists():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for line_no, line in enumerate(text.splitlines(), start=1):
            for name, pattern in patterns.items():
                if pattern.search(line):
                    violations.append(f"{relative}:{line_no}: legacy runtime key '{name}'")
            if (
                _is_runtime_source(relative)
                and relative not in ALLOWED_CANONICAL_RUNTIME_READ_PATHS
                and _has_direct_env_read(line)
            ):
                for name, pattern in canonical_patterns.items():
                    if pattern.search(line):
                        violations.append(
                            f"{relative}:{line_no}: direct runtime env read for canonical key '{name}'"
                        )

    if violations:
        sys.stderr.write(
            "Runtime config contract violations detected:\n"
        )
        for item in violations:
            sys.stderr.write(f"  {item}\n")
        return 1

    print(
        "runtime config contract: no retired backend env names leaked outside migration shims, "
        "and high-risk canonical keys resolve through the approved settings modules"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
