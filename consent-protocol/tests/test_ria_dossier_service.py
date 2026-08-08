"""RIA dossier orchestrator: dispatch idempotency, payload redaction, worker states.

The dossier is best-effort by contract — these tests prove the claim can never
be failed by it, that exactly one worker wins the ``(profile, CRD)`` row, and
that nothing beyond SEC-published facts plus the sign-in email ever reaches the
scan API.
"""

from __future__ import annotations

import asyncio
import json
import sys
import types
from typing import Any

import asyncpg
import httpx

import hushh_mcp.services.ria_dossier_service as dossier_module
from hushh_mcp.services.ria_claim_service import RIAClaimService
from hushh_mcp.services.ria_dossier_service import RIADossierService

_TEST_UID = "user_dossier_123"
_PROFILE_ID = "11111111-2222-3333-4444-555555555555"


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class _FakeDossierDb:
    """In-memory stand-in for the ria_claim_dossiers + ria_profiles tables."""

    def __init__(self, *, display_name: str | None = "Reginald Troy Maxfield") -> None:
        self.claimed: dict[tuple[str, str], int] = {}
        self.rows: dict[int, dict[str, Any]] = {}
        self.insert_attempts = 0
        self.next_id = 1
        self.display_name = display_name


class _FakeConn:
    def __init__(self, db: _FakeDossierDb) -> None:
        self._db = db

    async def fetchrow(self, query: str, *args: Any):
        normalized = " ".join(query.split())
        if normalized.startswith("INSERT INTO ria_claim_dossiers"):
            self._db.insert_attempts += 1
            key = (str(args[0]), str(args[1]))
            if key in self._db.claimed:
                return None
            row_id = self._db.next_id
            self._db.next_id += 1
            self._db.claimed[key] = row_id
            self._db.rows[row_id] = {"status": "queued", "user_id": args[2]}
            return {"id": row_id}
        if normalized.startswith("SELECT display_name FROM ria_profiles"):
            if self._db.display_name is None:
                return None
            return {"display_name": self._db.display_name}
        raise AssertionError(f"unexpected fetchrow: {normalized}")

    async def execute(self, query: str, *args: Any) -> str:
        normalized = " ".join(query.split())
        assert normalized.startswith("UPDATE ria_claim_dossiers SET"), normalized
        row = self._db.rows.setdefault(int(args[0]), {})
        set_clause = normalized[len("UPDATE ria_claim_dossiers SET ") : normalized.index(" WHERE")]
        for assignment in set_clause.split(", "):
            column, _, rhs = assignment.partition(" = ")
            if rhs == "NOW()":
                row[column] = "now"
            else:
                row[column] = args[int(rhs.lstrip("$")) - 1]
        return "UPDATE 1"


class _FakeAcquire:
    def __init__(self, conn: Any) -> None:
        self._conn = conn

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _FakePool:
    def __init__(self, conn: Any) -> None:
        self._conn = conn

    def acquire(self):
        return _FakeAcquire(self._conn)


class _FakeIdentityService:
    def __init__(self, *, email: str | None) -> None:
        self.email = email
        self.firebase_calls = 0

    async def get_many(self, user_ids):
        return {user_id: ({"email": self.email} if self.email else {}) for user_id in user_ids}

    async def ensure_many(self, user_ids):
        return await self.get_many(user_ids)

    async def sync_from_firebase(self, user_id, *, force: bool = False):
        self.firebase_calls += 1
        return {"email": self.email} if self.email else None


def _reference_metadata(**overrides: Any) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "provider": "ria_identity_claim",
        "claim_type": "individual",
        "phone": "8015663510",
        "firm_crd": 283040,
        "individual_crd": 5308823,
        "verification_level": "verified",
        "satisfied": ["phone_otp", "sole_adviser", "roster_selection"],
        "missing": [],
        "evidence_ledger": [{"signal": "phone_otp", "accepted": True, "source": "asserted"}],
        "scope_note": None,
        "firm_record": {
            "crd": 283040,
            "name": "OLYMPUS PEAKS FINANCIAL, LLC",
            "website": "HTTPS://WWW.OLYMPUSPEAKS.COM",
            "report_url": "https://adviserinfo.sec.gov/firm/summary/283040",
            "street1": "9980 S 300 W STE 200",
            "zip": "84070",
        },
        "advisor_record": {
            "crd": 5308823,
            "report_url": "https://adviserinfo.sec.gov/individual/summary/5308823",
            "branch": {
                "city": "SANDY",
                "state": "UT",
                "street1": "9980 SOUTH 300 WEST",
                "zip": "84094",
                "private_residence": False,
            },
        },
    }
    metadata.update(overrides)
    return metadata


def _make_service(
    monkeypatch,
    *,
    db: _FakeDossierDb | None = None,
    email: str | None = "reg@gmail.com",
    handler=None,
) -> tuple[RIADossierService, _FakeDossierDb, _FakeIdentityService]:
    resolved_db = db or _FakeDossierDb()

    async def _fake_get_pool():
        return _FakePool(_FakeConn(resolved_db))

    monkeypatch.setattr(dossier_module, "get_pool", _fake_get_pool)
    identity = _FakeIdentityService(email=email)
    service = RIADossierService(
        identity_service=identity,
        transport=httpx.MockTransport(handler) if handler else None,
    )
    service._poll_interval_seconds = 0.0
    return service, resolved_db, identity


def _install_mail_stub(
    monkeypatch, *, outcome: dict[str, Any] | None = None
) -> list[dict[str, Any]]:
    """Stand in for the mail lane's queue_dossier_email (built by lane B3)."""
    module = types.ModuleType("hushh_mcp.services.ria_dossier_email_service")
    calls: list[dict[str, Any]] = []

    async def queue_dossier_email(**kwargs: Any) -> dict[str, Any]:
        calls.append(kwargs)
        resolved = outcome if outcome is not None else {"delivery_status": "queued"}
        if resolved.get("delivery_status") == "queued" and kwargs.get("on_success") is not None:
            await kwargs["on_success"](
                {
                    "message_id": "gmail-msg-1",
                    "recipient": "ops@hushh.ai",
                    "intended_recipient": kwargs["to_email"],
                    "delivery_mode": "test",
                }
            )
        return resolved

    module.queue_dossier_email = queue_dossier_email  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "hushh_mcp.services.ria_dossier_email_service", module)
    return calls


def _set_scan_env(monkeypatch) -> None:
    monkeypatch.setenv("INTELLIGENCE_API_BASE_URL", "https://intelligence.test")
    monkeypatch.setenv("INTELLIGENCE_API_KEY", "test-intelligence-key")


async def _dispatch(service: RIADossierService, **overrides: Any) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "user_id": _TEST_UID,
        "ria_profile_id": _PROFILE_ID,
        "claim_type": "individual",
        "reference_metadata": _reference_metadata(),
    }
    kwargs.update(overrides)
    return await service.dispatch_after_claim(**kwargs)


async def _drain_workers() -> None:
    tasks = list(dossier_module._BACKGROUND_TASKS)
    if tasks:
        await asyncio.gather(*tasks)


# ---------------------------------------------------------------------------
# Dispatch: idempotency + gates
# ---------------------------------------------------------------------------


async def test_dispatch_race_one_winner_one_worker(monkeypatch):
    _install_mail_stub(monkeypatch)
    worker_calls: list[dict[str, Any]] = []

    async def _recording_worker(self, **kwargs):
        worker_calls.append(kwargs)

    monkeypatch.setattr(RIADossierService, "_run_worker", _recording_worker)
    service, db, _identity = _make_service(monkeypatch)
    first, second = await asyncio.gather(_dispatch(service), _dispatch(service))
    statuses = sorted([first["status"], second["status"]])
    assert statuses == ["queued", "skipped"]
    assert len(db.claimed) == 1
    await _drain_workers()
    assert len(worker_calls) == 1
    assert worker_calls[0]["dossier_id"] == 1
    assert worker_calls[0]["user_id"] == _TEST_UID


async def test_dispatch_skips_unverified_claim(monkeypatch):
    service, db, _identity = _make_service(monkeypatch)
    result = await _dispatch(
        service, reference_metadata=_reference_metadata(verification_level="provisional")
    )
    assert result == {"status": "skipped", "reason": "not_verified"}
    assert db.insert_attempts == 0


async def test_dispatch_tolerates_missing_table(monkeypatch):
    class _MissingTableConn:
        async def fetchrow(self, query: str, *args: Any):
            raise asyncpg.UndefinedTableError("relation ria_claim_dossiers does not exist")

    async def _fake_get_pool():
        return _FakePool(_MissingTableConn())

    monkeypatch.setattr(dossier_module, "get_pool", _fake_get_pool)
    service = RIADossierService(identity_service=_FakeIdentityService(email=None))
    result = await _dispatch(service)
    assert result == {"status": "skipped", "reason": "table_missing"}


async def test_reclaim_and_email_upgrade_never_dispatch_twice(monkeypatch):
    _install_mail_stub(monkeypatch)
    _set_scan_env(monkeypatch)
    service, db, _identity = _make_service(monkeypatch, handler=_happy_scan_handler([]))
    assert (await _dispatch(service))["status"] == "queued"
    await _drain_workers()

    # Re-claim: the unique key answers, no second worker.
    reclaim = await _dispatch(service)
    assert reclaim == {"status": "skipped", "reason": "already_dispatched"}

    # Email-upgrade path: upgrade_with_email_evidence dispatches (attempt is
    # made) and the same conflict makes it a no-op.
    claim_service = _claim_service_with_upgrade_context(monkeypatch)
    result = await claim_service.upgrade_with_email_evidence(
        _TEST_UID, email="reg@olympuspeaks.com"
    )
    assert result["verified"] is True
    assert db.insert_attempts == 3  # winner + re-claim + upgrade, all one row
    assert len(db.claimed) == 1
    assert len(dossier_module._BACKGROUND_TASKS) == 0


# ---------------------------------------------------------------------------
# Payload redaction
# ---------------------------------------------------------------------------


def test_scan_payload_forwards_only_public_facts():
    payload, error = RIADossierService._build_scan_payload(
        claim_type="individual",
        reference_metadata=_reference_metadata(claim_ticket="ria-claim-ticket.v1:1:abc"),
        email="reg@gmail.com",
        display_name="Reginald Troy Maxfield",
    )
    assert error == ""
    assert payload is not None
    body = json.dumps(payload)
    assert "8015663510" not in body  # possession phone digits never leave
    assert "evidence_ledger" not in body and "evidenceLedger" not in body
    assert "satisfied" not in body and "scope_note" not in body
    assert "claim_ticket" not in body and "ria-claim-ticket" not in body
    assert "street" not in body.lower() and "9980" not in body
    assert payload["zipCode"] == "84094"  # branch zip: not a private residence
    assert payload["confirmedProfiles"] == [
        {
            "platform": "SEC AdviserInfo",
            "handle": "5308823",
            "url": "https://adviserinfo.sec.gov/individual/summary/5308823",
            "category": "Government/Regulatory",
        },
        {
            "platform": "Firm website",
            "handle": "olympuspeaks.com",
            "url": "https://www.olympuspeaks.com",
            "category": "Professional",
        },
    ]
    assert payload["consentAttestation"] is True
    assert payload["socialPreferenceConsent"] is False


def test_scan_payload_private_residence_uses_firm_zip():
    metadata = _reference_metadata()
    metadata["advisor_record"]["branch"]["private_residence"] = True
    payload, error = RIADossierService._build_scan_payload(
        claim_type="individual",
        reference_metadata=metadata,
        email="reg@gmail.com",
        display_name="Reginald Troy Maxfield",
    )
    assert error == ""
    assert payload is not None
    assert payload["zipCode"] == "84070"
    assert "84094" not in json.dumps(payload)


def test_scan_payload_without_any_zip_is_no_location():
    metadata = _reference_metadata()
    metadata["advisor_record"]["branch"]["zip"] = None
    metadata["firm_record"]["zip"] = None
    payload, error = RIADossierService._build_scan_payload(
        claim_type="individual",
        reference_metadata=metadata,
        email="reg@gmail.com",
        display_name="Reginald Troy Maxfield",
    )
    assert payload is None
    assert error == "no_location"


def test_scan_payload_firm_claim_anchors_on_firm_record():
    metadata = _reference_metadata(claim_type="firm", individual_crd=None)
    metadata["advisor_record"] = {}
    payload, error = RIADossierService._build_scan_payload(
        claim_type="firm",
        reference_metadata=metadata,
        email="reg@gmail.com",
        display_name="Olympus Peaks Financial, LLC",
    )
    assert error == ""
    assert payload is not None
    assert payload["confirmedProfiles"][0]["handle"] == "283040"
    assert payload["confirmedProfiles"][0]["url"] == (
        "https://adviserinfo.sec.gov/firm/summary/283040"
    )
    assert payload["zipCode"] == "84070"


# ---------------------------------------------------------------------------
# Worker states
# ---------------------------------------------------------------------------


def _happy_scan_handler(http_calls: list[httpx.Request]):
    def handler(request: httpx.Request) -> httpx.Response:
        http_calls.append(request)
        assert request.headers["authorization"] == "Bearer test-intelligence-key"
        if request.method == "POST":
            assert request.url.path == "/api/v1/scan"
            content = request.content.decode()
            assert "8015663510" not in content
            assert "evidence_ledger" not in content
            return httpx.Response(202, json={"ok": True, "scanId": "scan-1", "status": "running"})
        assert request.url.path == "/api/v1/scan/scan-1"
        return httpx.Response(
            200,
            json={
                "ok": True,
                "scanId": "scan-1",
                "status": "completed",
                "result": {"report": "# Dossier\n\nBody.", "summary": "One-line summary."},
            },
        )

    return handler


async def test_worker_happy_path_persists_markdown_and_mails(monkeypatch):
    mail_calls = _install_mail_stub(monkeypatch)
    _set_scan_env(monkeypatch)
    http_calls: list[httpx.Request] = []
    service, db, _identity = _make_service(monkeypatch, handler=_happy_scan_handler(http_calls))
    result = await _dispatch(service)
    assert result["status"] == "queued"
    assert result["email_masked"] == "r•••@gmail.com"
    await _drain_workers()

    row = db.rows[1]
    assert row["scan_id"] == "scan-1"
    assert row["result_markdown"] == "# Dossier\n\nBody."
    assert row["result_summary"] == "One-line summary."
    assert row["status"] == "sent"
    assert row["mail_message_id"] == "gmail-msg-1"
    assert row["mail_recipient"] == "ops@hushh.ai"
    assert row["mail_intended_recipient"] == "reg@gmail.com"
    assert row["mail_delivery_mode"] == "test"
    assert row["completed_at"] == "now"
    assert len(mail_calls) == 1
    assert mail_calls[0]["user_id"] == _TEST_UID
    assert mail_calls[0]["to_email"] == "reg@gmail.com"
    assert mail_calls[0]["display_name"] == "Reginald Troy Maxfield"
    assert [request.method for request in http_calls] == ["POST", "GET"]


async def test_worker_blocked_without_email_makes_no_http_call(monkeypatch):
    mail_calls = _install_mail_stub(monkeypatch)
    _set_scan_env(monkeypatch)
    http_calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        http_calls.append(request)
        return httpx.Response(500)

    service, db, identity = _make_service(monkeypatch, email=None, handler=handler)
    result = await _dispatch(service)
    assert result == {"status": "queued"}  # no cached email, no masked line
    await _drain_workers()

    assert identity.firebase_calls == 1  # live Firebase fallback was tried
    assert db.rows[1]["status"] == "blocked_no_email"
    assert http_calls == []
    assert mail_calls == []


async def test_worker_scan_failed_persists_status_and_skips_mail(monkeypatch):
    mail_calls = _install_mail_stub(monkeypatch)
    _set_scan_env(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(202, json={"ok": True, "scanId": "scan-1"})
        return httpx.Response(
            200, json={"ok": False, "scanId": "scan-1", "status": "failed", "result": None}
        )

    service, db, _identity = _make_service(monkeypatch, handler=handler)
    assert (await _dispatch(service))["status"] == "queued"
    await _drain_workers()

    row = db.rows[1]
    assert row["status"] == "scan_failed"
    assert row["error"] == "scan_did_not_complete"
    assert mail_calls == []


async def test_worker_maps_blocked_mail_outcome_to_send_blocked_test_unset(monkeypatch):
    _install_mail_stub(
        monkeypatch,
        outcome={"delivery_status": "blocked", "reason": "send_blocked_test_unset"},
    )
    _set_scan_env(monkeypatch)
    http_calls: list[httpx.Request] = []
    service, db, _identity = _make_service(monkeypatch, handler=_happy_scan_handler(http_calls))
    assert (await _dispatch(service))["status"] == "queued"
    await _drain_workers()

    row = db.rows[1]
    assert row["result_markdown"] == "# Dossier\n\nBody."
    assert row["status"] == "send_blocked_test_unset"


# ---------------------------------------------------------------------------
# Claim endpoint contract: the dossier can never fail a claim
# ---------------------------------------------------------------------------


class _FakeIdentityClient:
    def __init__(self, *, evaluate_payload: dict[str, Any]) -> None:
        self.evaluate_payload = evaluate_payload
        self.advisor_payload: dict[str, Any] | None = None

    async def claim_evaluate(self, **_kwargs):
        return self.evaluate_payload

    async def advisor_record(self, individual_crd):
        raise RuntimeError("no record in this test")


class _FakeIamService:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def claim_ria_profile_from_identity(self, user_id, **kwargs):
        self.calls.append({"user_id": user_id, **kwargs})
        return {
            "ria_profile_id": _PROFILE_ID,
            "user_id": user_id,
            "display_name": kwargs["display_name"],
            "verification_status": "verified",
        }


class _FakeAliasIdentityService:
    async def list_verified_email_aliases(self, user_id):
        return [
            {
                "email": "reg@olympuspeaks.com",
                "email_normalized": "reg@olympuspeaks.com",
                "verification_status": "verified",
                "revoked_at": None,
            }
        ]


_EVALUATE_VERIFIED = {
    "ok": True,
    "claimType": "individual",
    "provisional": False,
    "profileVerified": True,
    "verificationLevel": "verified",
    "satisfied": ["phone_otp", "sole_adviser", "roster_selection"],
    "missing": [],
    "roster": [
        {
            "individualCrd": 5308823,
            "name": "REGINALD TROY MAXFIELD",
            "branchCity": "SANDY",
            "branchState": "UT",
        }
    ],
    "firm": {
        "crd": 283040,
        "name": "OLYMPUS PEAKS FINANCIAL, LLC",
        "secNumber": "801-134885",
        "website": "HTTPS://WWW.OLYMPUSPEAKS.COM",
        "registrationType": "sec",
        "address": {"city": "SANDY", "state": "UT", "zip": "84070"},
    },
    "evidenceLedger": [{"signal": "phone_otp", "accepted": True, "source": "asserted"}],
}


def _claim_service_with_upgrade_context(monkeypatch) -> RIAClaimService:
    service = RIAClaimService(
        client=_FakeIdentityClient(evaluate_payload=_EVALUATE_VERIFIED),
        iam_service=_FakeIamService(),
        identity_service=_FakeAliasIdentityService(),
    )

    async def _mock_load(self, user_id):
        return {
            "ria_profile_id": _PROFILE_ID,
            "display_name": "Reginald Troy Maxfield",
            "legal_name": "REGINALD TROY MAXFIELD",
            "crd_number": "5308823",
            "verification_status": "submitted",
            "metadata": _reference_metadata(verification_level="provisional"),
        }

    monkeypatch.setattr(RIAClaimService, "_load_claim_context", _mock_load)
    return service


async def _complete_claim(service: RIAClaimService) -> dict[str, Any]:
    return await service.complete(
        user_id=_TEST_UID,
        phone_digits="8015663510",
        claim_type="individual",
        firm_crd=283040,
        individual_crd=5308823,
    )


async def test_complete_still_claims_when_dossier_dispatch_raises(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")

    async def _boom(self, **_kwargs):
        raise RuntimeError("dossier lane is down")

    monkeypatch.setattr(RIADossierService, "dispatch_after_claim", _boom)
    service = RIAClaimService(
        client=_FakeIdentityClient(evaluate_payload=_EVALUATE_VERIFIED),
        iam_service=_FakeIamService(),
    )
    result = await _complete_claim(service)
    assert result["status"] == "claimed"
    assert "dossier" not in result


async def test_complete_response_carries_dossier_status(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    captured: dict[str, Any] = {}

    async def _queued(self, **kwargs):
        captured.update(kwargs)
        return {"status": "queued", "email_masked": "r•••@gmail.com"}

    monkeypatch.setattr(RIADossierService, "dispatch_after_claim", _queued)
    service = RIAClaimService(
        client=_FakeIdentityClient(evaluate_payload=_EVALUATE_VERIFIED),
        iam_service=_FakeIamService(),
    )
    result = await _complete_claim(service)
    assert result["status"] == "claimed"
    assert result["dossier"] == {"status": "queued", "email_masked": "r•••@gmail.com"}
    assert captured["user_id"] == _TEST_UID
    assert captured["ria_profile_id"] == _PROFILE_ID
    assert captured["claim_type"] == "individual"
    assert captured["reference_metadata"]["verification_level"] == "verified"
