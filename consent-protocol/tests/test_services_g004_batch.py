# tests/test_services_g004_batch.py
"""
PR attach points:
- AttributeLearner.extract_attributes / extract_and_store  (attribute_learner.py)
- InvestorDBService.upsert_investor                        (investor_db.py)
- VaultKeysService.get_vault_status                        (vault_keys_service.py)
- PortfolioParser.parse_csv                                (portfolio_parser.py)

AST static check: verifies no f-string logger calls (G004) remain in
each of the four service modules.
"""

import ast
import pathlib


def _f_string_logger_lines(module) -> list[int]:
    src = pathlib.Path(module.__file__).read_text()
    tree = ast.parse(src)
    bad: list[int] = []
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
                bad.append(node.lineno)
    return bad


def test_no_g004_in_attribute_learner() -> None:
    import hushh_mcp.services.attribute_learner as module

    bad = _f_string_logger_lines(module)
    assert bad == [], f"G004 f-string loggers at lines {bad} in attribute_learner.py"


def test_no_g004_in_investor_db() -> None:
    import hushh_mcp.services.investor_db as module

    bad = _f_string_logger_lines(module)
    assert bad == [], f"G004 f-string loggers at lines {bad} in investor_db.py"


def test_no_g004_in_vault_keys_service() -> None:
    import hushh_mcp.services.vault_keys_service as module

    bad = _f_string_logger_lines(module)
    assert bad == [], f"G004 f-string loggers at lines {bad} in vault_keys_service.py"


def test_no_g004_in_portfolio_parser() -> None:
    import hushh_mcp.services.portfolio_parser as module

    bad = _f_string_logger_lines(module)
    assert bad == [], f"G004 f-string loggers at lines {bad} in portfolio_parser.py"
