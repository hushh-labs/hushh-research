from __future__ import annotations

import pytest

from hushh_mcp.services.pkm_upgrade_service import PkmUpgradeService


class _FakePkmService:
    def __init__(self, *, domain_summaries: dict | None = None, manifest: dict | None = None):
        self._domain_summaries = domain_summaries or {}
        self._manifest = manifest
        self.supabase = self

    async def get_index_v2(self, user_id: str):
        class _Index:
            available_domains = ["financial"]
            model_version = 2
            last_upgraded_at = None
            domain_summaries = self._domain_summaries

        return _Index()

    async def get_domain_manifest(self, user_id: str, domain: str):
        return self._manifest

    def table(self, *_args, **_kwargs):
        return self

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, *_args, **_kwargs):
        return self

    def execute(self):
        class _Result:
            data = []

        return _Result()


@pytest.mark.asyncio
async def test_build_status_treats_missing_manifest_as_bootstrap_from_version_zero():
    service = PkmUpgradeService()
    service._pkm_service = _FakePkmService()

    async def _no_runs(_user_id: str):
        return None

    service._get_latest_run = _no_runs  # type: ignore[method-assign]

    status = await service.build_status("user_123")

    assert status["upgrade_status"] == "ready"
    assert status["upgradable_domains"][0]["domain"] == "financial"
    assert status["upgradable_domains"][0]["current_domain_contract_version"] == 0
    assert status["upgradable_domains"][0]["current_readable_summary_version"] == 0
    assert status["upgradable_domains"][0]["target_domain_contract_version"] == 2


@pytest.mark.asyncio
async def test_build_status_prefers_known_summary_versions_when_present():
    service = PkmUpgradeService()
    service._pkm_service = _FakePkmService(
        domain_summaries={
            "financial": {
                "domain_contract_version": 2,
                "readable_summary_version": 1,
            }
        }
    )

    async def _no_runs(_user_id: str):
        return None

    service._get_latest_run = _no_runs  # type: ignore[method-assign]

    status = await service.build_status("user_123")

    assert status["upgrade_status"] == "current"
    assert status["upgradable_domains"] == []
