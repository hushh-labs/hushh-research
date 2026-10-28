"""Exact provider review is bound before a fresh deletion intent is stored."""

import json
from types import SimpleNamespace
from uuid import uuid4

import pytest

from hushh_mcp.services.account_deletion_inventory_review import (
    ProviderCleanupReviewChanged,
    review_provider_cleanup_in_transaction,
)
from hushh_mcp.services.account_deletion_lifecycle_service import AccountDeletionLifecycleService

REF = "a" * 64
DIGEST = "b" * 64
INVENTORY = {REF: {"revision": "c" * 64, "watchRequired": False}}
DESCRIPTOR = {
    "groupDigest": "d" * 64,
    "revocationSupport": "required",
    "authorityScope": "retain_shared_google",
}


class ReviewConnection:
    def __init__(self, previous=None):
        self.previous = previous
        self.inserts = []

    def execute(self, statement, params=None):
        query = str(statement)
        if "account_provider_cleanup_contract_version" in query:
            return SimpleNamespace(scalar_one=lambda: 2)
        if "FROM account_deletion_tombstones" in query:
            return SimpleNamespace(mappings=lambda: SimpleNamespace(first=lambda: self.previous))
        if "account_provider_cleanup_live_inventory" in query:
            return SimpleNamespace(
                mappings=lambda: SimpleNamespace(
                    one=lambda: {
                        "inventory": {ref: dict(item) for ref, item in INVENTORY.items()},
                        "inventory_sha256": "e" * 64,
                    }
                )
            )
        if "sha256" in query:
            return SimpleNamespace(scalar_one=lambda: DIGEST)
        if "INSERT INTO account_deletion_tombstones" in query:
            self.inserts.append(params)
            return SimpleNamespace()
        raise AssertionError(query)


@pytest.fixture(autouse=True)
def owner_barriers(monkeypatch):
    monkeypatch.setattr(
        AccountDeletionLifecycleService,
        "_lock_user_ids_in_transaction",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        "hushh_mcp.services.account_personal_agent_erasure.assert_external_resources_absent",
        lambda *_args, **_kwargs: None,
    )


def describe(_conn, _owner, inventory):
    return {ref: dict(DESCRIPTOR) for ref in inventory}


def test_review_is_read_only_and_changed_digest_cannot_prepare():
    conn = ReviewConnection()
    review = review_provider_cleanup_in_transaction(
        conn, user_id="owner-1", describe_inventory=describe
    )
    assert review.inventory_sha256 == DIGEST
    assert review.credential_count == 1
    assert review.local_erasure_required is True
    assert conn.inserts == []

    with pytest.raises(ProviderCleanupReviewChanged):
        AccountDeletionLifecycleService.prepare_provider_cleanup_in_transaction(
            conn,
            user_id="owner-1",
            firebase_uid="firebase-1",
            table_exists=lambda *_: True,
            describe_inventory=describe,
            reviewed_inventory_sha256="f" * 64,
            accept_local_erasure=True,
        )
    assert conn.inserts == []


def test_matching_review_records_local_approval_in_initial_receipt():
    conn = ReviewConnection()
    prepared = AccountDeletionLifecycleService.prepare_provider_cleanup_in_transaction(
        conn,
        user_id="owner-1",
        firebase_uid="firebase-1",
        table_exists=lambda *_: True,
        describe_inventory=describe,
        reviewed_inventory_sha256=DIGEST,
        accept_local_erasure=True,
    )
    assert prepared.local_erasure_confirmation_required is False
    assert prepared.credential_count == 1
    receipt = json.loads(conn.inserts[0]["receipt"])
    inventory = json.loads(conn.inserts[0]["inventory"])
    assert receipt["inventorySha256"] == DIGEST
    assert receipt["localErasureAccepted"] is True
    assert inventory[REF]["authorityScope"] == "retain_shared_google"
    assert receipt["items"][REF]["revocation"] == "pending"
    assert "refresh" not in receipt["items"][REF]


def test_existing_unaccepted_operation_is_never_upgraded_by_a_new_click():
    prior_id = uuid4()
    conn = ReviewConnection(
        previous={
            "provider_cleanup_id": prior_id,
            "erasure_phase": "provider_cleanup",
            "provider_cleanup_inventory": {REF: {**INVENTORY[REF], **DESCRIPTOR}},
            "provider_cleanup_receipt": {"localErasureAccepted": False},
            "cleanup_intent_kind": "full_account",
            "firebase_uid": "firebase-1",
            "account_owner_id": "owner-1",
            "provider_cleanup_requested_target": "both",
        }
    )
    prepared = AccountDeletionLifecycleService.prepare_provider_cleanup_in_transaction(
        conn,
        user_id="owner-1",
        firebase_uid="firebase-1",
        table_exists=lambda *_: True,
        describe_inventory=describe,
        reviewed_inventory_sha256=DIGEST,
        accept_local_erasure=True,
    )
    assert prepared.cleanup_id == str(prior_id)
    assert prepared.local_erasure_confirmation_required is True
    assert conn.inserts == []
