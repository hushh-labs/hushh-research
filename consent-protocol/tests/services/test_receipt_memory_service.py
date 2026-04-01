from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from db.db_client import DatabaseExecutionError
from hushh_mcp.services.receipt_memory_service import (
    ReceiptMemoryArtifactService,
    ReceiptMemoryPkmMapper,
    ReceiptMemoryPreviewService,
    ReceiptMemoryProjectionService,
    _sha256_json,
)


class _ProjectionDb:
    def __init__(self, rows):
        self.rows = rows

    def execute_raw(self, _sql, _params=None):
        return SimpleNamespace(data=list(self.rows))


def _receipt_row(
    *,
    receipt_id: int,
    merchant_name: str,
    receipt_date: datetime,
    updated_at: datetime | None = None,
    amount: float | None = None,
    currency: str = "USD",
    from_email: str = "receipts@example.com",
):
    return {
        "id": receipt_id,
        "gmail_message_id": f"msg-{receipt_id}",
        "from_name": merchant_name,
        "from_email": from_email,
        "merchant_name": merchant_name,
        "currency": currency,
        "amount": amount,
        "receipt_date": receipt_date,
        "gmail_internal_date": receipt_date,
        "classification_confidence": 0.92,
        "created_at": receipt_date,
        "updated_at": updated_at or receipt_date,
    }


@pytest.mark.asyncio
async def test_projection_service_builds_compact_projection_with_patterns_and_fact_links():
    now = datetime.now(UTC)
    rows = [
        _receipt_row(
            receipt_id=1,
            merchant_name="Amazon Marketplace",
            receipt_date=now - timedelta(days=20),
            amount=120.0,
            from_email="auto-confirm@amazon.com",
        ),
        _receipt_row(
            receipt_id=2,
            merchant_name="Amazon",
            receipt_date=now - timedelta(days=50),
            amount=84.0,
            from_email="ship@amazon.com",
        ),
        _receipt_row(
            receipt_id=3,
            merchant_name="Amazon.com",
            receipt_date=now - timedelta(days=80),
            amount=64.0,
            from_email="orders@amazon.com",
        ),
        _receipt_row(
            receipt_id=4,
            merchant_name="Apple Services",
            receipt_date=now - timedelta(days=25),
            amount=9.99,
            from_email="no_reply@apple.com",
        ),
        _receipt_row(
            receipt_id=5,
            merchant_name="Apple.com",
            receipt_date=now - timedelta(days=55),
            amount=9.99,
            from_email="billing@apple.com",
        ),
        _receipt_row(
            receipt_id=6,
            merchant_name="Apple",
            receipt_date=now - timedelta(days=85),
            amount=9.99,
            from_email="itunes@apple.com",
        ),
    ]
    service = ReceiptMemoryProjectionService()
    service._db = _ProjectionDb(rows)

    projection = await service.build_projection(user_id="user-123")

    assert projection["source"]["inference_window_days"] == 365
    assert projection["source"]["highlights_window_days"] == 90
    assert projection["budget_stats"]["eligible_receipt_count"] == 6
    assert projection["observed_facts"]["merchant_affinity"][0]["merchant_label"] == "Amazon"
    assert any(
        item["merchant_label"] == "Apple" and item["cadence"] == "monthly"
        for item in projection["observed_facts"]["purchase_patterns"]
    )
    assert all(
        supporting_id.startswith(("merchant:", "pattern:", "highlight:"))
        for signal in projection["inferred_preferences"]
        for supporting_id in signal["supporting_fact_ids"]
    )


def test_pkm_mapper_uses_deterministic_summary_when_enrichment_missing():
    mapper = ReceiptMemoryPkmMapper()
    projection = {
        "source": {
            "projection_hash": "projection-hash",
            "inference_window_days": 365,
            "highlights_window_days": 90,
            "source_watermark": {
                "latest_receipt_updated_at": "2026-04-01T00:00:00Z",
            },
        },
        "budget_stats": {
            "eligible_receipt_count": 3,
        },
        "observed_facts": {
            "merchant_affinity": [
                {
                    "merchant_id": "amazon",
                    "merchant_label": "Amazon",
                    "affinity_score": 0.9,
                    "receipt_count_365d": 3,
                    "last_purchase_at": "2026-03-28T00:00:00Z",
                    "primary_currency": "USD",
                }
            ],
            "purchase_patterns": [],
            "recent_highlights": [],
        },
        "inferred_preferences": [],
    }

    candidate = mapper.build_candidate_payload(
        projection=projection,
        enrichment=None,
        artifact_id="artifact-1",
    )

    assert candidate["receipts_memory"]["readable_summary"]["text"]
    assert candidate["receipts_memory"]["provenance"]["artifact_id"] == "artifact-1"
    assert candidate["receipts_memory"]["observed_facts"]["merchant_affinity"][0] == {
        "merchant_id": "amazon",
        "merchant_label": "Amazon",
        "affinity_score": 0.9,
        "receipt_count_365d": 3,
        "last_purchase_at": "2026-03-28T00:00:00Z",
        "top_currency": "USD",
    }


@pytest.mark.asyncio
async def test_preview_service_reuses_cached_artifact_when_watermark_unchanged():
    projection = {
        "source": {
            "source_watermark_hash": "watermark-1",
            "inference_window_days": 365,
            "highlights_window_days": 90,
        }
    }
    cached = {"artifact_id": "artifact-cached", "candidate_pkm_payload_hash": "hash"}

    class _ProjectionStub:
        async def build_projection(self, **_kwargs):
            return projection

    class _ArtifactStub:
        def get_cached_artifact(self, **_kwargs):
            return cached

    service = ReceiptMemoryPreviewService()
    service.projection_service = _ProjectionStub()
    service.artifact_service = _ArtifactStub()

    result = await service.build_preview(user_id="user-123")

    assert result is cached


@pytest.mark.asyncio
async def test_preview_service_uses_deterministic_fallback_when_enrichment_fails():
    projection = {
        "source": {
            "projection_hash": "projection-hash",
            "source_watermark": {"eligible_receipt_count": 2},
            "source_watermark_hash": "watermark-2",
            "inference_window_days": 365,
            "highlights_window_days": 90,
        },
        "budget_stats": {
            "eligible_receipt_count": 2,
        },
        "observed_facts": {
            "merchant_affinity": [
                {
                    "merchant_id": "amazon",
                    "merchant_label": "Amazon",
                    "affinity_score": 0.8,
                    "receipt_count_365d": 2,
                    "last_purchase_at": "2026-03-28T00:00:00Z",
                    "primary_currency": "USD",
                }
            ],
            "purchase_patterns": [],
            "recent_highlights": [],
        },
        "inferred_preferences": [],
    }

    class _ProjectionStub:
        async def build_projection(self, **_kwargs):
            return projection

    class _ArtifactStub:
        def __init__(self):
            self.created = None
            self.db = SimpleNamespace(execute_raw=lambda *_args, **_kwargs: None)

        def get_cached_artifact(self, **_kwargs):
            return None

        def create_artifact(self, **kwargs):
            self.created = kwargs
            payload = kwargs["candidate_pkm_payload"]
            return {
                "artifact_id": "artifact-fallback",
                "candidate_pkm_payload_hash": _sha256_json(payload),
                "candidate_pkm_payload": payload,
                "deterministic_projection_hash": kwargs["deterministic_projection"]["source"][
                    "projection_hash"
                ],
                "enrichment": kwargs["enrichment"],
                "freshness": {"is_stale": False, "status": "fresh", "reason": "watermark_current"},
            }

        def get_artifact(self, **_kwargs):
            return None

    class _EnrichmentStub:
        def enrichment_cache_key(self):
            return "deterministic-only"

        async def enrich(self, _projection):
            raise RuntimeError("llm timeout")

    class _MapperStub:
        def build_candidate_payload(self, *, projection, enrichment, artifact_id):
            return {
                "receipts_memory": {
                    "schema_version": 1,
                    "readable_summary": {
                        "text": f"Deterministic summary for {projection['source']['projection_hash']}",
                        "highlights": [],
                        "updated_at": "2026-04-01T00:00:00Z",
                        "source_label": "Gmail receipts",
                    },
                    "observed_facts": {
                        "merchant_affinity": [],
                        "purchase_patterns": [],
                        "recent_highlights": [],
                    },
                    "inferred_preferences": {"preference_signals": []},
                    "provenance": {"artifact_id": "stable-artifact"},
                }
            }

    service = ReceiptMemoryPreviewService()
    service.projection_service = _ProjectionStub()
    service.artifact_service = _ArtifactStub()
    service.enrichment_service = _EnrichmentStub()
    service.pkm_mapper = _MapperStub()

    artifact = await service.build_preview(user_id="user-123")

    assert artifact["enrichment"] is None
    assert artifact["candidate_pkm_payload"]["receipts_memory"]["readable_summary"][
        "text"
    ].startswith("Deterministic summary")


@pytest.mark.asyncio
async def test_preview_service_falls_back_to_ephemeral_artifact_when_cache_table_missing():
    projection = {
        "source": {
            "projection_hash": "projection-hash",
            "source_watermark": {"eligible_receipt_count": 2},
            "source_watermark_hash": "watermark-3",
            "inference_window_days": 365,
            "highlights_window_days": 90,
        },
        "budget_stats": {
            "eligible_receipt_count": 2,
        },
        "observed_facts": {
            "merchant_affinity": [
                {
                    "merchant_id": "amazon",
                    "merchant_label": "Amazon",
                    "affinity_score": 0.8,
                    "receipt_count_365d": 2,
                    "last_purchase_at": "2026-03-28T00:00:00Z",
                    "primary_currency": "USD",
                }
            ],
            "purchase_patterns": [],
            "recent_highlights": [],
        },
        "inferred_preferences": [],
    }

    class _ProjectionStub:
        async def build_projection(self, **_kwargs):
            return projection

    class _ArtifactDb:
        def execute_raw(self, *_args, **_kwargs):
            raise DatabaseExecutionError(
                table_name="<raw_sql>",
                operation="execute_raw",
                details='(psycopg2.errors.UndefinedTable) relation "kai_receipt_memory_artifacts" does not exist',
            )

    class _EnrichmentStub:
        def enrichment_cache_key(self):
            return "deterministic-only"

        async def enrich(self, _projection):
            return None

    service = ReceiptMemoryPreviewService()
    service.projection_service = _ProjectionStub()
    service.artifact_service = ReceiptMemoryArtifactService()
    service.artifact_service._db = _ArtifactDb()
    service.enrichment_service = _EnrichmentStub()
    service.pkm_mapper = ReceiptMemoryPkmMapper()

    artifact = await service.build_preview(user_id="user-123")

    assert artifact["artifact_id"].startswith("receipt_memory_")
    assert artifact["cache_persisted"] is False
    assert (
        artifact["candidate_pkm_payload"]["receipts_memory"]["provenance"]["artifact_id"]
        == artifact["artifact_id"]
    )
