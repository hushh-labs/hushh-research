"""Kai sealed-route auth compliance checks.

Ensures protected Kai routes declare explicit VAULT_OWNER auth guards.
"""

from __future__ import annotations

import re
from pathlib import Path

KAI_AUTH_EXPECTATIONS = [
    (
        "api/routes/kai/portfolio.py",
        '@router.post("/portfolio/import"',
        "require_vault_owner_token",
    ),
    (
        "api/routes/kai/portfolio.py",
        '@router.post("/portfolio/import/stream"',
        "require_vault_owner_token",
    ),
    (
        "api/routes/kai/losers.py",
        '@router.post("/portfolio/analyze-losers"',
        "require_vault_owner_token",
    ),
    (
        "api/routes/kai/losers.py",
        '@router.post("/portfolio/analyze-losers/stream"',
        "require_vault_owner_token",
    ),
    (
        "api/routes/kai/stream.py",
        '@router.get("/analyze/stream"',
        "validate_token_with_db",
    ),
    (
        "api/routes/kai/stream.py",
        '@router.post("/analyze/stream"',
        "validate_token_with_db",
    ),
    ("api/routes/kai/chat.py", '@router.post("/chat"', "require_vault_owner_token"),
    (
        "api/routes/kai/chat.py",
        '@router.get("/chat/history/{conversation_id}"',
        "require_vault_owner_token",
    ),
    (
        "api/routes/kai/chat.py",
        '@router.get("/chat/conversations/{user_id}"',
        "require_vault_owner_token",
    ),
    (
        "api/routes/kai/chat.py",
        '@router.get("/chat/initial-state/{user_id}"',
        "require_vault_owner_token",
    ),
    (
        "api/routes/kai/gmail.py",
        '@router.get("/gmail/receipts/{user_id}")',
        "require_vault_owner_token",
    ),
    (
        "api/routes/kai/gmail.py",
        '@router.post("/gmail/receipts-memory/preview")',
        "require_vault_owner_token",
    ),
    (
        "api/routes/kai/gmail.py",
        '@router.get("/gmail/receipts-memory/artifacts/{artifact_id}")',
        "require_vault_owner_token",
    ),
]


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _route_block_contains_auth_marker(
    source_text: str, route_marker: str, auth_marker: str
) -> bool:
    pattern = re.compile(rf"{re.escape(route_marker)}[\s\S]{{0,3500}}{re.escape(auth_marker)}")
    return bool(pattern.search(source_text))


def test_kai_routes_use_explicit_vault_owner_auth_guards():
    root = _repo_root()

    failures: list[str] = []
    for relative_path, route_marker, auth_marker in KAI_AUTH_EXPECTATIONS:
        file_path = root / relative_path
        source = file_path.read_text(encoding="utf-8")

        if route_marker not in source:
            failures.append(f"Missing route marker '{route_marker}' in {relative_path}")
            continue

        if not _route_block_contains_auth_marker(source, route_marker, auth_marker):
            failures.append(
                f"Route marker '{route_marker}' in {relative_path} missing auth marker '{auth_marker}'"
            )

    assert not failures, "\n".join(failures)


def test_kai_health_route_remains_unsealed_exception():
    """Health endpoint is intentionally public and should not require vault-owner auth."""
    health_source = (_repo_root() / "api/routes/kai/health.py").read_text(encoding="utf-8")
    assert '@router.get("/health")' in health_source
    assert "require_vault_owner_token" not in health_source
