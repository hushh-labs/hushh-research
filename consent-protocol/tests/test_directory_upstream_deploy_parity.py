"""Deploy-config contract for the Connect advisor and insurance directories.

Both directory services need an upstream base URL in the hosted runtime config
(advisor_directory_service / insurance_agent_directory_service answer 503
without one). deploy-uat.yml passed both to sync_backend_runtime_secrets.py;
deploy-production.yml passed neither, and the generator's default is empty, so
both directories answered 503 in production while UAT worked -- a gap no UAT
check could see.

Production reads the URLs from its own environment variables rather than
copying UAT's upstreams.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
_DIRECTORY_FLAGS = ("--advisors-api-base-url", "--insurance-agents-api-base-url")


def _backend_sync_invocation(workflow: str, output_file: str) -> str:
    text = (REPO_ROOT / ".github/workflows" / workflow).read_text(encoding="utf-8")
    start = text.index("scripts/ops/sync_backend_runtime_secrets.py")
    end = text.index(output_file, start)
    return text[start:end]


def _flag_value(invocation: str, flag: str) -> str | None:
    match = re.search(rf'{re.escape(flag)} "([^"]*)"', invocation)
    return match.group(1) if match else None


def test_uat_passes_both_directory_upstreams() -> None:
    uat = _backend_sync_invocation("deploy-uat.yml", "uat-runtime-secret-sync.json")
    for flag in _DIRECTORY_FLAGS:
        assert _flag_value(uat, flag), f"deploy-uat.yml no longer passes {flag}"


def test_production_passes_both_directory_upstreams_from_its_own_variables() -> None:
    prod = _backend_sync_invocation("deploy-production.yml", "prod-runtime-secret-sync.json")
    for flag in _DIRECTORY_FLAGS:
        value = _flag_value(prod, flag)
        assert value is not None, f"deploy-production.yml does not pass {flag}"
        assert value.startswith("${{ vars."), (
            f"{flag} must come from a production variable, not a hardcoded host: {value}"
        )
        assert "sslip.io" not in value, f"{flag} must not point production at UAT's host"
