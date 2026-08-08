"""A claimed profile's LOCATION section comes from the SEC record it claimed.

The onboarding wizard asks for city / area / address / PIN-ZIP and writes them
to ``ria_business_contacts``. Claim-by-phone never asks — so before this, every
adviser who claimed their profile read "Not provided" on all four rows even
though the filed address was already sitting in the claim snapshot
(``ria_verification_events.reference_metadata``).

Three seams are covered here:

1. ``derive_business_location`` — the pure read of the snapshot, including the
   privacy rule that a branch flagged as a private residence is never published.
2. The claim write — the ``ria_business_contacts`` upsert carries the derived
   address and only ever fills a blank.
3. ``get_ria_onboarding_status`` — a pure read-time fallback so advisers who
   claimed *before* this shipped see their address without re-claiming.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any

import asyncpg
import pytest

from hushh_mcp.services.ria_claim_service import derive_business_location
from hushh_mcp.services.ria_iam_service import RIAIAMService

_NOW = datetime(2026, 8, 8, 12, 0, 0, tzinfo=UTC)
_USER_ID = "user_claim_location_1"

_FIRM_RECORD = {
    "crd": 283040,
    "name": "OLYMPUS PEAKS FINANCIAL, LLC",
    "street1": "9539 S PROSPERITY RD",
    "street2": "SUITE 200",
    "city": "SANDY",
    "state": "UT",
    "zip": "84070",
}

_BRANCH_OFFICE = {
    "city": "PARK CITY",
    "state": "UT",
    "street1": "1441 W UTE BLVD",
    "zip": "84098",
    "private_residence": False,
}

# Somebody's home. Nothing here may ever reach a published profile.
_BRANCH_HOME = {
    "city": "HEBER CITY",
    "state": "UT",
    "street1": "742 EVERGREEN TERRACE",
    "zip": "84032",
    "private_residence": True,
}


def _metadata(*, firm: dict | None = None, branch: dict | None = None) -> dict[str, Any]:
    return {
        "provider": "ria_identity_claim",
        "claim_type": "individual",
        "firm_record": dict(firm) if firm is not None else dict(_FIRM_RECORD),
        "advisor_record": {"crd": 5308823, "branch": dict(branch) if branch else None},
    }


# ---------------------------------------------------------------------------
# derive_business_location
# ---------------------------------------------------------------------------


def test_firm_only_snapshot_uses_the_firm_address():
    result = derive_business_location(_metadata(branch=None))

    assert result == {
        "city": "SANDY",
        "area": "",
        "address": "9539 S PROSPERITY RD, SUITE 200",
        "pin_zip": "84070",
    }


def test_branch_office_is_preferred_over_the_firm_address():
    result = derive_business_location(_metadata(branch=_BRANCH_OFFICE))

    assert result["city"] == "PARK CITY"
    assert result["address"] == "1441 W UTE BLVD"
    assert result["pin_zip"] == "84098"
    # The firm HQ is not mixed in beside the branch street.
    assert "SANDY" not in result.values()
    assert result["pin_zip"] != "84070"


def test_private_residence_branch_falls_back_to_the_firm_and_leaks_nothing():
    result = derive_business_location(_metadata(branch=_BRANCH_HOME))

    assert result["city"] == "SANDY"
    assert result["address"] == "9539 S PROSPERITY RD, SUITE 200"
    assert result["pin_zip"] == "84070"
    # No fragment of the home address appears under ANY key.
    published = " | ".join(result.values())
    for secret in ("HEBER CITY", "742 EVERGREEN TERRACE", "84032"):
        assert secret not in published


def test_private_residence_with_no_firm_address_publishes_nothing():
    result = derive_business_location(_metadata(firm={}, branch=_BRANCH_HOME))

    assert result == {"city": "", "area": "", "address": "", "pin_zip": ""}


def test_street2_is_joined_onto_street1():
    single = derive_business_location(_metadata(firm={**_FIRM_RECORD, "street2": None}))
    assert single["address"] == "9539 S PROSPERITY RD"

    joined = derive_business_location(_metadata())
    assert joined["address"] == "9539 S PROSPERITY RD, SUITE 200"


def test_values_are_trimmed():
    result = derive_business_location(
        _metadata(
            firm={
                "street1": "  9539 S PROSPERITY RD  ",
                "street2": "  SUITE 200 ",
                "city": "  SANDY ",
                "zip": " 84070  ",
            }
        )
    )

    assert result == {
        "city": "SANDY",
        "area": "",
        "address": "9539 S PROSPERITY RD, SUITE 200",
        "pin_zip": "84070",
    }


@pytest.mark.parametrize(
    "metadata",
    [
        {},
        {"firm_record": None, "advisor_record": None},
        {"firm_record": {}, "advisor_record": {"branch": {}}},
        {"firm_record": "not-a-dict", "advisor_record": ["not-a-dict"]},
        None,
    ],
)
def test_missing_or_malformed_metadata_returns_empty_strings(metadata):
    result = derive_business_location(metadata)

    assert result == {"city": "", "area": "", "address": "", "pin_zip": ""}
    assert all(isinstance(value, str) for value in result.values())


def test_area_is_never_invented():
    # The SEC feed has no locality concept; the row must honestly read blank.
    assert derive_business_location(_metadata(branch=_BRANCH_OFFICE))["area"] == ""
    assert derive_business_location(_metadata())["area"] == ""


def test_branch_without_a_street_defers_to_the_firms_full_address():
    branch = {"city": "PARK CITY", "state": "UT", "street1": None, "zip": None}
    result = derive_business_location(_metadata(branch=branch))

    # A city-only branch cannot fill the street the map needs, and half a branch
    # beside half a firm address would be an address on no filing.
    assert result["address"] == "9539 S PROSPERITY RD, SUITE 200"
    assert result["city"] == "SANDY"
    assert result["pin_zip"] == "84070"


# ---------------------------------------------------------------------------
# The claim write
# ---------------------------------------------------------------------------


class _FakeTransaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False


class _FakeClaimConn:
    """Enough of asyncpg for claim_ria_profile_from_identity to run through."""

    def __init__(self, *, contacts_table_missing: bool = False):
        self.contacts_table_missing = contacts_table_missing
        self.executes: list[tuple[str, tuple[Any, ...]]] = []

    def transaction(self):
        return _FakeTransaction()

    async def fetchrow(self, query: str, *_args: Any):
        if "INSERT INTO ria_profiles" in query:
            return {
                "id": "ria-profile-1",
                "user_id": _USER_ID,
                "display_name": "Reginald Troy Maxfield",
                "legal_name": "REGINALD TROY MAXFIELD",
                "finra_crd": "5308823",
                "verification_status": "verified",
            }
        if "INSERT INTO ria_firms" in query:
            return {"id": "firm-1"}
        # No pre-existing profile row.
        return None

    async def execute(self, query: str, *args: Any) -> str:
        if "ria_business_contacts" in query and self.contacts_table_missing:
            raise asyncpg.exceptions.UndefinedTableError("relation does not exist")
        self.executes.append((query, args))
        return "OK"

    async def close(self) -> None:
        return None

    def contacts_write(self) -> tuple[str, tuple[Any, ...]]:
        for query, args in self.executes:
            if "INSERT INTO ria_business_contacts" in query:
                return query, args
        raise AssertionError("no ria_business_contacts write was issued")


def _claim_service(monkeypatch, conn: _FakeClaimConn) -> RIAIAMService:
    service = RIAIAMService()

    async def _fake_conn():
        return conn

    async def _noop(*_args, **_kwargs):
        return None

    monkeypatch.setattr(service, "_conn", _fake_conn)
    monkeypatch.setattr(service, "_ensure_iam_schema_ready", _noop)
    monkeypatch.setattr(service, "_ensure_vault_user_row", _noop)
    monkeypatch.setattr(service, "_set_runtime_last_persona", _noop)
    return service


async def _claim(service: RIAIAMService, **overrides: Any) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "claim_type": "individual",
        "verification_level": "verified",
        "phone_e164": "+18015663510",
        "display_name": "Reginald Troy Maxfield",
        "legal_name": "REGINALD TROY MAXFIELD",
        "crd_number": "5308823",
        "firm_name": "OLYMPUS PEAKS FINANCIAL, LLC",
        "firm_crd": "283040",
        "reference_metadata": _metadata(),
        "business_location": derive_business_location(_metadata()),
    }
    kwargs.update(overrides)
    return await service.claim_ria_profile_from_identity(_USER_ID, **kwargs)


async def test_claim_write_persists_the_derived_location(monkeypatch):
    conn = _FakeClaimConn()
    service = _claim_service(monkeypatch, conn)

    await _claim(service)

    _, args = conn.contacts_write()
    assert args[0] == _USER_ID
    assert args[1] == "+18015663510"
    assert args[2] == "SANDY"
    assert args[3] == ""  # area: never invented
    assert args[4] == "9539 S PROSPERITY RD, SUITE 200"
    assert args[5] == "84070"


async def test_claim_write_without_a_location_still_writes_the_phone(monkeypatch):
    conn = _FakeClaimConn()
    service = _claim_service(monkeypatch, conn)

    await _claim(service, business_location=None)

    _, args = conn.contacts_write()
    assert args[1] == "+18015663510"
    assert args[2:6] == ("", "", "", "")


async def test_claim_write_only_fills_blanks_and_never_typed_values(monkeypatch):
    conn = _FakeClaimConn()
    service = _claim_service(monkeypatch, conn)

    await _claim(service)

    query, _ = conn.contacts_write()
    normalized = " ".join(query.split())
    for column in ("city", "area_locality", "full_street_address", "pin_zip"):
        guard = (
            f"{column} = COALESCE(NULLIF(EXCLUDED.{column}, ''), ria_business_contacts.{column})"
        )
        assert guard in normalized, f"{column} may overwrite an adviser-typed value"
    # The SEC feed carries no coordinates; the claim must not touch them.
    assert "latitude" not in normalized
    assert "longitude" not in normalized


async def test_claim_survives_a_missing_business_contacts_table(monkeypatch):
    conn = _FakeClaimConn(contacts_table_missing=True)
    service = _claim_service(monkeypatch, conn)

    profile = await _claim(service)

    assert profile["ria_profile_id"] == "ria-profile-1"
    assert profile["verification_status"] == "verified"


async def test_completing_a_claim_hands_the_derived_location_to_the_iam_service(monkeypatch):
    """The parsing lives in the claim service; the IAM service is only told."""
    from hushh_mcp.services.ria_claim_service import RIAClaimService

    calls: list[dict[str, Any]] = []

    class _FakeIdentityClient:
        async def claim_evaluate(self, **_kwargs):
            return {
                "ok": True,
                "claimType": "firm",
                "provisional": True,
                "profileVerified": True,
                "verificationLevel": "verified",
                "firm": {
                    "crd": 283040,
                    "name": "OLYMPUS PEAKS FINANCIAL, LLC",
                    "address": {
                        "street1": "9539 S PROSPERITY RD",
                        "street2": "SUITE 200",
                        "city": "SANDY",
                        "state": "UT",
                        "zip": "84070",
                    },
                },
                "roster": [],
            }

    class _FakeIamService:
        async def claim_ria_profile_from_identity(self, user_id, **kwargs):
            calls.append({"user_id": user_id, **kwargs})
            return {"ria_profile_id": "ria-profile-1", "verification_status": "verified"}

    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")

    async def _no_dossier(**_kwargs):
        return None

    async def _no_enrichment(*_args, **_kwargs):
        return None

    service = RIAClaimService(client=_FakeIdentityClient(), iam_service=_FakeIamService())
    monkeypatch.setattr(service, "_dispatch_dossier", _no_dossier)
    monkeypatch.setattr(service, "_record_claim_enrichment", _no_enrichment)

    await service.complete(
        user_id=_USER_ID,
        phone_digits="8015663510",
        claim_type="firm",
        firm_crd=283040,
    )

    assert calls[0]["business_location"] == {
        "city": "SANDY",
        "area": "",
        "address": "9539 S PROSPERITY RD, SUITE 200",
        "pin_zip": "84070",
    }


# ---------------------------------------------------------------------------
# get_ria_onboarding_status: the read-time fallback
# ---------------------------------------------------------------------------


class _FakeStatusConn:
    def __init__(self, *, contact: dict | None, claim_metadata: dict | None):
        self.contact = contact
        self.claim_metadata = claim_metadata
        self.executes: list[str] = []

    async def fetchrow(self, query: str, *_args: Any):
        if "FROM ria_verification_events" in query:
            if self.claim_metadata is None:
                return None
            return {
                "outcome": "verified",
                "checked_at": _NOW - timedelta(hours=1),
                "expires_at": None,
                "reference_metadata": json.dumps(self.claim_metadata),
            }
        if "FROM ria_business_contacts" in query:
            return dict(self.contact) if self.contact is not None else None
        if "FROM ria_profiles" in query and "requested_capabilities" in query:
            return {
                "id": "ria-profile-1",
                "user_id": _USER_ID,
                "display_name": "Reginald Troy Maxfield",
                "requested_capabilities": ["advisory"],
                "individual_legal_name": "REGINALD TROY MAXFIELD",
                "individual_crd": "5308823",
                "advisory_firm_legal_name": "OLYMPUS PEAKS FINANCIAL, LLC",
                "advisory_firm_iapd_number": "801-134885",
                "broker_firm_legal_name": None,
                "broker_firm_crd": None,
                "advisory_status": "verified",
                "brokerage_status": None,
                "advisory_provider": "ria_identity_claim",
                "brokerage_provider": None,
                "advisory_verification_expires_at": None,
                "brokerage_verification_expires_at": None,
                "legal_name": "REGINALD TROY MAXFIELD",
                "finra_crd": "5308823",
                "sec_iard": None,
                "verification_status": "verified",
                "verification_provider": "ria_identity_claim",
                "verification_expires_at": None,
                "created_at": _NOW - timedelta(days=1),
                "updated_at": _NOW,
            }
        if "FROM ria_profiles" in query and "license_number" in query:
            return {}
        return None

    async def execute(self, query: str, *_args: Any) -> str:
        self.executes.append(query)
        return "OK"

    async def close(self) -> None:
        return None


def _empty_contact_row() -> dict[str, Any]:
    return {
        "city": None,
        "area_locality": None,
        "full_street_address": None,
        "pin_zip": None,
        "latitude": None,
        "longitude": None,
        "email": "adviser@olympuspeaks.com",
        "phone": "+18015663510",
    }


def _status_service(monkeypatch, conn: _FakeStatusConn) -> RIAIAMService:
    service = RIAIAMService()

    async def _fake_conn():
        return conn

    async def _noop(*_args, **_kwargs):
        return None

    monkeypatch.setattr(service, "_conn", _fake_conn)
    monkeypatch.setattr(service, "_ensure_iam_schema_ready", _noop)
    monkeypatch.setattr(service, "_ensure_vault_user_row", _noop)
    monkeypatch.setattr(service, "_ensure_actor_profile_row", _noop)
    return service


async def test_status_fills_an_empty_contact_row_from_the_claim_snapshot(monkeypatch):
    conn = _FakeStatusConn(contact=_empty_contact_row(), claim_metadata=_metadata())
    service = _status_service(monkeypatch, conn)

    result = await service.get_ria_onboarding_status(_USER_ID)

    assert result["business_city"] == "SANDY"
    assert result["business_address"] == "9539 S PROSPERITY RD, SUITE 200"
    assert result["business_pin_zip"] == "84070"
    assert result["business_area"] is None  # honestly "Not provided"
    assert result["business_location_source"] == "sec_record"
    # A GET writes nothing.
    assert conn.executes == []


async def test_status_never_publishes_a_private_residence_branch(monkeypatch):
    conn = _FakeStatusConn(
        contact=_empty_contact_row(), claim_metadata=_metadata(branch=_BRANCH_HOME)
    )
    service = _status_service(monkeypatch, conn)

    result = await service.get_ria_onboarding_status(_USER_ID)

    assert result["business_city"] == "SANDY"
    assert result["business_address"] == "9539 S PROSPERITY RD, SUITE 200"
    shown = " | ".join(
        str(result[key] or "")
        for key in ("business_city", "business_area", "business_address", "business_pin_zip")
    )
    for secret in ("HEBER CITY", "742 EVERGREEN TERRACE", "84032"):
        assert secret not in shown


async def test_stored_values_win_over_the_claim_snapshot(monkeypatch):
    contact = _empty_contact_row()
    contact.update(
        {
            "city": "Draper",
            "area_locality": "Corner Canyon",
            "full_street_address": "12 S Main St",
            "pin_zip": "84020",
        }
    )
    conn = _FakeStatusConn(contact=contact, claim_metadata=_metadata())
    service = _status_service(monkeypatch, conn)

    result = await service.get_ria_onboarding_status(_USER_ID)

    assert result["business_city"] == "Draper"
    assert result["business_area"] == "Corner Canyon"
    assert result["business_address"] == "12 S Main St"
    assert result["business_pin_zip"] == "84020"
    assert result["business_location_source"] == "profile"


async def test_a_typed_city_survives_while_a_blank_address_is_filled(monkeypatch):
    contact = _empty_contact_row()
    contact["city"] = "Draper"
    conn = _FakeStatusConn(contact=contact, claim_metadata=_metadata())
    service = _status_service(monkeypatch, conn)

    result = await service.get_ria_onboarding_status(_USER_ID)

    assert result["business_city"] == "Draper"
    assert result["business_address"] == "9539 S PROSPERITY RD, SUITE 200"
    assert result["business_location_source"] == "sec_record"


async def test_status_without_a_claim_or_contact_row_reports_no_source(monkeypatch):
    conn = _FakeStatusConn(contact=None, claim_metadata=None)
    service = _status_service(monkeypatch, conn)

    result = await service.get_ria_onboarding_status(_USER_ID)

    assert result["business_city"] is None
    assert result["business_area"] is None
    assert result["business_address"] is None
    assert result["business_pin_zip"] is None
    assert result["business_location_source"] is None


async def test_wizard_profile_without_a_claim_keeps_reporting_profile(monkeypatch):
    contact = _empty_contact_row()
    contact.update({"city": "Draper", "full_street_address": "12 S Main St"})
    conn = _FakeStatusConn(contact=contact, claim_metadata=None)
    service = _status_service(monkeypatch, conn)

    result = await service.get_ria_onboarding_status(_USER_ID)

    assert result["business_city"] == "Draper"
    assert result["business_location_source"] == "profile"
    assert result["business_latitude"] is None
