"""
Tests for utils/compliance.py — GDPR/CCPA compliance engine.

Privacy Governance Engine by Abdul Gaffar — verifies that:
  1. Data export aggregates all consent events for a user (GDPR Art. 20)
  2. Forget-Me hard-deletes PII and calls record_deletion (GDPR Art. 17)
  3. User ID is replaced with SHA-256 hash — original UID never exposed
  4. After forget-me, re-querying with empty DB returns zero events
  5. Engine identity label is present in all reports
"""

from __future__ import annotations

import hashlib
import time
from unittest.mock import AsyncMock

from utils.compliance import (
    ComplianceEngine,
    ConsentEventRecord,
    ForgetMeReport,
    compliance_engine,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_UID = "firebase_user_gdpr_test"
_NOW_MS = int(time.time() * 1000)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _event(
    consent_id: str,
    brand_id: str,
    action: str = "GRANT",
    updated_at: int = _NOW_MS,
) -> ConsentEventRecord:
    return ConsentEventRecord(
        consent_id=consent_id,
        brand_id=brand_id,
        action=action,
        updated_at=updated_at,
    )


# ---------------------------------------------------------------------------
# Data Export — GDPR Art. 20 (Data Portability)
# ---------------------------------------------------------------------------


class TestDataExport:
    async def test_export_returns_all_events(self):
        events = [_event("c1", "brand_a"), _event("c2", "brand_b", action="REVOKE")]
        processor = ComplianceEngine()
        export = await processor.export_user_data(
            _UID, fetch_events=AsyncMock(return_value=events)
        )
        assert export.event_count == 2
        assert len(export.events) == 2

    async def test_export_empty_user(self):
        processor = ComplianceEngine()
        export = await processor.export_user_data(
            _UID, fetch_events=AsyncMock(return_value=[])
        )
        assert export.event_count == 0
        assert export.events == []

    async def test_export_event_count_matches_events(self):
        events = [_event(f"c{i}", f"brand_{i}") for i in range(5)]
        export = await compliance_engine.export_user_data(
            _UID, fetch_events=AsyncMock(return_value=events)
        )
        assert export.event_count == len(export.events) == 5

    async def test_export_carries_user_id(self):
        export = await compliance_engine.export_user_data(
            _UID, fetch_events=AsyncMock(return_value=[])
        )
        assert export.user_id == _UID

    async def test_export_carries_engine_label(self):
        export = await compliance_engine.export_user_data(
            _UID, fetch_events=AsyncMock(return_value=[])
        )
        assert "Abdul Gaffar" in export.engine
        assert "Privacy Governance Engine" in export.engine

    async def test_export_to_dict_shape(self):
        events = [_event("c1", "brand_x")]
        export = await compliance_engine.export_user_data(
            _UID, fetch_events=AsyncMock(return_value=events)
        )
        d = export.to_dict()
        assert d["user_id"] == _UID
        assert d["event_count"] == 1
        assert len(d["events"]) == 1
        assert d["events"][0]["consent_id"] == "c1"
        assert d["events"][0]["brand_id"] == "brand_x"
        assert "engine" in d

    async def test_export_event_fields_preserved(self):
        event = _event("c_specific", "brand_specific", action="REVOKE", updated_at=99999)
        export = await compliance_engine.export_user_data(
            _UID, fetch_events=AsyncMock(return_value=[event])
        )
        result = export.events[0]
        assert result.consent_id == "c_specific"
        assert result.brand_id == "brand_specific"
        assert result.action == "REVOKE"
        assert result.updated_at == 99999

    async def test_export_different_users_isolated(self):
        uid_a, uid_b = "user_alpha", "user_beta"
        events_a = [_event("c_a", "brand_a")]
        events_b = [_event("c_b", "brand_b"), _event("c_c", "brand_b")]
        export_a = await compliance_engine.export_user_data(
            uid_a, fetch_events=AsyncMock(return_value=events_a)
        )
        export_b = await compliance_engine.export_user_data(
            uid_b, fetch_events=AsyncMock(return_value=events_b)
        )
        assert export_a.user_id == uid_a
        assert export_b.user_id == uid_b
        assert export_a.event_count == 1
        assert export_b.event_count == 2


# ---------------------------------------------------------------------------
# Forget-Me — GDPR Art. 17 (Right to Erasure)
# ---------------------------------------------------------------------------


class TestForgetMe:
    async def test_forget_me_calls_delete_pii_with_uid(self):
        delete_mock = AsyncMock()
        await compliance_engine.forget_user(
            _UID,
            fetch_events=AsyncMock(return_value=[_event("c1", "b1")]),
            delete_pii=delete_mock,
            record_deletion=AsyncMock(),
        )
        delete_mock.assert_called_once_with(_UID)

    async def test_forget_me_anonymizes_user_id(self):
        report = await compliance_engine.forget_user(
            _UID,
            fetch_events=AsyncMock(return_value=[]),
            delete_pii=AsyncMock(),
            record_deletion=AsyncMock(),
        )
        expected_hash = hashlib.sha256(_UID.encode()).hexdigest()
        assert report.user_id_hash == expected_hash

    async def test_forget_me_does_not_expose_original_uid(self):
        report = await compliance_engine.forget_user(
            _UID,
            fetch_events=AsyncMock(return_value=[]),
            delete_pii=AsyncMock(),
            record_deletion=AsyncMock(),
        )
        assert _UID not in report.user_id_hash

    async def test_forget_me_deleted_count_matches_fetched_events(self):
        events = [_event(f"c{i}", f"b{i}") for i in range(3)]
        report = await compliance_engine.forget_user(
            _UID,
            fetch_events=AsyncMock(return_value=events),
            delete_pii=AsyncMock(),
            record_deletion=AsyncMock(),
        )
        assert report.deleted_event_count == 3

    async def test_forget_me_zero_events(self):
        report = await compliance_engine.forget_user(
            _UID,
            fetch_events=AsyncMock(return_value=[]),
            delete_pii=AsyncMock(),
            record_deletion=AsyncMock(),
        )
        assert report.deleted_event_count == 0

    async def test_forget_me_calls_record_deletion_with_report(self):
        record_mock = AsyncMock()
        report = await compliance_engine.forget_user(
            _UID,
            fetch_events=AsyncMock(return_value=[]),
            delete_pii=AsyncMock(),
            record_deletion=record_mock,
        )
        record_mock.assert_called_once_with(report)

    async def test_forget_me_report_carries_engine_label(self):
        report = await compliance_engine.forget_user(
            _UID,
            fetch_events=AsyncMock(return_value=[]),
            delete_pii=AsyncMock(),
            record_deletion=AsyncMock(),
        )
        assert "Abdul Gaffar" in report.engine
        assert "Privacy Governance Engine" in report.engine

    async def test_forget_me_summary_contains_deleted_count(self):
        events = [_event("c1", "b1"), _event("c2", "b2")]
        report = await compliance_engine.forget_user(
            _UID,
            fetch_events=AsyncMock(return_value=events),
            delete_pii=AsyncMock(),
            record_deletion=AsyncMock(),
        )
        assert "deleted=2" in report.summary()
        assert "user_hash=" in report.summary()

    async def test_forget_me_user_id_hash_is_deterministic(self):
        r1 = await compliance_engine.forget_user(
            _UID,
            fetch_events=AsyncMock(return_value=[]),
            delete_pii=AsyncMock(),
            record_deletion=AsyncMock(),
        )
        r2 = await compliance_engine.forget_user(
            _UID,
            fetch_events=AsyncMock(return_value=[]),
            delete_pii=AsyncMock(),
            record_deletion=AsyncMock(),
        )
        assert r1.user_id_hash == r2.user_id_hash

    async def test_after_forget_me_export_returns_empty(self):
        """After deletion the DB returns no events — export reflects that."""
        await compliance_engine.forget_user(
            _UID,
            fetch_events=AsyncMock(return_value=[_event("c1", "b1")]),
            delete_pii=AsyncMock(),
            record_deletion=AsyncMock(),
        )
        export = await compliance_engine.export_user_data(
            _UID, fetch_events=AsyncMock(return_value=[])
        )
        assert export.event_count == 0
        assert export.events == []

    async def test_forget_me_report_is_forget_me_report_instance(self):
        report = await compliance_engine.forget_user(
            _UID,
            fetch_events=AsyncMock(return_value=[]),
            delete_pii=AsyncMock(),
            record_deletion=AsyncMock(),
        )
        assert isinstance(report, ForgetMeReport)


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------


class TestComplianceEngineSingleton:
    def test_compliance_engine_singleton_identity(self):
        from utils.compliance import compliance_engine as e2

        assert compliance_engine is e2


# ---------------------------------------------------------------------------
# Canonical attach-point proof — redactor wired into /compliance/export
# ---------------------------------------------------------------------------


class TestExportRedactionAttachPoint:
    """
    Canonical surface  : api/routes/compliance.py → POST /compliance/export
    Canonical caller   : export_user_data() calls redaction_engine.apply()
                         from hushh_mcp.consent.redactor immediately after
                         compliance_engine.export_user_data() returns the
                         raw UserConsentExport dict.
    Attach-point proof : The export response masks user_id and consent_id
                         fields through the Privacy Guardrail Engine before
                         any data leaves the consent data boundary.
    """

    async def test_export_route_masks_user_id_via_redactor(self):
        """
        /compliance/export passes the export dict through redaction_engine.apply()
        — user_id in the response is masked, not the raw Firebase UID.
        """
        from unittest.mock import AsyncMock, patch

        from api.routes.compliance import export_user_data
        from utils.compliance import ConsentEventRecord

        uid = "firebase-uid-redaction-proof"
        events = [ConsentEventRecord(consent_id="cid-001", brand_id="brand-x", action="GRANT", updated_at=_NOW_MS)]

        # Patch require_firebase_auth to inject the test UID directly
        # and _fetch_events_stub to return controlled events.
        with (
            patch(
                "api.routes.compliance._fetch_events_stub",
                AsyncMock(return_value=events),
            ),
        ):
            response = await export_user_data(firebase_uid=uid)

        # The raw UID must NOT appear verbatim in the response — the
        # redactor masks it to show only the first two chars followed by ***.
        assert response["user_id"] != uid, (
            "export_user_data() must return a redacted user_id, not the raw Firebase UID"
        )
        assert "***" in response["user_id"], (
            "Redacted user_id must contain *** (MASK action from _REDACTION_TABLE)"
        )

    async def test_export_route_top_level_user_id_is_always_masked(self):
        """
        The top-level user_id is the primary quasi-identifier.  The redactor
        applies MASK to it regardless of whether any events are present.
        """
        from unittest.mock import AsyncMock, patch

        from api.routes.compliance import export_user_data

        uid = "firebase-uid-no-events-mask"

        with (
            patch(
                "api.routes.compliance._fetch_events_stub",
                AsyncMock(return_value=[]),
            ),
        ):
            response = await export_user_data(firebase_uid=uid)

        assert response["user_id"] != uid, (
            "user_id must be masked even when the events list is empty"
        )
        assert "***" in response["user_id"], (
            "Masked user_id must contain *** regardless of event count"
        )

    async def test_redactor_imported_and_reachable_from_compliance_route(self):
        """
        Structural proof: the compliance route module imports redaction_engine
        from hushh_mcp.consent.redactor (the canonical consent boundary).
        """
        import api.routes.compliance as compliance_module

        assert hasattr(compliance_module, "redaction_engine"), (
            "api/routes/compliance.py must import redaction_engine from "
            "hushh_mcp.consent.redactor to prove the canonical attach point"
        )
        assert hasattr(compliance_module, "ClearanceLevel"), (
            "api/routes/compliance.py must import ClearanceLevel alongside redaction_engine"
        )
