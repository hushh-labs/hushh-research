from __future__ import annotations

from datetime import UTC, datetime

import pytest

from hushh_mcp.services.pkm_upgrade_service import PkmUpgradeService


class _FakePkmService:
    def __init__(
        self,
        *,
        domain_summaries: dict | None = None,
        manifest: dict | None = None,
        model_version: int = 2,
        last_upgraded_at: datetime | None = None,
    ):
        self._domain_summaries = domain_summaries or {}
        self._manifest = manifest
        self._index = type(
            "_Index",
            (),
            {
                "available_domains": ["financial"],
                "model_version": model_version,
                "last_upgraded_at": last_upgraded_at,
                "domain_summaries": self._domain_summaries,
            },
        )()
        self.upserted_indexes: list[object] = []
        self.supabase = self

    async def get_index_v2(self, user_id: str):
        return self._index

    async def get_domain_manifest(self, user_id: str, domain: str):
        return self._manifest

    async def upsert_index_v2(self, index):
        self._index = index
        self.upserted_indexes.append(index)
        return True

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


@pytest.mark.asyncio
async def test_build_status_prefers_manifest_versions_over_stale_summary_versions():
    service = PkmUpgradeService()
    service._pkm_service = _FakePkmService(
        domain_summaries={
            "financial": {
                "domain_contract_version": 1,
                "readable_summary_version": 0,
                "upgraded_at": "2026-03-20T00:00:00Z",
            }
        },
        manifest={
            "domain_contract_version": 2,
            "readable_summary_version": 1,
            "upgraded_at": "2026-03-29T12:00:00Z",
        },
    )

    async def _no_runs(_user_id: str):
        return None

    service._get_latest_run = _no_runs  # type: ignore[method-assign]

    status = await service.build_status("user_123")

    assert status["upgrade_status"] == "current"
    assert status["upgradable_domains"] == []
    assert status["stored_model_version"] == 2
    assert status["effective_model_version"] == 4
    assert status["model_version"] == 4


@pytest.mark.asyncio
async def test_start_or_resume_run_silently_reconciles_stale_top_level_index():
    last_manifest_upgrade = "2026-03-29T12:00:00Z"
    fake_pkm_service = _FakePkmService(
        domain_summaries={
            "financial": {
                "domain_contract_version": 1,
                "readable_summary_version": 0,
            }
        },
        manifest={
            "domain_contract_version": 2,
            "readable_summary_version": 1,
            "upgraded_at": last_manifest_upgrade,
        },
        model_version=2,
        last_upgraded_at=None,
    )
    service = PkmUpgradeService()
    service._pkm_service = fake_pkm_service

    async def _no_runs(_user_id: str):
        return None

    service._get_latest_run = _no_runs  # type: ignore[method-assign]

    status = await service.start_or_resume_run("user_123", initiated_by="unlock_warm", mode="real")

    assert status["upgrade_status"] == "current"
    assert status["upgradable_domains"] == []
    assert status["stored_model_version"] == 4
    assert status["effective_model_version"] == 4
    assert status["model_version"] == 4
    assert len(fake_pkm_service.upserted_indexes) == 1
    repaired_index = fake_pkm_service.upserted_indexes[0]
    assert repaired_index.model_version == 4
    assert repaired_index.last_upgraded_at == datetime(2026, 3, 29, 12, 0, tzinfo=UTC)
