"""Zero-index foreground review and trusted background repeat in isolated Postgres."""

# ruff: noqa: F401, F811 -- shared isolated PostgreSQL fixtures
import json
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_live_preferences import DriveLivePreferences
from hushh_mcp.services.drive_permission_store import DrivePermissionStore
from hushh_mcp.services.drive_sharing_contract import (
    BROAD_TRUST_DISCLOSURE,
    BROAD_TRUST_SCOPE,
    DriveSharingError,
    ShareRequestPurpose,
    VerifiedGoogleRecipient,
)
from hushh_mcp.services.drive_suggestion_service import DriveSuggestionService
from hushh_mcp.services.drive_suggestion_store import DriveSuggestionStore
from hushh_mcp.services.google_drive_adapter import LIVE_POLICY_HASH, DriveReadError
from tests.services.test_drive_sharing_store import (
    MIGRATIONS,
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    rows,
    sharing,
)


@pytest.fixture
async def live_journey(sharing, monkeypatch):
    monkeypatch.setenv("GOOGLE_DRIVE_LIVE", "true")
    with sharing.db.engine.connect() as connection:
        connection.execute(
            text(
                "UPDATE external_mcp_connectors SET oauth_scopes='openid email https://www.googleapis.com/auth/drive.file' WHERE connector_id='google_drive'"
            )
        )
        connection.commit()
        # Execute SQL verbatim: this migration contains JSON colons and PL/pgSQL %I.
        with connection.connection.driver_connection.cursor() as cursor:
            cursor.execute((MIGRATIONS / "241_drive_live_sharing.sql").read_text())
        connection.execute(
            text(
                "UPDATE user_external_connector_connections SET verified_policy_hash=:policy WHERE user_id='owner'"
            ),
            {"policy": LIVE_POLICY_HASH},
        )
        connection.commit()
    store = DriveSuggestionStore(db=sharing.db, authority_key="synthetic-ledger-key")
    preferences = DriveLivePreferences(db=store.db)
    await preferences.set_background(user_id="owner", enabled=False, confirmed=True)
    counter = [0]

    def reader_factory(*, user_id, require_access):
        counter[0] += 1
        document = str(uuid4())
        ref = "document:" + "a" * 32
        source = {
            "document_id": document,
            "file_id": f"new-file-{counter[0]}",
            "name": "Requested document",
            "source_version": "1",
            "content_fingerprint": str(counter[0]) * 64,
            "connection_generation": 1,
            "_live": True,
        }

        async def search(**kwargs):
            await require_access()
            return {
                "untrusted_external_content": [
                    {
                        "source_ref": ref,
                        "document_ref": document,
                        "text": "Requested records",
                        "page": None,
                    }
                ],
                "truncated": False,
            }

        return SimpleNamespace(search=search, require_current=require_access, _rows=[source])

    async def interpret(**kwargs):
        item = json.loads(kwargs["prompt"])["retrieved_documents"]["untrusted_external_content"][0]
        return {
            "files": [{"document_ref": item["document_ref"], "source_refs": [item["source_ref"]]}],
            "coverage_summary": "Requested records found",
            "gaps": [],
            "coverage_status": "complete",
            "covered_periods": [],
        }

    def service(owner=None):
        return DriveSuggestionService(
            oauth=SimpleNamespace(),
            store=store,
            reader_factory=reader_factory,
            interpreter=interpret,
            search_planner=AsyncMock(return_value={"terms": ["records"]}),
            require_owner=owner,
        )

    async def create(purpose):
        return await store.create_request(
            recipient=VerifiedGoogleRecipient(
                "recipient", "1234567", "recipient@example.invalid", datetime.now(UTC)
            ),
            owner_user_id="owner",
            client_request_id=str(uuid4()),
            purpose=ShareRequestPurpose(purpose=purpose),
        )

    return store, preferences, service, create


async def test_zero_index_foreground_then_new_file_trusted_repeat_and_revocation(live_journey):
    store, preferences, service, create = live_journey
    first = await create("First document")
    with pytest.raises(DriveReadError, match="background_preparation_required"):
        await service().run_one(user_id="owner", request_id=first["requestId"])
    owner = AsyncMock()
    assert (
        await service(owner).run_one(user_id="owner", request_id=first["requestId"])
        == "review_ready"
    )
    assert owner.await_count > 3
    review = await store.owner_review(user_id="owner", request_id=first["requestId"])
    assert review["canApprove"]
    assert not rows(store, "connected_documents")
    with store.db.engine.connect() as connection:
        assert connection.execute(text("SELECT COUNT(*) FROM document_chunks")).scalar_one() == 0
    await store.approve_review(
        user_id="owner",
        generation=1,
        request_id=first["requestId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
        document_ids=[item["documentId"] for item in review["files"]],
        confirmed=True,
        trust_future_requests=True,
        trust_scope=BROAD_TRUST_SCOPE,
        trust_disclosure_version=BROAD_TRUST_DISCLOSURE,
    )
    await preferences.set_background(user_id="owner", enabled=True, confirmed=True)
    second = await create("Different document and purpose")
    assert (
        await service().run_one(user_id="owner", request_id=second["requestId"]) == "review_ready"
    )
    assert (await store.request_status(user_id="recipient", request_id=second["requestId"]))[
        "status"
    ] == "approved"
    rule = (await store.list_rules(user_id="owner"))["items"][0]
    assert rule["scope"] == BROAD_TRUST_SCOPE and rule["readiness"] == "ready"
    operation = next(
        item
        for item in rows(store, "drive_share_permission_operations")
        if str(item["request_id"]) == second["requestId"]
    )
    permissions = DrivePermissionStore(db=store.db, authority_key="synthetic-ledger-key")
    with store.db.engine.begin() as connection:
        assert permissions._grant_authority(connection, operation)["rule_id"] == rule["ruleId"]
    await store.revoke_rule(
        user_id="owner", rule_id=rule["ruleId"], version=rule["version"], confirmed=True
    )
    with pytest.raises(DriveSharingError, match="approval_superseded"):
        await permissions.claim_grant(user_id="owner", operation_id=str(operation["operation_id"]))


async def test_foreground_owner_revoked_before_publication_has_no_review_or_grant(live_journey):
    store, _, service, create = live_journey
    item = await create("Requested records")
    owner = AsyncMock()
    owner.side_effect = [None, None, PermissionError("revoked")]
    assert (
        await service(owner).run_one(user_id="owner", request_id=item["requestId"]) == "unavailable"
    )
    assert not rows(store, "drive_share_reviews")
    assert not rows(store, "drive_share_permission_operations")
