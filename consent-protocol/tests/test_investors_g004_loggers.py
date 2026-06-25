"""
Static check for G004 logger fixes in api/routes/investors.py.

Canonical attach points
------------------------
api.routes.investors.search_investors      -> GET /api/investors/search
api.routes.investors.get_investor          -> GET /api/investors/{investor_id}
api.routes.investors.create_investor       -> POST /api/investors/
api.routes.investors.bulk_create_investors -> POST /api/investors/bulk

Four logger.info calls used f-string interpolation (ruff G004), which forces
string interpolation to run on every call regardless of log level. They are
now converted to %-style lazy formatting.
"""

from __future__ import annotations

import ast
import pathlib

import api.routes.investors as investors_mod


def test_no_f_string_loggers_in_module() -> None:
    """Static check: no logger calls use f-strings in investors.py."""
    src = pathlib.Path(investors_mod.__file__).read_text()
    tree = ast.parse(src)

    f_string_loggers: list[int] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (
            isinstance(func, ast.Attribute)
            and func.attr in {"warning", "error", "info", "debug", "exception"}
        ):
            continue
        for arg in node.args:
            if isinstance(arg, ast.JoinedStr):
                f_string_loggers.append(node.lineno)

    assert f_string_loggers == [], f"G004: f-string logger calls found at lines {f_string_loggers}"
