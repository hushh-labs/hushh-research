# tests/test_services_g004_batch2.py
"""
PR attach points:
  hushh_mcp/services/vault_db.py  (_check_consent, _log_audit)

Verifies that no f-string logger calls (G004) remain in the core
service modules. personal_knowledge_model_service.py and
kai_chat_service.py were already clean on integration/pr-train; only
vault_db.py had the 3 remaining violations fixed here.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

_FILES_TO_CHECK = [
    "hushh_mcp/services/vault_db.py",
    "hushh_mcp/services/personal_knowledge_model_service.py",
    "hushh_mcp/services/kai_chat_service.py",
]


@pytest.mark.parametrize("rel_path", _FILES_TO_CHECK)
def test_no_fstring_loggers(rel_path: str) -> None:
    """No f-string (JoinedStr) logger calls should remain in the service modules."""
    source = Path(rel_path).read_text()
    tree = ast.parse(source)

    violations: list[int] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        is_logger = (
            isinstance(func, ast.Attribute)
            and isinstance(func.value, ast.Name)
            and func.value.id == "logger"
        )
        if not is_logger:
            continue
        for arg in node.args:
            if isinstance(arg, ast.JoinedStr):
                violations.append(node.lineno)

    assert not violations, (
        f"G004 f-string logger(s) remain in {rel_path} at lines: {violations}"
    )
