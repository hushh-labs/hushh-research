# tests/test_kai_routes_g004.py
"""
PR attach points:
  api/routes/kai/losers.py  (optimize_portfolio, analyze_portfolio_losers_stream)

Verifies that no f-string logger calls (G004) remain in the Kai
streaming / analysis route modules. chat.py, portfolio.py, and
stream.py were already clean on integration/pr-train; only
losers.py had the 6 remaining violations fixed here.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

_FILES_TO_CHECK = [
    "api/routes/kai/chat.py",
    "api/routes/kai/losers.py",
    "api/routes/kai/portfolio.py",
    "api/routes/kai/stream.py",
]


@pytest.mark.parametrize("rel_path", _FILES_TO_CHECK)
def test_no_fstring_loggers(rel_path: str) -> None:
    """No f-string (JoinedStr) logger calls should remain in the Kai route modules."""
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
