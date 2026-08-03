"""Persistence and privacy contract for the Wallet Profile card service.

The card plane is the only place in the product that turns owner-selected
information into something an anonymous stranger can read, so the invariants
below are asserted rather than reviewed:

- ``card_payload`` is a closed allowlist: an unknown key is **rejected**, never
  silently dropped, and every value is trimmed, length-capped and shape-checked;
- links are ``https://`` only — ``javascript:``, ``data:`` and userinfo forms
  are refused;
- the share token exists in plaintext only in the create and rotate responses.
  Only its SHA-256 digest is ever written, and rotating invalidates the previous
  token immediately;
- a paused card is indistinguishable from a card that never existed, while
  revoked and expired report honest terminal states;
- the coarse scan counter is best-effort and can never fail a read;
- the visitor projection carries no ``user_id``, no ``pass_serial`` and no
  internal identifier;
- **nothing here reads or writes ``pkm_default_available_projections``**, which
  is what would otherwise list the owner in the Information Marketplace.

The database is faked at ``get_db`` — the service's single persistence seam —
so every statement and every bound parameter is observable.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

import hushh_mcp.services.one_wallet_card_service as wallet_card_module
from hushh_mcp.services.one_wallet_card_service import (
    OneWalletCardError,
    OneWalletCardService,
    validate_card_payload,
)

OWNER_ID = "user_123"
OTHER_OWNER_ID = "user_456"
PASS_SERIAL = "6f2f0e6a-6d5e-4b0a-9f0a-0d1c2b3a4e5f"

# Placeholder share tokens. None of these is a credential for anything: the
# card plane stores only a SHA-256 digest, so these strings exist purely to be
# hashed by the fake database.
SEEDED_SHARE_TOKEN = "seeded-share-token-000000000000000000"
UNKNOWN_SHARE_TOKEN = "unknown-share-token-0000000000000000"
PAUSED_SHARE_TOKEN = "paused-share-token-00000000000000000"
REVOKED_SHARE_TOKEN = "revoked-share-token-0000000000000000"

FORBIDDEN_TABLES = (
    "pkm_default_available_projections",
    "marketplace_public_profiles",
    "marketplace_listings",
    "pkm_data",
)

VALID_PAYLOAD: dict[str, Any] = {
    "full_name": "Ada Lovelace",
    "headline": "Founder, Hussh",
    "organisation": "Hussh Labs",
    "location_label": "Mumbai, India",
    "summary": "Builds private agents.",
    "skills": ["Python", "Cryptography"],
    "email": "ada@example.com",
    "phone": "+91 99999 90000",
    "website": "https://ada.example.com",
    "linkedin": "https://www.linkedin.com/in/ada",
    "github": "https://github.com/ada",
    "portfolio": "https://ada.example.com/work",
    "preferred_contact": "email",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class _Result:
    def __init__(self, data: list[dict[str, Any]]) -> None:
        self.data = data


class FakeDb:
    """In-memory stand-in for the ``one_wallet_cards`` table.

    Only the statements this service issues are modelled. Every statement and
    every bound parameter is retained so a test can assert what was written —
    in particular that a plaintext token never reaches the database.
    """

    def __init__(self) -> None:
        self.statements: list[tuple[str, dict[str, Any]]] = []
        self.rows: dict[str, dict[str, Any]] = {}
        self.fail_on: str | None = None

    # --- helpers -----------------------------------------------------

    @property
    def sql_log(self) -> str:
        return "\n".join(sql for sql, _ in self.statements)

    def seed(
        self,
        *,
        user_id: str = OWNER_ID,
        share_token: str = SEEDED_SHARE_TOKEN,
        status: str = "active",
        card_payload: dict[str, Any] | None = None,
        expires_at: datetime | None = None,
        avatar_url: str | None = None,
        version: int = 1,
    ) -> str:
        self.rows[user_id] = {
            "user_id": user_id,
            "pass_serial": PASS_SERIAL,
            "share_token_hash": _sha256(share_token),
            "share_token_version": version,
            "status": status,
            "card_payload": dict(card_payload or VALID_PAYLOAD),
            "display_name": (card_payload or VALID_PAYLOAD).get("full_name"),
            "headline": (card_payload or VALID_PAYLOAD).get("headline"),
            "avatar_url": avatar_url,
            "expires_at": expires_at,
            "created_at": _now() - timedelta(days=1),
            "updated_at": _now() - timedelta(hours=1),
            "revoked_at": _now() if status == "revoked" else None,
            "last_scanned_at": None,
            "scan_count": 0,
        }
        return share_token

    def _row_for(self, params: dict[str, Any], compact: str) -> dict[str, Any] | None:
        """Resolve the addressed row exactly as the WHERE clause would."""
        if "user_id = :user_id" in compact:
            user_id = params.get("user_id")
            return self.rows.get(str(user_id)) if user_id else None
        token_hash = params.get("share_token_hash")
        if token_hash:
            for row in self.rows.values():
                if row["share_token_hash"] == token_hash:
                    return row
        return None

    @staticmethod
    def _apply_params(row: dict[str, Any], params: dict[str, Any]) -> None:
        if "card_payload_json" in params:
            row["card_payload"] = json.loads(str(params["card_payload_json"]))
        for column in ("display_name", "headline", "status", "share_token_hash"):
            if column in params:
                row[column] = params[column]
        if "avatar_url" in params and params.get("apply_avatar", True):
            row["avatar_url"] = params["avatar_url"]
        if "expires_at" in params and params.get("apply_expiry", True):
            row["expires_at"] = params["expires_at"]

    # --- the seam ----------------------------------------------------

    def execute_raw(self, sql: str, params: dict[str, Any] | None = None) -> _Result:
        values = dict(params or {})
        self.statements.append((sql, values))
        if self.fail_on and self.fail_on in sql:
            raise RuntimeError("synthetic database failure")

        compact = " ".join(sql.split())
        returning = "RETURNING" in compact.upper()

        if compact.upper().startswith("SELECT"):
            row = self._row_for(values, compact)
            return _Result([dict(row)] if row else [])

        if "INSERT INTO one_wallet_cards" in compact:
            user_id = str(values["user_id"])
            if user_id in self.rows:
                # ON CONFLICT ... DO NOTHING
                return _Result([])
            row = {
                "user_id": user_id,
                "pass_serial": PASS_SERIAL,
                "share_token_hash": values.get("share_token_hash"),
                "share_token_version": 1,
                "status": "active",
                "card_payload": json.loads(str(values.get("card_payload_json") or "{}")),
                "display_name": values.get("display_name"),
                "headline": values.get("headline"),
                "avatar_url": values.get("avatar_url"),
                "expires_at": values.get("expires_at"),
                "created_at": _now(),
                "updated_at": _now(),
                "revoked_at": None,
                "last_scanned_at": None,
                "scan_count": 0,
            }
            self.rows[user_id] = row
            return _Result([dict(row)] if returning else [])

        if "UPDATE one_wallet_cards" in compact:
            row = self._row_for(values, compact)
            if row is None:
                return _Result([])
            if "status <> 'revoked'" in compact and row["status"] == "revoked":
                return _Result([])

            self._apply_params(row, values)
            if "share_token_version = share_token_version + 1" in compact:
                row["share_token_version"] = int(row["share_token_version"]) + 1
            if "THEN 'active' ELSE status END" in compact:
                if row["status"] == "revoked":
                    row["status"] = "active"
            elif "SET status = 'revoked'" in compact:
                row["status"] = "revoked"
                row["revoked_at"] = row["revoked_at"] or _now()
            if "revoked_at = NULL" in compact:
                row["revoked_at"] = None
            if "scan_count = scan_count + 1" in compact:
                row["scan_count"] = int(row["scan_count"]) + 1
                row["last_scanned_at"] = _now()
            elif "updated_at = NOW()" in compact:
                row["updated_at"] = _now()
            return _Result([dict(row)] if returning else [])

        raise AssertionError(f"unexpected statement: {compact}")


@pytest.fixture
def db(monkeypatch: pytest.MonkeyPatch) -> FakeDb:
    fake = FakeDb()
    monkeypatch.setattr(wallet_card_module, "get_db", lambda: fake)
    return fake


@pytest.fixture
def service() -> OneWalletCardService:
    return OneWalletCardService()


def _card(result: Any) -> dict[str, Any]:
    """Owner-view card out of whatever envelope a mutation returned."""
    if isinstance(result, dict):
        card = result.get("card")
        return dict(card) if isinstance(card, dict) else dict(result)
    return dict(getattr(result, "card", {}) or {})


def _share_token(result: Any) -> str | None:
    if isinstance(result, dict):
        token = result.get("shareToken") or result.get("share_token")
        return str(token) if token else None
    token = getattr(result, "share_token", None)
    return str(token) if token else None


def _public(result: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    """Split the ``{"status", "card"}`` envelope the public plane returns.

    The route maps ``not_found`` to a generic 404 and ``revoked``/``expired`` to
    an honest 410, so the service must *report* the state rather than raise —
    a raise would collapse every terminal state into the same 404.
    """
    card = result.get("card")
    return str(result.get("status") or ""), (dict(card) if isinstance(card, dict) else None)


# ---------------------------------------------------------------------------
# card_payload allowlist
# ---------------------------------------------------------------------------


def test_the_full_allowlist_is_accepted_and_normalised() -> None:
    validated = validate_card_payload({**VALID_PAYLOAD, "full_name": "  Ada   Lovelace  "})

    assert validated["full_name"] == "Ada Lovelace"
    assert validated["skills"] == ["Python", "Cryptography"]
    assert validated["preferred_contact"] == "email"
    assert set(validated) <= set(VALID_PAYLOAD)


def test_an_unknown_key_is_rejected_not_silently_dropped() -> None:
    with pytest.raises(OneWalletCardError) as exc:
        validate_card_payload({"full_name": "Ada Lovelace", "vault_key": "secret"})

    assert exc.value.status_code == 422
    assert "secret" not in exc.value.message


def test_every_unknown_key_shape_is_rejected() -> None:
    for payload in (
        {"user_id": "user_123"},
        {"pass_serial": PASS_SERIAL},
        {"share_token": "plaintext"},
        {"latitude": 28.6},
        {"__proto__": "x"},
    ):
        with pytest.raises(OneWalletCardError):
            validate_card_payload(payload)


def test_text_fields_are_length_capped() -> None:
    caps = {
        "full_name": 80,
        "headline": 120,
        "organisation": 80,
        "location_label": 80,
        "summary": 400,
    }
    for key, cap in caps.items():
        assert validate_card_payload({key: "a" * cap})[key] == "a" * cap
        with pytest.raises(OneWalletCardError):
            validate_card_payload({key: "a" * (cap + 1)})


def test_over_long_values_are_refused_rather_than_truncated() -> None:
    with pytest.raises(OneWalletCardError):
        validate_card_payload({"summary": "s" * 401})


def test_skills_are_capped_at_twelve_entries_of_forty_characters() -> None:
    twelve = [f"skill-{index}" for index in range(12)]

    assert validate_card_payload({"skills": twelve})["skills"] == twelve
    with pytest.raises(OneWalletCardError):
        validate_card_payload({"skills": [*twelve, "one-too-many"]})
    with pytest.raises(OneWalletCardError):
        validate_card_payload({"skills": ["x" * 41]})
    with pytest.raises(OneWalletCardError):
        validate_card_payload({"skills": "not-a-list"})


def test_links_must_be_https() -> None:
    for key in ("website", "linkedin", "github", "portfolio"):
        assert validate_card_payload({key: "https://ok.example/path"})[key] == (
            "https://ok.example/path"
        )
        for bad in (
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "data:text/html;base64,PHNjcmlwdD4=",
            "http://ok.example",
            "//ok.example",
            "https://ada@evil.example",
            "https://ada:pw@evil.example",
            "https://ok.example/<script>",
            "https://ok.example/ path",
        ):
            with pytest.raises(OneWalletCardError):
                validate_card_payload({key: bad})


def test_email_and_phone_shapes_are_validated() -> None:
    assert validate_card_payload({"email": "ada@example.com"})["email"] == "ada@example.com"
    for bad in ("ada@example", "ada example.com", "@example.com", "ada@@example.com"):
        with pytest.raises(OneWalletCardError):
            validate_card_payload({"email": bad})

    assert validate_card_payload({"phone": "+91 99999 90000"})["phone"] == "+91 99999 90000"
    for bad in ("call me", "12345", "+" + "9" * 40):
        with pytest.raises(OneWalletCardError):
            validate_card_payload({"phone": bad})


def test_preferred_contact_is_a_closed_set() -> None:
    for choice in ("email", "phone", "linkedin", "website"):
        payload = {choice: VALID_PAYLOAD[choice], "preferred_contact": choice}
        assert validate_card_payload(payload)["preferred_contact"] == choice

    with pytest.raises(OneWalletCardError):
        validate_card_payload({"email": "ada@example.com", "preferred_contact": "carrier"})


def test_empty_values_are_dropped_rather_than_stored_blank() -> None:
    validated = validate_card_payload(
        {"full_name": "Ada Lovelace", "headline": "   ", "skills": []}
    )

    assert validated == {"full_name": "Ada Lovelace"}


# ---------------------------------------------------------------------------
# Token handling
# ---------------------------------------------------------------------------


def test_creating_a_card_stores_only_the_sha256_digest_of_the_token(
    service: OneWalletCardService, db: FakeDb
) -> None:
    result = service.upsert_card(user_id=OWNER_ID, card_payload=dict(VALID_PAYLOAD))
    token = _share_token(result)

    assert token, "the plaintext token must be returned once on create"
    stored = db.rows[OWNER_ID]["share_token_hash"]
    assert stored == _sha256(token)
    assert len(stored) == 64

    # The plaintext must appear in no statement and in no bound parameter.
    for sql, params in db.statements:
        assert token not in sql
        assert token not in json.dumps(params, default=str)


def test_updating_a_card_never_re_issues_or_changes_the_token(
    service: OneWalletCardService, db: FakeDb
) -> None:
    original = db.seed()
    original_hash = db.rows[OWNER_ID]["share_token_hash"]

    result = service.upsert_card(user_id=OWNER_ID, card_payload={"full_name": "Ada Byron"})

    assert _share_token(result) is None
    assert db.rows[OWNER_ID]["share_token_hash"] == original_hash
    assert db.rows[OWNER_ID]["share_token_hash"] == _sha256(original)
    assert db.rows[OWNER_ID]["card_payload"] == {"full_name": "Ada Byron"}


def test_rotating_invalidates_the_previous_token_immediately(
    service: OneWalletCardService, db: FakeDb
) -> None:
    old_token = db.seed()

    result = service.rotate_share_token(user_id=OWNER_ID)
    new_token = _share_token(result)

    assert new_token and new_token != old_token
    assert db.rows[OWNER_ID]["share_token_hash"] == _sha256(new_token)
    assert db.rows[OWNER_ID]["share_token_version"] == 2

    # The old token must no longer resolve to anything.
    assert _public(service.resolve_public_card(share_token=old_token)) == (
        "not_found",
        None,
    )
    assert _public(service.resolve_public_card(share_token=new_token))[0] == "active"


def test_rotating_bumps_the_version_every_time(service: OneWalletCardService, db: FakeDb) -> None:
    db.seed()

    service.rotate_share_token(user_id=OWNER_ID)
    service.rotate_share_token(user_id=OWNER_ID)

    assert db.rows[OWNER_ID]["share_token_version"] == 3


def test_the_pass_serial_never_changes_across_edits_and_rotations(
    service: OneWalletCardService, db: FakeDb
) -> None:
    db.seed()

    service.upsert_card(user_id=OWNER_ID, card_payload={"full_name": "Ada Byron"})
    service.rotate_share_token(user_id=OWNER_ID)

    assert db.rows[OWNER_ID]["pass_serial"] == PASS_SERIAL


def test_a_wrong_shape_token_is_rejected_before_any_query(
    service: OneWalletCardService, db: FakeDb
) -> None:
    db.seed()
    db.statements.clear()

    for token in ("", "short", "has spaces here and is long", "../../etc/passwd"):
        assert _public(service.resolve_public_card(share_token=token)) == (
            "not_found",
            None,
        ), token

    assert db.statements == []


# ---------------------------------------------------------------------------
# Public status semantics
# ---------------------------------------------------------------------------


def test_a_paused_card_is_indistinguishable_from_an_unknown_token(
    service: OneWalletCardService, db: FakeDb
) -> None:
    paused_token = db.seed(status="paused")

    paused = service.resolve_public_card(share_token=paused_token)
    unknown = service.resolve_public_card(share_token=UNKNOWN_SHARE_TOKEN)

    assert paused == unknown
    assert _public(paused) == ("not_found", None)
    assert "Ada Lovelace" not in json.dumps(paused, default=str)


def test_a_revoked_card_reports_the_revoked_state(
    service: OneWalletCardService, db: FakeDb
) -> None:
    token = db.seed(status="revoked")

    status, card = _public(service.resolve_public_card(share_token=token))

    assert status == "revoked"
    assert card is None


def test_an_expired_card_reports_the_expired_state(
    service: OneWalletCardService, db: FakeDb
) -> None:
    token = db.seed(expires_at=_now() - timedelta(minutes=1))

    status, card = _public(service.resolve_public_card(share_token=token))

    assert status == "expired"
    assert card is None


def test_a_future_expiry_still_resolves(service: OneWalletCardService, db: FakeDb) -> None:
    token = db.seed(expires_at=_now() + timedelta(days=30))

    status, card = _public(service.resolve_public_card(share_token=token))

    assert status == "active"
    assert card is not None
    assert card["fullName"] == "Ada Lovelace"


def test_pausing_and_resuming_round_trips_on_the_same_token(
    service: OneWalletCardService, db: FakeDb
) -> None:
    token = db.seed()

    service.pause_card(user_id=OWNER_ID)
    assert _public(service.resolve_public_card(share_token=token)) == ("not_found", None)

    service.resume_card(user_id=OWNER_ID)
    status, card = _public(service.resolve_public_card(share_token=token))

    assert status == "active"
    assert card is not None
    assert card["fullName"] == "Ada Lovelace"


def test_revocation_is_terminal_and_idempotent(service: OneWalletCardService, db: FakeDb) -> None:
    db.seed()

    service.revoke_card(user_id=OWNER_ID)
    first_revoked_at = db.rows[OWNER_ID]["revoked_at"]
    service.revoke_card(user_id=OWNER_ID)

    assert db.rows[OWNER_ID]["status"] == "revoked"
    assert db.rows[OWNER_ID]["revoked_at"] == first_revoked_at


def test_owner_actions_on_a_missing_card_report_a_setup_state(
    service: OneWalletCardService, db: FakeDb
) -> None:
    for action in (service.pause_card, service.resume_card, service.revoke_card):
        with pytest.raises(OneWalletCardError) as exc:
            action(user_id=OWNER_ID)
        assert exc.value.status_code == 404


def test_a_card_is_scoped_to_its_owner(service: OneWalletCardService, db: FakeDb) -> None:
    db.seed(user_id=OWNER_ID)

    assert service.get_card(user_id=OTHER_OWNER_ID) is None


# ---------------------------------------------------------------------------
# Scan counters
# ---------------------------------------------------------------------------


def test_the_scan_counter_failing_does_not_fail_the_read(
    service: OneWalletCardService, db: FakeDb
) -> None:
    token = db.seed()
    before = service.resolve_public_card(share_token=token)

    db.fail_on = "scan_count = scan_count + 1"
    service.record_scan(share_token=token)  # must swallow the failure
    after = service.resolve_public_card(share_token=token)

    assert _public(before)[0] == "active"
    assert after == before


def test_the_scan_counter_is_aggregate_only(service: OneWalletCardService, db: FakeDb) -> None:
    token = db.seed()

    service.record_scan(share_token=token)
    service.record_scan(share_token=token)

    assert db.rows[OWNER_ID]["scan_count"] == 2
    assert db.rows[OWNER_ID]["last_scanned_at"] is not None
    # No per-scan row, address, agent, referrer or coordinate anywhere.
    written = json.dumps([params for _, params in db.statements], default=str).lower()
    for forbidden in ("ip", "user_agent", "referrer", "latitude", "longitude"):
        assert f'"{forbidden}"' not in written


def test_a_scan_never_shifts_the_public_coarse_date(
    service: OneWalletCardService, db: FakeDb
) -> None:
    token = db.seed()
    before = _public(service.resolve_public_card(share_token=token))[1]
    assert before is not None

    service.record_scan(share_token=token)
    after = _public(service.resolve_public_card(share_token=token))[1]

    assert after is not None
    assert after["updatedOn"] == before["updatedOn"]


# ---------------------------------------------------------------------------
# The visitor projection
# ---------------------------------------------------------------------------


def test_the_projection_never_emits_an_internal_identifier(
    service: OneWalletCardService, db: FakeDb
) -> None:
    token = db.seed()

    projection = _public(service.resolve_public_card(share_token=token))[1]
    assert projection is not None
    serialised = json.dumps(projection, default=str)

    assert OWNER_ID not in serialised
    assert PASS_SERIAL not in serialised
    assert token not in serialised
    for forbidden in (
        "user_id",
        "userId",
        "pass_serial",
        "passSerial",
        "share_token",
        "shareToken",
        "share_token_hash",
        "scan_count",
        "scanCount",
        "status",
    ):
        assert forbidden not in projection


def test_the_projection_exposes_no_timestamp_finer_than_a_date(
    service: OneWalletCardService, db: FakeDb
) -> None:
    token = db.seed()

    projection = _public(service.resolve_public_card(share_token=token))[1]
    assert projection is not None
    updated_on = projection["updatedOn"]

    assert len(updated_on) == 10
    datetime.strptime(updated_on, "%Y-%m-%d")  # noqa: DTZ007 - date only by design


def test_the_projection_reads_only_allowlisted_payload_keys(
    service: OneWalletCardService, db: FakeDb
) -> None:
    token = db.seed(
        card_payload={
            **VALID_PAYLOAD,
            "vault_key": "should-never-appear",
            "user_id": OWNER_ID,
        }
    )

    serialised = json.dumps(service.resolve_public_card(share_token=token), default=str)

    assert "should-never-appear" not in serialised


def test_the_owner_preview_is_identical_to_the_public_read(
    service: OneWalletCardService, db: FakeDb
) -> None:
    """Preview-as-visitor must call the same builder — no second code path."""
    token = db.seed()

    public = _public(service.resolve_public_card(share_token=token))[1]
    preview = _public(service.preview_public_card(user_id=OWNER_ID))[1]

    assert public is not None
    assert json.dumps(preview, sort_keys=True, default=str) == json.dumps(
        public, sort_keys=True, default=str
    )


# ---------------------------------------------------------------------------
# Pass material
# ---------------------------------------------------------------------------


def test_pass_material_carries_the_stable_serial_and_the_public_card_url(
    service: OneWalletCardService, db: FakeDb
) -> None:
    token = db.seed()

    result = service.resolve_pass_material(share_token=token)
    material = result.get("material")

    assert result.get("status") == "active"
    assert isinstance(material, dict)
    serial = material.get("passSerial") or material.get("pass_serial")
    url = material.get("publicCardUrl") or material.get("public_card_url")
    assert serial == PASS_SERIAL
    assert str(url).endswith(f"/c/{token}")


def test_pass_material_applies_the_same_status_rules_as_resolve(
    service: OneWalletCardService, db: FakeDb
) -> None:
    paused = db.seed(
        user_id=OWNER_ID,
        share_token=PAUSED_SHARE_TOKEN,
        status="paused",
    )
    revoked = db.seed(
        user_id=OTHER_OWNER_ID,
        share_token=REVOKED_SHARE_TOKEN,
        status="revoked",
    )

    assert service.resolve_pass_material(share_token=paused)["status"] == "not_found"
    assert service.resolve_pass_material(share_token=revoked)["status"] == "revoked"
    unknown = service.resolve_pass_material(share_token=UNKNOWN_SHARE_TOKEN)
    assert unknown["status"] == "not_found"


def test_pass_material_never_carries_the_owner_identifier(
    service: OneWalletCardService, db: FakeDb
) -> None:
    token = db.seed()

    material = service.resolve_pass_material(share_token=token).get("material") or {}

    assert "user_id" not in material
    assert "userId" not in material
    assert "share_token_hash" not in material
    assert OWNER_ID not in json.dumps(material, default=str)


# ---------------------------------------------------------------------------
# The privacy defect this design exists to avoid
# ---------------------------------------------------------------------------


def test_no_statement_ever_touches_the_projection_or_marketplace_planes(
    service: OneWalletCardService, db: FakeDb
) -> None:
    """Publishing a Wallet card must not create or modify a row in
    ``pkm_default_available_projections`` and must not reach the Information
    Marketplace catalogue. Every statement the full lifecycle issues is
    inspected."""
    service.upsert_card(user_id=OWNER_ID, card_payload=dict(VALID_PAYLOAD))
    token = _share_token(service.rotate_share_token(user_id=OWNER_ID))
    assert token is not None
    service.resolve_public_card(share_token=token)
    service.record_scan(share_token=token)
    service.preview_public_card(user_id=OWNER_ID)
    service.pause_card(user_id=OWNER_ID)
    service.resume_card(user_id=OWNER_ID)
    service.revoke_card(user_id=OWNER_ID)

    assert db.statements, "the lifecycle must actually have hit the database"
    for sql, _ in db.statements:
        assert "one_wallet_cards" in sql
        for table in FORBIDDEN_TABLES:
            assert table not in sql


def test_publishing_a_card_writes_only_the_wallet_card_row(
    service: OneWalletCardService, db: FakeDb
) -> None:
    service.upsert_card(user_id=OWNER_ID, card_payload=dict(VALID_PAYLOAD))

    assert set(db.rows) == {OWNER_ID}
    assert set(db.rows[OWNER_ID]["card_payload"]) <= set(VALID_PAYLOAD)


def test_every_statement_is_parameterised(service: OneWalletCardService, db: FakeDb) -> None:
    """Bandit forbids f-string SQL; values must arrive as bound parameters."""
    hostile = "Ada'); DROP TABLE one_wallet_cards; --"

    service.upsert_card(user_id=OWNER_ID, card_payload={"full_name": hostile})

    assert db.rows[OWNER_ID]["card_payload"]["full_name"] == hostile
    for sql, _ in db.statements:
        assert "DROP TABLE" not in sql
        assert hostile not in sql
