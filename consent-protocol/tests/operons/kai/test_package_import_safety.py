"""Compatibility and import-safety proof for the Kai operon package."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

PROTOCOL_ROOT = Path(__file__).resolve().parents[3]


def _run_probe(source: str) -> dict:
    result = subprocess.run(
        [sys.executable, "-c", source],
        cwd=PROTOCOL_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def test_package_import_does_not_load_provider_operons() -> None:
    result = _run_probe(
        """
import json
import sys
import hushh_mcp.operons.kai

print(json.dumps({
    "llm": "hushh_mcp.operons.kai.llm" in sys.modules,
    "storage": "hushh_mcp.operons.kai.storage" in sys.modules,
    "analysis": "hushh_mcp.operons.kai.analysis" in sys.modules,
}))
"""
    )

    assert result == {"llm": False, "storage": False, "analysis": False}


def test_historical_calculator_export_is_lazy_and_compatible() -> None:
    result = _run_probe(
        """
import json
import sys
from hushh_mcp.operons.kai import calculate_financial_ratios

print(json.dumps({
    "callable": callable(calculate_financial_ratios),
    "calculators": "hushh_mcp.operons.kai.calculators" in sys.modules,
    "llm": "hushh_mcp.operons.kai.llm" in sys.modules,
    "storage": "hushh_mcp.operons.kai.storage" in sys.modules,
}))
"""
    )

    assert result == {
        "callable": True,
        "calculators": True,
        "llm": False,
        "storage": False,
    }
