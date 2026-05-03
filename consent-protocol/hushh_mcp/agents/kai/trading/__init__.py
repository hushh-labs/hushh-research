"""Kai Trading specialist.

Composes the operons under `hushh_mcp/operons/kai/trading/` into a
specialist surface that the orchestrator (and MCP server) can call.

This module deliberately exposes only thin facades; business logic
lives in the operons so it is testable without spinning up the agent
runtime.
"""

from .manifest import MANIFEST as TRADING_MANIFEST, get_manifest
from .tools import (
    list_strategies,
    propose_order,
    run_backtest,
    start_paper_session,
    walk_forward_evaluate,
)

__all__ = [
    "MANIFEST",
    "TRADING_MANIFEST",
    "get_manifest",
    "list_strategies",
    "propose_order",
    "run_backtest",
    "start_paper_session",
    "walk_forward_evaluate",
]
MANIFEST = TRADING_MANIFEST
