# tests/test_g004_comprehensive_sweep.py
"""
Static analysis: no f-string loggers (ruff G004) across agents, operons,
MCP server, DB layer, consent, and remaining service modules.

Covered source modules (40 files):
  api/routes/agents.py
  api/routes/consent.py
  db/connection.py
  db/db_client.py
  hushh_mcp/adk_bridge/kai_agent.py
  hushh_mcp/agents/  (all Kai and portfolio-import agent files)
  hushh_mcp/consent/ (scope_generator, token)
  hushh_mcp/hushh_adk/ (core, tools)
  hushh_mcp/operons/kai/ (analysis, fetchers, llm, storage)
  hushh_mcp/services/ (attribute_learner, consent_db, domain_registry,
                        investor_db, portfolio_import, portfolio_parser,
                        vault_keys)
  hushh_mcp/tools/hushh_tools.py
  mcp_modules/ (resources, data_tools, utility_tools)
  mcp_server.py

Ruff G004 requires %-style lazy interpolation in logger calls so that
string formatting is skipped when the log level is disabled.
"""

import ast
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent

SOURCE_FILES = [
    "api/routes/agents.py",
    "api/routes/consent.py",
    "db/connection.py",
    "db/db_client.py",
    "hushh_mcp/adk_bridge/kai_agent.py",
    "hushh_mcp/agents/base_agent.py",
    "hushh_mcp/agents/kai/agent.py",
    "hushh_mcp/agents/kai/debate_engine.py",
    "hushh_mcp/agents/kai/decision_generator.py",
    "hushh_mcp/agents/kai/fundamental_agent.py",
    "hushh_mcp/agents/kai/orchestrator.py",
    "hushh_mcp/agents/kai/renaissance_agent.py",
    "hushh_mcp/agents/kai/sentiment_agent.py",
    "hushh_mcp/agents/kai/valuation_agent.py",
    "hushh_mcp/agents/orchestrator/agent.py",
    "hushh_mcp/agents/portfolio_import/agent.py",
    "hushh_mcp/agents/portfolio_import/parsers/csv_parser.py",
    "hushh_mcp/agents/portfolio_import/parsers/image_parser.py",
    "hushh_mcp/agents/portfolio_import/parsers/pdf_parser.py",
    "hushh_mcp/agents/portfolio_import/tools.py",
    "hushh_mcp/consent/scope_generator.py",
    "hushh_mcp/consent/token.py",
    "hushh_mcp/hushh_adk/core.py",
    "hushh_mcp/hushh_adk/tools.py",
    "hushh_mcp/operons/kai/analysis.py",
    "hushh_mcp/operons/kai/fetchers.py",
    "hushh_mcp/operons/kai/llm.py",
    "hushh_mcp/operons/kai/storage.py",
    "hushh_mcp/services/attribute_learner.py",
    "hushh_mcp/services/consent_db.py",
    "hushh_mcp/services/domain_registry_service.py",
    "hushh_mcp/services/investor_db.py",
    "hushh_mcp/services/portfolio_import_service.py",
    "hushh_mcp/services/portfolio_parser.py",
    "hushh_mcp/services/vault_keys_service.py",
    "hushh_mcp/tools/hushh_tools.py",
    "mcp_modules/resources.py",
    "mcp_modules/tools/data_tools.py",
    "mcp_modules/tools/utility_tools.py",
    "mcp_server.py",
]

LOG_METHODS = {"debug", "info", "warning", "error", "critical", "exception"}


def _fstring_logger_lines(source_path: Path) -> list[int]:
    """Return line numbers where a logger method receives an f-string as first arg."""
    src = source_path.read_text(encoding="utf-8")
    tree = ast.parse(src, filename=str(source_path))
    bad: list[int] = []
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr in LOG_METHODS
            and node.args
            and isinstance(node.args[0], ast.JoinedStr)
        ):
            bad.append(node.lineno)
    return bad


@pytest.mark.parametrize("rel_path", SOURCE_FILES)
def test_no_fstring_loggers(rel_path: str) -> None:
    """Source file must contain zero G004 (f-string logger) violations."""
    path = REPO_ROOT / rel_path
    assert path.exists(), f"Expected source file not found: {rel_path}"
    violations = _fstring_logger_lines(path)
    assert violations == [], (
        f"{rel_path} has f-string logger calls at lines: {violations}. "
        "Use logger.xxx('%s', value) instead of logger.xxx(f'... {value}')."
    )
