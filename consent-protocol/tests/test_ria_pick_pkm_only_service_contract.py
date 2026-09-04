"""Regression coverage for the PKM-only RIA Picks service boundary."""

from __future__ import annotations

import ast
import asyncio
from pathlib import Path

from hushh_mcp.services.ria_iam_service import RIAIAMService

_SERVICE_PATH = (
    Path(__file__).resolve().parents[1] / "hushh_mcp" / "services" / "ria_iam_service.py"
)
_RETIRED_LEGACY_METHODS = {
    "upload_ria_pick_list",
    "list_ria_pick_uploads",
    "get_legacy_ria_pick_migration",
    "complete_legacy_ria_pick_migration",
}


def test_ria_picks_service_has_no_legacy_upload_or_migration_runtime() -> None:
    source = _SERVICE_PATH.read_text(encoding="utf-8")
    module = ast.parse(source)
    service_class = next(
        node
        for node in module.body
        if isinstance(node, ast.ClassDef) and node.name == "RIAIAMService"
    )
    method_names = {
        node.name
        for node in service_class.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }

    assert _RETIRED_LEGACY_METHODS.isdisjoint(method_names)
    assert "ria_pick_upload" not in source
    assert "ria_pick_legacy_migration" not in source


def test_ria_picks_parser_and_bootstrap_remain_pkm_only() -> None:
    source = _SERVICE_PATH.read_text(encoding="utf-8")

    assert "async def parse_ria_pick_csv" in source
    assert "self._parse_pick_csv(csv_content)" in source
    assert "async def get_ria_pick_bootstrap" in source
    assert "FROM pkm_blobs blob" in source
    assert "async def get_active_ria_pick_package" in source
    assert "return await self.get_ria_pick_bootstrap(user_id)" in source

    package = asyncio.run(
        RIAIAMService().parse_ria_pick_csv(
            csv_content=(
                "ticker,company_name,sector,tier,investment_thesis\n"
                "NVDA,NVIDIA Corporation,Technology,ACE,AI demand\n"
            ),
        )
    )
    assert package["top_picks"][0]["ticker"] == "NVDA"
    assert package["top_picks"][0]["tier"] == "ACE"
    assert package["top_picks"][0]["investment_thesis"] == "AI demand"
