"""
Regression tests for B904 — `raise` inside `except` clause without `from`.

Attach point: api/, hushh_mcp/, hussh_sdk/ — raise statements inside except
blocks were missing `from err` / `from None`, which hides the original exception
context and makes tracebacks misleading (the implicit __context__ chain is set but
the intent is ambiguous; `__cause__` is left unset).

Each parametrised case AST-walks the source file and asserts that no `raise`
statement inside an `except` handler is missing an explicit `cause`.
"""

import ast
import pathlib
import textwrap

import pytest

REPO_ROOT = pathlib.Path(__file__).parent.parent


def _raise_without_cause(path: pathlib.Path) -> list[int]:
    """Return line numbers of bare raises inside except handlers that lack 'from'."""
    source = path.read_text()
    tree = ast.parse(source, filename=str(path))

    violations = []

    class Visitor(ast.NodeVisitor):
        def __init__(self):
            self._in_handler = 0

        def visit_ExceptHandler(self, node):
            self._in_handler += 1
            self.generic_visit(node)
            self._in_handler -= 1

        def visit_Raise(self, node):
            if self._in_handler and node.exc is not None and node.cause is None:
                violations.append(node.lineno)
            self.generic_visit(node)

    Visitor().visit(tree)
    return violations


FILES = [
    "api/middleware.py",
    "api/routes/agents.py",
    "api/routes/consent.py",
    "api/routes/crd_scraper.py",
    "api/routes/db_proxy.py",
    "api/routes/health.py",
    "api/routes/investors.py",
    "api/routes/kai/analyze.py",
    "api/routes/kai/chat.py",
    "api/routes/kai/consent.py",
    "api/routes/kai/voice.py",
    "api/routes/notifications.py",
    "api/routes/pkm_routes_shared.py",
    "api/routes/session.py",
    "api/routes/tickers.py",
    "hushh_mcp/agents/kai/orchestrator.py",
    "hushh_mcp/operons/kai/storage.py",
    "hushh_mcp/services/one_email_kyc_service.py",
    "hushh_mcp/services/portfolio_import_service.py",
    "hushh_mcp/vault/encrypt.py",
    "hussh_sdk/agent.py",
]


@pytest.mark.parametrize("rel_path", FILES)
def test_no_bare_raise_in_except(rel_path):
    path = REPO_ROOT / rel_path
    violations = _raise_without_cause(path)
    assert violations == [], (
        f"{rel_path} still has bare raises inside except handlers at lines: "
        + ", ".join(str(n) for n in violations)
        + "\n"
        + textwrap.dedent(
            """
            Fix: append ' from e' (or ' from None') to each raise:
                except SomeError as e:
                    raise HTTPException(...) from e   # <-- add 'from e'
            """
        )
    )
