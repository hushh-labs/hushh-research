# tests/test_portfolio_import_g004.py
"""
PR attach points: PortfolioImportService.import_portfolio,
                  PortfolioImportService.parse_csv, RichPDFParser.parse_comprehensive
                  (hushh_mcp/services/portfolio_import_service.py)

AST static check: verifies no f-string logger calls (G004) remain in
portfolio_import_service.py after converting 33 loggers to %-style.
"""

import ast
import pathlib


def test_no_f_string_loggers_in_portfolio_import_service() -> None:
    """No f-string logger calls (G004) must remain in portfolio_import_service.py."""
    import hushh_mcp.services.portfolio_import_service as module

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
        f"G004: f-string logger calls found at lines {bad_lines} in portfolio_import_service.py"
    )
