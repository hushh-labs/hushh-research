# tests/test_consent_db_g004.py
"""
PR attach points: ConsentDBService.insert_event, store_consent_export,
                  get_consent_export, delete_consent_export,
                  cleanup_expired_exports
                  (hushh_mcp/services/consent_db.py)

AST static check: verifies no f-string logger calls (G004) remain in
consent_db.py after converting 8 loggers to %-style formatting.
"""

import ast
import pathlib


def test_no_f_string_loggers_in_consent_db() -> None:
    """No f-string logger calls (G004) must remain in consent_db.py."""
    import hushh_mcp.services.consent_db as module

    src = pathlib.Path(module.__file__).read_text()
    tree = ast.parse(src)
    bad_lines: list[int] = []
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
                bad_lines.append(node.lineno)
    assert bad_lines == [], (
        f"G004: f-string logger calls found at lines {bad_lines} in consent_db.py"
    )
