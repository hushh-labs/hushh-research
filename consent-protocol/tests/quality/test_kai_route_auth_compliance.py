"""Kai sealed-route auth compliance checks.

Ensures protected Kai routes declare explicit VAULT_OWNER auth guards.
"""

from __future__ import annotations

import ast
from pathlib import Path

KAI_AUTH_EXPECTATIONS = [
    (
        "api/routes/kai/portfolio.py",
        '@router.post("/portfolio/import"',
        "hub_content_owner",
    ),
    (
        "api/routes/kai/portfolio.py",
        '@router.post("/portfolio/import/stream"',
        "hub_content_owner",
    ),
    (
        "api/routes/kai/losers.py",
        '@router.post("/portfolio/analyze-losers"',
        "hub_content_owner",
    ),
    (
        "api/routes/kai/losers.py",
        '@router.post("/portfolio/analyze-losers/stream"',
        "hub_content_owner",
    ),
    (
        "api/routes/kai/stream.py",
        '@router.get("/analyze/stream"',
        "Depends(hub_content_owner)",
    ),
    (
        "api/routes/kai/stream.py",
        '@router.post("/analyze/stream"',
        "Depends(hub_content_owner)",
    ),
    (
        "api/routes/kai/stream.py",
        '@router.post("/analyze/run/start"',
        "Depends(hub_content_owner)",
    ),
    (
        "api/routes/kai/stream.py",
        '@router.get("/analyze/run/active"',
        "Depends(hub_content_owner)",
    ),
    (
        "api/routes/kai/stream.py",
        '@router.get("/analyze/run/{run_id}/stream"',
        "Depends(hub_content_owner)",
    ),
    (
        "api/routes/kai/stream.py",
        '@router.post("/analyze/run/{run_id}/cancel"',
        "Depends(hub_content_owner)",
    ),
    ("api/routes/kai/chat.py", '@router.post("/chat"', "hub_content_owner"),
    (
        "api/routes/kai/chat.py",
        '@router.get("/chat/history/{conversation_id}"',
        "hub_content_owner",
    ),
    (
        "api/routes/kai/chat.py",
        '@router.get("/chat/conversations/{user_id}"',
        "hub_content_owner",
    ),
    (
        "api/routes/kai/chat.py",
        '@router.get("/chat/initial-state/{user_id}"',
        "hub_content_owner",
    ),
    (
        "api/routes/kai/gmail.py",
        '@router.get("/gmail/receipts/{user_id}")',
        "hub_content_owner",
    ),
    (
        "api/routes/kai/gmail.py",
        '@router.post("/gmail/receipts/scan",',
        "hub_content_owner",
    ),
    (
        "api/routes/kai/gmail.py",
        '@router.post("/gmail/receipts/detail",',
        "hub_content_owner",
    ),
    (
        "api/routes/kai/gmail.py",
        '@router.post("/gmail/receipts-memory/preview")',
        "hub_content_owner",
    ),
    (
        "api/routes/kai/gmail.py",
        '@router.get("/gmail/receipts-memory/artifacts/{artifact_id}")',
        "hub_content_owner",
    ),
]


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _route_block_contains_auth_marker(
    source_text: str, route_marker: str, auth_marker: str
) -> bool:
    marker = source_text.find(route_marker)
    if marker < 0:
        return False
    marker_line = source_text[:marker].count("\n") + 1
    expected = auth_marker.removeprefix("Depends(").removesuffix(")")
    for node in ast.parse(source_text).body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if not any(item.lineno == marker_line for item in node.decorator_list):
            continue
        for default in [*node.args.defaults, *node.args.kw_defaults]:
            if (
                isinstance(default, ast.Call)
                and isinstance(default.func, ast.Name)
                and default.func.id == "Depends"
                and len(default.args) == 1
                and isinstance(default.args[0], ast.Name)
                and default.args[0].id == expected
            ):
                return True
    return False


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


def test_placement_owner_guard_retains_vault_auth_and_refuses_unknown_wrappers():
    source = (_repo_root() / "hushh_mcp/services/owner_placement_guard.py").read_text()
    node = next(
        item
        for item in ast.parse(source).body
        if isinstance(item, ast.AsyncFunctionDef) and item.name == "hub_content_owner"
    )
    assert ast.unparse(node.args.defaults[0]) == "Depends(require_vault_owner_token)"
    assert any(
        isinstance(item, ast.Await)
        and isinstance(item.value, ast.Call)
        and isinstance(item.value.func, ast.Name)
        and item.value.func.id == "admit_hub_content"
        for item in ast.walk(node)
    )
    marker = '@router.post("/protected")'
    for name in ("unknown_owner_guard", "require_firebase_auth"):
        snippet = f"{marker}\nasync def protected(token=Depends({name})):\n    pass\n"
        assert not _route_block_contains_auth_marker(snippet, marker, "hub_content_owner")
    snippet = f"{marker}\nasync def protected():\n    # Depends(hub_content_owner)\n    pass\n"
    assert not _route_block_contains_auth_marker(snippet, marker, "hub_content_owner")
