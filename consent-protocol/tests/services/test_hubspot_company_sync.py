"""Company portal, privacy, idempotency and erasure boundaries (no live accounts)."""

from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest

from hushh_mcp.services.hubspot_company_client import CompanyCrmError, HubSpotCompanyClient
from hushh_mcp.services.hubspot_company_contract import (
    CONTACT_PROPERTIES,
    activity_note,
    activity_payload,
    auth_timestamp,
    contact_properties,
    email_fingerprint,
    expiry,
    receipt_key,
)
from hushh_mcp.services.hubspot_company_store import capture_activity, erase_in_transaction
from hushh_mcp.services.hubspot_company_sync import HubSpotCompanySync

NOW = datetime(2026, 10, 27, 10, tzinfo=UTC)
OWNER = "sha256:" + "a" * 64
ITEM = receipt_key("activity", "fixture-event")


def adapter(handler):
    http = httpx.Client(base_url="https://api.hubapi.com", transport=httpx.MockTransport(handler))
    return HubSpotCompanyClient("synthetic-test-key", "1234", client=http)


def test_wrong_portal_blocks_all_mutations_and_unverified_client_cannot_write():
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={"portalId": 9999})

    client = adapter(handler)
    with pytest.raises(CompanyCrmError, match="company_not_verified"):
        client.create_note("10", NOW.isoformat(), "test")
    with pytest.raises(CompanyCrmError, match="company_portal_mismatch"):
        client.verify()
    assert [r.method for r in requests] == ["GET"]


def test_missing_unique_account_property_blocks_verification():
    def handler(request):
        if request.url.path == "/account-info/v3/details":
            return httpx.Response(200, json={"portalId": 1234})
        return httpx.Response(
            200, json={"name": "one_user_id", "type": "string", "hasUniqueValue": False}
        )

    client = adapter(handler)
    with pytest.raises(CompanyCrmError, match="company_mapping_mismatch"):
        client.verify()
    assert client.verified is True
    assert client.mapping_ready is False
    # Portal-bound note erasure remains available despite contact mapping drift.
    client.delete_note("11")


def test_projection_uses_only_explicit_auth_metadata_and_true_sign_in_time():
    record = SimpleNamespace(
        user_metadata=SimpleNamespace(
            creation_timestamp=1_700_000_000_000, last_sign_in_timestamp=1_700_000_123_456
        ),
        password_hash="PRIVATE",  # noqa: S106 - sentinel proving credential exclusion
        custom_claims={"private": "PRIVATE"},
    )
    values = contact_properties(record, OWNER)
    assert set(values) == set(CONTACT_PROPERTIES)
    assert values["one_last_login_at"] == "2023-11-14T22:15:23.456000+00:00"
    assert values["one_user_id"] == OWNER and "PRIVATE" not in repr(values)
    for invalid in (None, True, 0, -1, float("nan"), float("inf"), 10**1000):
        assert auth_timestamp(invalid) is None


def test_partial_schema_read_cannot_complete_contact_erasure():
    requests = []

    def handler(request):
        requests.append(request)
        if request.url.path.endswith("one_user_id"):
            return httpx.Response(
                200, json={"name": "one_user_id", "type": "string", "hasUniqueValue": True}
            )
        if request.url.path.endswith("one_signup_at"):
            raise httpx.ReadTimeout("synthetic failure")
        return httpx.Response(200, json={"id": "10", "properties": {"one_user_id": OWNER}})

    client = adapter(handler)
    client.verified = True
    with pytest.raises(CompanyCrmError, match="company_transport_unavailable"):
        client.verify_mapping()
    with pytest.raises(CompanyCrmError, match="company_cleanup_schema_unavailable"):
        client.clear_owned_contact(OWNER, None, "10")
    assert all(request.method == "GET" for request in requests)


def test_activity_copy_has_fixed_fields_escaped_text_and_ninety_day_expiry():
    payload = activity_payload(
        agent_id="agent_one",
        action_id="<private-script>",
        source="client_reported",
        phase="returned",
        observed_at=NOW,
    )
    timestamp, body = activity_note(ITEM, payload)
    assert timestamp == NOW.isoformat()
    assert "&lt;private-script&gt;" in body and "<private-script>" not in body
    assert "does not prove" in body
    assert expiry(NOW) == NOW + timedelta(days=90)
    with pytest.raises(ValueError, match="unexpected activity fields"):
        activity_note(ITEM, {**payload, "prompt": "PRIVATE"})


def test_contact_refresh_cannot_regress_last_login_or_change_unrelated_identity():
    requests = []

    def handler(request):
        requests.append(request)
        if request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "id": "10",
                    "properties": {
                        "one_last_login_at": "2026-10-27T12:00:00Z",
                        "email": "existing@example.test",
                    },
                },
            )
        return httpx.Response(200, json={"id": "10"})

    client = adapter(handler)
    client.verified = True
    client.mapping_ready = True
    client.available_fields = set(CONTACT_PROPERTIES)
    assert client.ensure_contact(
        {"one_user_id": OWNER, "one_last_login_at": "2026-10-27T10:00:00+00:00"},
        email="other@example.test",
        verified_email=True,
    ) == ("10", None)
    import json

    body = json.loads(requests[-1].content)
    assert body["properties"]["one_last_login_at"] == "2026-10-27T12:00:00Z"
    assert "email" not in body["properties"]


@pytest.mark.parametrize("same_email", [True, False])
def test_cleanup_preserves_shared_contact_and_independently_changed_email(same_email):
    requests = []
    owned = "one@example.test"

    def handler(request):
        requests.append(request)
        if request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "id": "10",
                    "properties": {
                        "one_user_id": OWNER,
                        "email": owned if same_email else "crm-edit@example.test",
                    },
                },
            )
        return httpx.Response(200, json={"id": "10"})

    client = adapter(handler)
    client.verified = True
    client.available_fields = set(CONTACT_PROPERTIES)
    assert client.clear_owned_contact(OWNER, email_fingerprint(owned))
    import json

    properties = json.loads(requests[-1].content)["properties"]
    assert all(properties[name] == "" for name in CONTACT_PROPERTIES)
    assert ("email" in properties) is same_email
    assert all(r.method != "DELETE" for r in requests)


def test_unknown_note_creation_never_becomes_a_blind_retry_or_completed_cleanup():
    client = Mock()
    client.find_note.return_value = None
    worker = HubSpotCompanySync(client)
    conn = Mock()
    row = {
        "kind": "activity",
        "item_id": ITEM,
        "remote_note_id": None,
        "remote_outcome_unknown": True,
    }
    with pytest.raises(CompanyCrmError, match="company_cleanup_unconfirmed"):
        worker._cleanup(conn, row)
    conn.execute.assert_not_called()
    client.create_note.assert_not_called()
    client.delete_note.assert_not_called()
    client.find_note.return_value = "11"
    worker._cleanup(conn, row)
    client.delete_note.assert_called_once_with("11")


def test_deleted_owner_and_old_epoch_cannot_dispatch_activity(monkeypatch):
    generation = "00000000-0000-0000-0000-000000000001"
    row = {
        "item_id": ITEM,
        "owner_user_id": "owner",
        "owner_hash": OWNER,
        "kind": "activity",
        "generation": generation,
        "cleanup_requested": False,
        "expires_at": datetime.now(UTC) + timedelta(days=1),
        "state": "pending",
        "remote_outcome_unknown": False,
    }
    conn = Mock()
    conn.execute.return_value.mappings.return_value.first.return_value = row
    conn.execute.return_value.scalar.return_value = "different-epoch"

    @contextmanager
    def connect():
        yield conn

    client = Mock()
    worker = HubSpotCompanySync(client, connect=connect)
    monkeypatch.setattr(worker, "_reserve_dispatch", lambda _: None)
    monkeypatch.setattr(worker, "_active_owner", lambda *_: False)
    with pytest.raises(CompanyCrmError, match="company_owner_unavailable"):
        worker._dispatch(row)
    monkeypatch.setattr(worker, "_active_owner", lambda *_: True)
    with pytest.raises(CompanyCrmError, match="company_epoch_or_retention_changed"):
        worker._dispatch(row)
    client.create_note.assert_not_called()
    client.update_note.assert_not_called()


def test_capture_is_off_by_default_and_erasure_keeps_only_receipts(monkeypatch):
    monkeypatch.delenv("ONE_HUBSPOT_SYNC_ENABLED", raising=False)
    conn = Mock()
    capture_activity(
        conn,
        user_id="owner",
        event_id="source",
        generation="generation",
        agent_id="agent_one",
        action_id="agent:agent_one",
        source="execution_observed",
        phase="returned",
        observed_at=NOW,
    )
    conn.execute.assert_not_called()
    erase_in_transaction(conn, "owner", permanent=True, table_exists=lambda _: True)
    statement, params = conn.execute.call_args.args
    assert "payload='{}'::JSONB" in str(statement) and "generation=NULL" in str(statement)
    assert "cleanup_requested=TRUE" in str(statement)
    assert params == {"uid": "owner", "permanent": True}


def test_unverified_email_never_reaches_contact_write_or_existing_email_lookup():
    requests = []

    def handler(request):
        requests.append(request)
        if request.method == "GET":
            return httpx.Response(404)
        return httpx.Response(200, json={"results": [{"id": "10"}]})

    client = adapter(handler)
    client.verified = client.mapping_ready = True
    client.ensure_contact(
        {"one_user_id": OWNER}, email="unverified@example.test", verified_email=False
    )
    assert all(b"unverified@example.test" not in r.content for r in requests)
    assert all(r.url.params.get("idProperty") != "email" for r in requests)


def test_firebase_read_uses_the_captured_application_owner(monkeypatch):
    from firebase_admin import auth

    from api.utils import firebase_admin
    from hushh_mcp.services.account_generation_service import (
        AccountGenerationRefused,
        AccountGenerationService,
    )

    app = SimpleNamespace(project_id="hushh-pda")
    record = SimpleNamespace(
        uid="firebase-identity",
        email="one@example.test",
        phone_number=None,
        provider_data=[],
        disabled=False,
        custom_claims={},
    )
    resolve = Mock(return_value="firebase-identity")
    read = Mock(return_value=record)
    monkeypatch.setattr(firebase_admin, "get_firebase_auth_app", lambda: app)
    monkeypatch.setattr(AccountGenerationService, "firebase_identity_for_owner", resolve)
    monkeypatch.setattr(auth, "get_user", read)
    worker = HubSpotCompanySync(Mock())
    owner = "acct_" + "a" * 32
    assert worker._fetch_record(owner) is record
    resolve.assert_called_once_with(owner)
    read.assert_called_once_with("firebase-identity", app=app)
    read.reset_mock()
    resolve.side_effect = AccountGenerationRefused("account_retired")
    with pytest.raises(CompanyCrmError, match="company_identity_read_unavailable"):
        worker._fetch_record(owner)
    read.assert_not_called()


def test_unknown_contact_create_cannot_replace_email_ownership_evidence():
    conn = Mock()
    conn.execute.return_value.mappings.return_value.first.return_value = None
    record = SimpleNamespace(
        email="changed@example.test",
        email_verified=True,
        display_name=None,
        phone_number=None,
        provider_data=[],
        user_metadata=SimpleNamespace(
            creation_timestamp=1700000000000, last_sign_in_timestamp=1700000000000
        ),
    )
    client = Mock()

    def attempt(_properties, **kwargs):
        kwargs["prepare_create"](email_fingerprint("changed@example.test"))

    client.ensure_contact.side_effect = attempt
    worker = HubSpotCompanySync(client)
    with pytest.raises(CompanyCrmError, match="company_contact_outcome_unknown"):
        worker._sync_contact(
            conn,
            {"state": "unknown", "owner_user_id": "owner", "owner_hash": OWNER, "item_id": ITEM},
            record,
        )
    conn.commit.assert_not_called()
