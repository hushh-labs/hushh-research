from __future__ import annotations

import hashlib
import inspect
import json
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pydantic import ValidationError

from api.middlewares.rate_limit import limiter
from api.routes.iam import ContactDiscoverabilityRequest
from api.routes.one.connections import ContactSyncBody, ContactSyncLookup, sync_contacts
from hushh_mcp.services.account_service import AccountService
from hushh_mcp.services.connection_graph_service import ConnectionGraphService
from hushh_mcp.services.connections_service import ConnectionsError, ConnectionsService
from hushh_mcp.services.contact_sync_contract import (
    CONTACT_SYNC_CONSENT_CONTRACT_VERSION,
    CONTACT_SYNC_MATCH_POLICY_VERSION,
    CONTACT_SYNC_POLICY_LOCK_NAMESPACE,
    contact_sync_preference_state,
)
from hushh_mcp.services.one_location_agent_service import OneLocationAgentService
from hushh_mcp.services.one_location_circle_service import OneLocationCircleService
from hushh_mcp.services.ria_iam_service import RIAIAMPolicyError, RIAIAMService

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "db" / "migrations" / "175_contact_sync_connection_provenance.sql"
ROLLBACK = (
    ROOT / "db" / "migrations" / "rollback" / "175_contact_sync_connection_provenance.rollback.sql"
)
DIRECTORY_POLICY_MIGRATION = (
    ROOT / "db" / "migrations" / "200_contact_sync_directory_policy_lock.sql"
)
DIRECTORY_POLICY_ROLLBACK = (
    ROOT / "db" / "migrations" / "rollback" / "200_contact_sync_directory_policy_lock.rollback.sql"
)


def _lookup(index: int = 1) -> ContactSyncLookup:
    return ContactSyncLookup(
        lookup_id=f"lookup_{index:04d}",
        hash=f"{index:064x}"[-64:],
        last4=f"{index:04d}"[-4:],
    )


class _ContactSyncService(ConnectionsService):
    def __init__(
        self,
        *,
        target_discoverable: bool = True,
        target_discoverability_by_user: dict[str, bool] | None = None,
        explicit_consent: bool = True,
        consent_contract_version: str = CONTACT_SYNC_CONSENT_CONTRACT_VERSION,
        existing_status: str | None = None,
        existing_status_by_user: dict[str, str | None] | None = None,
        contact_rule_version: int | None = None,
        marketplace_visible: bool | None = None,
        marketplace_visibility_by_user: dict[str, bool | None] | None = None,
        marketplace_display_name_by_user: dict[str, str | None] | None = None,
        identity_display_name_by_user: dict[str, str | None] | None = None,
        missing_profile_users: set[str] | None = None,
        stale_proof: bool = False,
        requester_verified: bool = True,
        ambiguous_proof: bool = False,
    ) -> None:
        super().__init__(notifier=None)
        self.target_discoverable = target_discoverable
        self.target_discoverability_by_user = target_discoverability_by_user or {}
        self.explicit_consent = explicit_consent
        self.consent_contract_version = consent_contract_version
        self.existing_status = existing_status
        self.existing_status_by_user = existing_status_by_user or {}
        self.contact_rule_version = contact_rule_version
        self.marketplace_visible = marketplace_visible
        self.marketplace_visibility_by_user = marketplace_visibility_by_user or {}
        self.marketplace_display_name_by_user = marketplace_display_name_by_user or {}
        self.identity_display_name_by_user = identity_display_name_by_user or {}
        self.missing_profile_users = missing_profile_users or set()
        self.stale_proof = stale_proof
        self.requester_verified = requester_verified
        self.ambiguous_proof = ambiguous_proof
        self.writes: list[tuple] = []
        self.statement_count = 0
        self.transaction_depth = 0
        self.graph_lock_user_ids: set[str] = set()

    @contextmanager
    def _transaction(self):
        self.transaction_depth += 1
        self._transaction_connection = object()
        try:
            yield
        finally:
            self._transaction_connection = None
            self.transaction_depth -= 1

    @staticmethod
    def _target_phone(target_user_id: str) -> str:
        if target_user_id == "target":
            return "+14155550100"
        index = int(target_user_id.rsplit("_", 1)[1])
        return f"+1415{index:07d}"

    def _execute_one(self, sql: str, params=None):
        raise AssertionError(f"unexpected execute_one SQL: {sql}")

    def _execute_many(self, sql: str, params=None):
        self.statement_count += 1
        params = params or {}
        if "LOCK TABLE actor_identity_cache IN SHARE MODE" in sql:
            return []
        if "FROM actor_identity_cache" in sql and "ORDER BY user_id" in sql:
            rows = [
                {
                    "user_id": "requester",
                    "phone_number": "+14155550999",
                    "phone_verified": self.requester_verified,
                    "display_name": "Requester",
                    "photo_url": None,
                    "custom_photo_url": None,
                }
            ]
            for target_user_id in params.get("identity_user_ids") or []:
                if target_user_id == "requester":
                    continue
                phone = self._target_phone(str(target_user_id))
                if self.stale_proof:
                    phone = f"{phone[:-1]}8"
                rows.append(
                    {
                        "user_id": target_user_id,
                        "phone_number": phone,
                        "phone_verified": True,
                        "display_name": self.identity_display_name_by_user.get(
                            str(target_user_id),
                            (
                                "Target Person"
                                if target_user_id == "target"
                                else f"Target {target_user_id}"
                            ),
                        ),
                        "photo_url": "https://example.test/photo.png",
                        "custom_photo_url": None,
                    }
                )
            return rows
        if "correlated_identity AS" in sql and "match_count" in sql:
            rows = []
            lookup_ids = list(params.get("lookup_ids") or [])
            for lookup_id in lookup_ids:
                index = int(str(lookup_id).rsplit("_", 1)[1])
                target_user_id = "target" if len(lookup_ids) == 1 else f"target_{index:04d}"
                rows.append(
                    {
                        "lookup_id": lookup_id,
                        "user_id": target_user_id,
                        "match_count": 2 if self.ambiguous_proof else 1,
                    }
                )
                if self.ambiguous_proof:
                    rows.append(
                        {
                            "lookup_id": lookup_id,
                            "user_id": f"duplicate_{index:04d}",
                            "match_count": 2,
                        }
                    )
            return rows
        if "FROM actor_profiles actor" in sql:
            return [
                {
                    "user_id": target_user_id,
                    "contact_discoverable": self.target_discoverability_by_user.get(
                        str(target_user_id), self.target_discoverable
                    ),
                    "contact_sync_consent_enabled_at": (
                        "2026-08-25T10:00:00+00:00" if self.explicit_consent else None
                    ),
                    "contact_sync_consent_rule_version": (
                        self.contact_rule_version
                        if self.contact_rule_version is not None
                        else (3 if self.explicit_consent else 0)
                    ),
                    "contact_sync_consent_contract_version": (
                        self.consent_contract_version if self.explicit_consent else None
                    ),
                    "marketplace_is_discoverable": self.marketplace_visibility_by_user.get(
                        str(target_user_id), self.marketplace_visible
                    ),
                    "marketplace_display_name": self.marketplace_display_name_by_user.get(
                        str(target_user_id)
                    ),
                }
                for target_user_id in params.get("candidate_user_ids") or []
                if str(target_user_id) not in self.missing_profile_users
            ]
        if "FROM connections connection" in sql:
            rows = []
            for index, target_user_id in enumerate(params.get("candidate_user_ids") or [], start=1):
                status = self.existing_status_by_user.get(str(target_user_id), self.existing_status)
                if status is None:
                    continue
                rows.append(
                    {
                        "id": f"00000000-0000-4000-8000-{index:012d}",
                        "user_a_id": "requester",
                        "user_b_id": target_user_id,
                        "target_user_id": target_user_id,
                        "status": status,
                    }
                )
            return rows
        raise AssertionError(f"unexpected execute_many SQL: {sql}")

    def _join_trusted_system_circles_bulk(self, *, pairs: list[tuple[str, str]]) -> None:
        assert self.transaction_depth == 0
        self.writes.append(("bulk_circle", tuple(pairs)))


def _behavior_sync(
    service: _ContactSyncService,
    *,
    count: int = 1,
    activation_suppressed: bool = False,
):
    lookups: list[dict[str, str]] = []
    matches: list[dict[str, str]] = []
    for index in range(1, count + 1):
        target_user_id = "target" if count == 1 else f"target_{index:04d}"
        phone = service._target_phone(target_user_id)
        digits = "".join(ch for ch in phone if ch in "0123456789")
        lookup_id = f"lookup_{index:04d}"
        lookups.append(
            {
                "lookup_id": lookup_id,
                "hash": hashlib.sha256(f"+{digits}".encode("utf-8")).hexdigest(),
                "last4": digits[-4:],
            }
        )
        matches.append(
            {
                "lookup_id": lookup_id,
                "user_id": target_user_id,
                "display_name": "Untrusted pre-transaction name",
                "photo_url": "https://example.test/untrusted.png",
            }
        )

    def activate(*args, **kwargs):
        service.writes.append(
            (
                "bulk_graph",
                kwargs["requester_user_id"],
                tuple(kwargs["activations"]),
            )
        )
        if activation_suppressed:
            return []
        return sorted({str(activation["target_user_id"]) for activation in kwargs["activations"]})

    def lock_users(*args, **kwargs):
        assert service.transaction_depth == 1
        service.graph_lock_user_ids = {str(user_id) for user_id in kwargs["user_ids"]}

    with (
        patch(
            "hushh_mcp.services.connections_service.activate_contact_sync_connections_bulk",
            side_effect=activate,
        ),
        patch(
            "hushh_mcp.services.connections_service.lock_connection_graph_users",
            side_effect=lock_users,
        ),
    ):
        return service.sync_contact_matches(
            "requester",
            phone_lookups=lookups,
            matches=matches,
        )


def test_sync_wire_is_bounded_and_rejects_ambiguous_proofs() -> None:
    assert ContactSyncBody(lookups=[_lookup()]).lookups[0].lookup_id == "lookup_0001"
    assert ContactSyncBody(lookups=[]).lookups == []
    with pytest.raises(ValidationError):
        ContactSyncBody(lookups=[_lookup(), _lookup()])
    with pytest.raises(ValidationError):
        ContactSyncBody(lookups=[_lookup(index) for index in range(1, 1002)])
    with pytest.raises(ValidationError):
        ContactSyncLookup(
            lookup_id="lookup_short_last4",
            hash="a" * 64,
            last4="123",
        )


def test_sync_service_rejects_noncanonical_last4_proofs() -> None:
    service = _ContactSyncService()
    with pytest.raises(ConnectionsError) as captured:
        service.sync_contact_matches(
            "requester",
            phone_lookups=[
                {
                    "lookup_id": "lookup_0001",
                    "hash": "a" * 64,
                    "last4": "12-34",
                }
            ],
            matches=[{"lookup_id": "lookup_0001", "user_id": "target"}],
        )

    assert captured.value.code == "CONTACT_SYNC_LOOKUP_PROOF_INVALID"
    assert captured.value.status_code == 422
    assert service.writes == []


@pytest.mark.asyncio
async def test_exact_matcher_never_silently_truncates_an_oversized_batch() -> None:
    service = RIAIAMService()

    with pytest.raises(RIAIAMPolicyError) as captured:
        await service.match_one_network_contact_lookups_exact(
            "requester",
            phone_lookups=[
                {
                    "lookup_id": f"lookup_{index:04d}",
                    "hash": f"{index:064x}"[-64:],
                    "last4": f"{index:04d}"[-4:],
                }
                for index in range(1001)
            ],
        )

    assert captured.value.status_code == 422


def test_sync_route_keeps_both_outer_request_limits() -> None:
    route_limits = getattr(limiter, "_route_limits", {})
    limits = [str(item.limit) for item in route_limits["api.routes.one.connections.sync_contacts"]]
    assert any("minute" in limit for limit in limits)
    assert any("day" in limit for limit in limits)


def test_sync_route_hydrates_requester_identity_before_matching() -> None:
    source = inspect.getsource(sync_contacts)
    warmup = "await ActorIdentityService().sync_from_firebase"
    assert warmup in source
    assert source.index(warmup) < source.index("reserve_contact_sync_lookup_budget")
    assert source.index(warmup) < source.index("match_one_network_contact_lookups_exact")


def test_exact_matcher_has_no_candidate_cap_and_returns_no_proof_material() -> None:
    source = inspect.getsource(RIAIAMService.match_one_network_contact_lookups_exact)
    assert "UNNEST" in source
    assert "candidate_row_cap" not in source
    assert "LIMIT $" not in source
    assert "profile.is_discoverable IS DISTINCT FROM FALSE" in source
    assert "COALESCE(actor.contact_sync_consent_rule_version, 0) = 0" in source
    assert "actor.contact_sync_consent_enabled_at IS NULL" in source
    assert "actor.contact_sync_consent_contract_version IS NULL" in source
    assert "actor.contact_sync_consent_contract_version = $5" in source
    assert "EXISTS" in source
    assert "existing_connection.status = 'active'" in source
    assert "existing_connection.user_a_id = $1" in source
    assert "actor.user_id IS NULL" in source
    assert source.index("COUNT(*) OVER") < source.index("LEFT JOIN actor_profiles")
    assert source.index("COUNT(*) OVER") < source.index(
        "profile.is_discoverable IS DISTINCT FROM FALSE"
    )
    response_projection = source.rsplit("return [", 1)[1]
    assert '"lookup_id"' in response_projection
    assert '"hash"' not in response_projection
    assert '"last4"' not in response_projection


def test_sync_revalidates_every_match_and_writes_inside_one_transaction() -> None:
    source = inspect.getsource(ConnectionsService.sync_contact_matches)
    assert "with self._transaction():" in source
    assert "phone_verified" in source
    assert "contact_sync_preference_state" in source
    assert "marketplace.is_discoverable AS marketplace_is_discoverable" in source
    assert "if not proof_valid:" in source
    assert "continue" in source[source.index("if not proof_valid:") :]
    assert "identity_user_ids" in source
    assert "LOCK TABLE actor_identity_cache IN SHARE MODE" in source
    assert source.index("lock_connection_graph_users(") < source.index(
        "FROM connections connection"
    )
    assert source.index("FROM connections connection") < source.index(
        "LOCK TABLE actor_identity_cache IN SHARE MODE"
    )
    assert source.index("LOCK TABLE actor_identity_cache IN SHARE MODE") < source.index(
        "correlated_identity AS"
    )
    assert "COUNT(*) OVER" in source
    assert "unambiguous_target_by_lookup" in source
    assert "FOR UPDATE SKIP LOCKED" not in source
    assert "ORDER BY user_id" in source
    assert "FOR UPDATE" in source
    assert "activate_contact_sync_connections_bulk" in source
    assert "_join_trusted_system_circles_bulk" in source
    assert '"authorization": "verified_phone_directory_match"' in source
    assert "CONTACT_SYNC_MATCH_POLICY_VERSION" in source
    assert 'existing_status == "revoked"' in source
    assert 'existing_status == "active"' in source
    assert "activation_required_target_ids" in source
    assert "create_grant" not in source
    assert "scope_proposal" not in source
    assert 'outcome = "request_required"' not in source
    for outcome in ("auto_connected", "already_connected", "suppressed"):
        assert outcome in source

    graph_source = inspect.getsource(ConnectionGraphService.activate_contact_sync_pairs)
    assert "FROM connection_scope_proposals proposal" in graph_source
    assert "proposal.status = 'pending'" in graph_source
    assert "NOT EXISTS" in graph_source


def test_behavior_auto_connect_materializes_only_canonical_projections() -> None:
    service = _ContactSyncService()
    result = _behavior_sync(service)

    assert result["items"] == [
        {
            "lookupId": "lookup_0001",
            "userId": "target",
            "displayName": "Target Person",
            "photoUrl": "https://example.test/photo.png",
            "outcome": "auto_connected",
        }
    ]
    assert result["indeterminateLookupIds"] == []
    assert service.writes == [
        (
            "bulk_graph",
            "requester",
            (
                {
                    "target_user_id": "target",
                    "origin_metadata": {
                        "authorization": "verified_phone_directory_match",
                        "matchPolicyVersion": CONTACT_SYNC_MATCH_POLICY_VERSION,
                        "targetPreferenceState": "enabled",
                    },
                },
            ),
        ),
        ("bulk_circle", (("requester", "target"),)),
    ]
    assert service.graph_lock_user_ids == {"requester", "target"}
    assert not any("grant" in write for row in service.writes for write in row)


def test_behavior_mutation_time_ambiguous_phone_proof_writes_nothing() -> None:
    service = _ContactSyncService(ambiguous_proof=True)

    result = _behavior_sync(service)

    assert result["matchedCount"] == 0
    assert result["autoConnectedCount"] == 0
    assert result["items"] == []
    assert result["indeterminateLookupIds"] == ["lookup_0001"]
    assert service.writes == []


def test_behavior_missing_profile_uses_verified_directory_default() -> None:
    service = _ContactSyncService(
        explicit_consent=False,
        missing_profile_users={"target"},
    )

    result = _behavior_sync(service)

    assert result["matchedCount"] == 1
    assert result["autoConnectedCount"] == 1
    assert result["items"][0]["outcome"] == "auto_connected"
    metadata = service.writes[0][2][0]["origin_metadata"]
    assert metadata == {
        "authorization": "verified_phone_directory_match",
        "matchPolicyVersion": CONTACT_SYNC_MATCH_POLICY_VERSION,
        "targetPreferenceState": "default",
    }


def test_behavior_concurrent_disconnect_tombstone_suppresses_downstream_writes() -> None:
    service = _ContactSyncService()

    result = _behavior_sync(service, activation_suppressed=True)

    assert result["matchedCount"] == 1
    assert result["autoConnectedCount"] == 0
    assert result["suppressedCount"] == 1
    assert result["items"][0]["outcome"] == "suppressed"
    assert [write[0] for write in service.writes] == ["bulk_graph"]


def test_behavior_directory_default_without_explicit_consent_auto_connects() -> None:
    service = _ContactSyncService(explicit_consent=False)
    result = _behavior_sync(service)

    assert result["matchedCount"] == 1
    assert result["autoConnectedCount"] == 1
    assert result["items"][0]["outcome"] == "auto_connected"
    assert service.writes[0][2][0]["origin_metadata"]["targetPreferenceState"] == "default"


def test_behavior_explicitly_hidden_target_writes_nothing() -> None:
    service = _ContactSyncService(
        target_discoverable=False,
        explicit_consent=False,
        contact_rule_version=1,
    )
    result = _behavior_sync(service)

    assert result["items"] == []
    assert result["matchedCount"] == 0
    assert result["indeterminateLookupIds"] == ["lookup_0001"]
    assert service.writes == []


def test_behavior_hidden_active_connection_is_recognized_without_new_provenance() -> None:
    service = _ContactSyncService(
        target_discoverable=False,
        explicit_consent=False,
        contact_rule_version=1,
        existing_status="active",
    )

    result = _behavior_sync(service)

    assert result["matchedCount"] == 1
    assert result["alreadyConnectedCount"] == 1
    assert result["items"][0]["outcome"] == "already_connected"
    assert result["indeterminateLookupIds"] == []
    assert service.writes == []


def test_behavior_missing_profile_keeps_active_connection_and_adds_default_provenance() -> None:
    service = _ContactSyncService(
        explicit_consent=False,
        existing_status="active",
        missing_profile_users={"target"},
    )

    result = _behavior_sync(service)

    assert result["matchedCount"] == 1
    assert result["alreadyConnectedCount"] == 1
    assert result["items"][0]["outcome"] == "already_connected"
    assert result["indeterminateLookupIds"] == []
    assert service.writes[0][2][0]["origin_metadata"] == {
        "authorization": "verified_phone_directory_match",
        "matchPolicyVersion": CONTACT_SYNC_MATCH_POLICY_VERSION,
        "targetPreferenceState": "default",
    }


def test_behavior_hidden_revoked_connection_remains_undisclosed() -> None:
    service = _ContactSyncService(
        target_discoverable=False,
        explicit_consent=False,
        contact_rule_version=1,
        existing_status="revoked",
    )

    result = _behavior_sync(service)

    assert result["matchedCount"] == 0
    assert result["items"] == []
    assert result["indeterminateLookupIds"] == ["lookup_0001"]
    assert service.writes == []


@pytest.mark.parametrize("proof_failure", ["stale", "ambiguous"])
def test_behavior_hidden_active_connection_still_requires_unique_current_phone_proof(
    proof_failure: str,
) -> None:
    service = _ContactSyncService(
        target_discoverable=False,
        explicit_consent=False,
        contact_rule_version=1,
        existing_status="active",
        stale_proof=proof_failure == "stale",
        ambiguous_proof=proof_failure == "ambiguous",
    )

    result = _behavior_sync(service)

    assert result["matchedCount"] == 0
    assert result["items"] == []
    assert result["indeterminateLookupIds"] == ["lookup_0001"]
    assert service.writes == []


def test_behavior_mixed_hidden_active_and_new_consented_match_preserves_both() -> None:
    service = _ContactSyncService(
        target_discoverability_by_user={"target_0001": False},
        existing_status_by_user={"target_0001": "active"},
    )

    result = _behavior_sync(service, count=2)

    assert [(item["userId"], item["outcome"]) for item in result["items"]] == [
        ("target_0001", "already_connected"),
        ("target_0002", "auto_connected"),
    ]
    assert result["matchedCount"] == 2
    assert result["alreadyConnectedCount"] == 1
    assert result["autoConnectedCount"] == 1
    assert service.writes == [
        (
            "bulk_graph",
            "requester",
            (
                {
                    "target_user_id": "target_0002",
                    "origin_metadata": {
                        "authorization": "verified_phone_directory_match",
                        "matchPolicyVersion": CONTACT_SYNC_MATCH_POLICY_VERSION,
                        "targetPreferenceState": "enabled",
                    },
                },
            ),
        ),
        ("bulk_circle", (("requester", "target_0002"),)),
    ]


def test_behavior_two_existing_connections_and_one_directory_default_match_all_three() -> None:
    service = _ContactSyncService(
        explicit_consent=False,
        existing_status_by_user={
            "target_0001": "active",
            "target_0002": "active",
        },
    )

    result = _behavior_sync(service, count=3)

    assert [(item["userId"], item["outcome"]) for item in result["items"]] == [
        ("target_0001", "already_connected"),
        ("target_0002", "already_connected"),
        ("target_0003", "auto_connected"),
    ]
    assert result["matchedCount"] == 3
    assert result["alreadyConnectedCount"] == 2
    assert result["autoConnectedCount"] == 1
    assert {activation["target_user_id"] for activation in service.writes[0][2]} == {
        "target_0001",
        "target_0002",
        "target_0003",
    }
    assert all(
        activation["origin_metadata"]["targetPreferenceState"] == "default"
        for activation in service.writes[0][2]
    )


def test_behavior_removed_directory_matches_remain_visible_but_suppressed() -> None:
    service = _ContactSyncService(
        explicit_consent=False,
        existing_status_by_user={
            "target_0001": "revoked",
            "target_0002": "revoked",
            "target_0003": "active",
        },
    )

    result = _behavior_sync(service, count=3)

    assert [(item["userId"], item["outcome"]) for item in result["items"]] == [
        ("target_0001", "suppressed"),
        ("target_0002", "suppressed"),
        ("target_0003", "already_connected"),
    ]
    assert result["matchedCount"] == 3
    assert result["suppressedCount"] == 2
    assert result["alreadyConnectedCount"] == 1
    assert [activation["target_user_id"] for activation in service.writes[0][2]] == ["target_0003"]


def test_behavior_marketplace_hidden_directory_target_is_not_disclosed() -> None:
    service = _ContactSyncService(marketplace_visible=False)

    result = _behavior_sync(service)

    assert result["matchedCount"] == 0
    assert result["items"] == []
    assert result["indeterminateLookupIds"] == ["lookup_0001"]
    assert service.writes == []


def test_behavior_marketplace_name_fallback_survives_transaction_revalidation() -> None:
    service = _ContactSyncService(
        identity_display_name_by_user={"target": None},
        marketplace_display_name_by_user={"target": "Kushal"},
    )

    result = _behavior_sync(service)

    assert result["items"][0]["displayName"] == "Kushal"


def test_behavior_stale_consent_contract_writes_nothing() -> None:
    service = _ContactSyncService(consent_contract_version="findability_only_v0")
    result = _behavior_sync(service)

    assert result["items"] == []
    assert result["matchedCount"] == 0
    assert result["indeterminateLookupIds"] == ["lookup_0001"]
    assert service.writes == []


def test_behavior_revoked_pair_is_suppressed_and_not_resurrected() -> None:
    service = _ContactSyncService(existing_status="revoked")
    result = _behavior_sync(service)

    assert result["items"][0]["outcome"] == "suppressed"
    assert service.writes == []


def test_behavior_stale_proof_is_omitted_and_writes_nothing() -> None:
    service = _ContactSyncService(stale_proof=True)
    result = _behavior_sync(service)

    assert result["matchedCount"] == 0
    assert result["items"] == []
    assert result["indeterminateLookupIds"] == ["lookup_0001"]
    assert service.writes == []


def test_behavior_unverified_requester_is_rejected_before_any_write() -> None:
    service = _ContactSyncService(requester_verified=False)

    with pytest.raises(ConnectionsError) as captured:
        _behavior_sync(service)

    assert captured.value.code == "CONTACT_SYNC_REQUESTER_PHONE_VERIFICATION_REQUIRED"
    assert captured.value.status_code == 403
    assert service.writes == []


def test_behavior_existing_connection_gets_idempotent_directory_provenance() -> None:
    service = _ContactSyncService(existing_status="active")
    first = _behavior_sync(service)
    second = _behavior_sync(service)

    assert first["items"][0]["outcome"] == "already_connected"
    assert second["items"][0]["outcome"] == "already_connected"
    graph_writes = [write for write in service.writes if write[0] == "bulk_graph"]
    assert graph_writes == [
        (
            "bulk_graph",
            "requester",
            (
                {
                    "target_user_id": "target",
                    "origin_metadata": {
                        "authorization": "verified_phone_directory_match",
                        "matchPolicyVersion": CONTACT_SYNC_MATCH_POLICY_VERSION,
                        "targetPreferenceState": "enabled",
                    },
                },
            ),
        ),
        (
            "bulk_graph",
            "requester",
            (
                {
                    "target_user_id": "target",
                    "origin_metadata": {
                        "authorization": "verified_phone_directory_match",
                        "matchPolicyVersion": CONTACT_SYNC_MATCH_POLICY_VERSION,
                        "targetPreferenceState": "enabled",
                    },
                },
            ),
        ),
    ]


def test_behavior_one_thousand_matches_use_bounded_batch_seams() -> None:
    service = _ContactSyncService()
    result = _behavior_sync(service, count=1000)

    assert result["matchedCount"] == 1000
    assert result["autoConnectedCount"] == 1000
    assert len(result["items"]) == 1000
    assert service.statement_count == 5
    assert [write[0] for write in service.writes] == ["bulk_graph", "bulk_circle"]
    assert len(service.graph_lock_user_ids) == 1001
    assert {"requester", "target_0001", "target_1000"} <= service.graph_lock_user_ids
    assert len(service.writes[0][2]) == 1000
    assert len(service.writes[1][1]) == 1000


def test_bulk_projection_helpers_have_constant_statement_counts() -> None:
    graph_source = inspect.getsource(ConnectionGraphService.activate_contact_sync_pairs)
    circle_source = inspect.getsource(OneLocationCircleService.ensure_trusted_memberships_for_pairs)

    assert graph_source.count("conn.execute(") == 4
    assert circle_source.count("conn.execute(") == 3
    assert "UNNEST" in graph_source
    assert "UNNEST" in circle_source
    assert "eligible_pairs AS" in circle_source
    assert "connection.status = 'active'" in circle_source
    assert "origin.status = 'active'" in circle_source
    assert "origin.origin_kind <> 'named_circle'" in circle_source
    assert "contact_sync:" in graph_source
    assert "trusted_connections" in graph_source
    assert "connection_requests" in graph_source
    assert "WHEN connection_origins.status = 'active'" in graph_source
    assert "ON CONFLICT (connection_id, origin_key)" in graph_source
    assert "WHERE connections.status = 'active'" in graph_source
    assert "RETURNING CASE" in graph_source
    assert "return activated_targets" in graph_source
    assert "one_location_share_grants" not in circle_source


def test_requester_phone_and_weighted_postgres_budget_are_fail_closed() -> None:
    source = inspect.getsource(ConnectionsService.reserve_contact_sync_lookup_budget)
    assert "phone_verified = TRUE" in source
    assert "CONTACT_SYNC_REQUESTER_PHONE_VERIFICATION_REQUIRED" in source
    assert "contact_sync_lookup_budgets" in source
    assert "CONTACT_SYNC_MINUTE_LOOKUP_LIMIT" in source
    assert "CONTACT_SYNC_DAY_LOOKUP_LIMIT" in source
    assert "CONTACT_SYNC_LOOKUP_BUDGET_EXCEEDED" in source


@pytest.mark.parametrize(
    (
        "stored_enabled",
        "enabled_at",
        "rule_version",
        "contract_version",
        "marketplace_visible",
        "preference_state",
        "effective_enabled",
    ),
    [
        (None, None, None, None, None, "default", True),
        (False, None, 0, None, True, "default", True),
        (False, None, 0, None, False, "default", False),
        (False, None, 1, None, True, "disabled", False),
        (
            True,
            "2026-09-05T00:00:00Z",
            1,
            CONTACT_SYNC_CONSENT_CONTRACT_VERSION,
            True,
            "enabled",
            True,
        ),
        (
            True,
            "2026-09-05T00:00:00Z",
            1,
            CONTACT_SYNC_CONSENT_CONTRACT_VERSION,
            False,
            "enabled",
            False,
        ),
        (True, None, 1, CONTACT_SYNC_CONSENT_CONTRACT_VERSION, True, "invalid", False),
        (True, "2026-09-05T00:00:00Z", 1, "stale_contract", True, "invalid", False),
    ],
)
@pytest.mark.asyncio
async def test_contact_preference_response_combines_directory_and_explicit_choice(
    stored_enabled,
    enabled_at,
    rule_version,
    contract_version,
    marketplace_visible,
    preference_state,
    effective_enabled,
) -> None:
    conn = AsyncMock()
    conn.fetchrow.return_value = {
        "contact_discoverable": stored_enabled,
        "contact_sync_consent_enabled_at": enabled_at,
        "contact_sync_consent_rule_version": rule_version,
        "contact_sync_consent_contract_version": contract_version,
        "marketplace_is_discoverable": marketplace_visible,
    }
    service = RIAIAMService()
    with (
        patch.object(service, "_conn", AsyncMock(return_value=conn)),
        patch.object(service, "_ensure_iam_schema_ready", AsyncMock()),
    ):
        result = await service.get_contact_discoverability("target")

    assert result["contact_discoverable"] is effective_enabled
    assert result["stored_contact_discoverable"] is bool(stored_enabled)
    assert result["contact_sync_preference_state"] == preference_state
    assert result["contact_sync_consent_enabled_at"] == enabled_at
    assert result["contact_sync_consent_contract_version"] == contract_version
    assert result["directory_visible"] is (marketplace_visible is not False)
    assert result["contact_sync_match_policy_version"] == CONTACT_SYNC_MATCH_POLICY_VERSION
    assert result["iam_schema_ready"] is True
    conn.close.assert_awaited_once()


@pytest.mark.parametrize(
    ("enabled", "marketplace_visible", "effective_enabled"),
    [(False, None, False), (True, None, True), (True, False, False)],
)
@pytest.mark.asyncio
async def test_contact_preference_write_reports_effective_directory_visibility(
    enabled: bool,
    marketplace_visible: bool | None,
    effective_enabled: bool,
) -> None:
    conn = AsyncMock()
    conn.transaction = MagicMock()
    conn.fetchrow.side_effect = [
        {
            "user_id": "target",
            "contact_discoverable": enabled,
            "contact_sync_consent_enabled_at": "2026-09-05T00:00:00Z" if enabled else None,
            "contact_sync_consent_rule_version": 1,
            "contact_sync_consent_contract_version": (
                CONTACT_SYNC_CONSENT_CONTRACT_VERSION if enabled else None
            ),
        },
        None if marketplace_visible is None else {"is_discoverable": marketplace_visible},
    ]
    service = RIAIAMService()
    with (
        patch.object(service, "_conn", AsyncMock(return_value=conn)),
        patch.object(service, "_ensure_vault_user_row", AsyncMock()),
        patch.object(service, "_ensure_iam_schema_ready", AsyncMock()),
    ):
        result = await service.set_contact_discoverability(
            "target",
            enabled,
            consent_version=CONTACT_SYNC_CONSENT_CONTRACT_VERSION if enabled else None,
        )

    assert result["contact_discoverable"] is effective_enabled
    assert result["stored_contact_discoverable"] is enabled
    assert result["contact_sync_preference_state"] == ("enabled" if enabled else "disabled")
    assert result["directory_visible"] is (marketplace_visible is not False)
    assert result["contact_sync_match_policy_version"] == CONTACT_SYNC_MATCH_POLICY_VERSION
    conn.execute.assert_awaited_once_with(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
        "target",
        CONTACT_SYNC_POLICY_LOCK_NAMESPACE,
    )
    conn.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_contact_sync_directory_default_and_explicit_choice_are_versioned() -> None:
    source = inspect.getsource(RIAIAMService.set_contact_discoverability)
    getter = inspect.getsource(RIAIAMService.get_contact_discoverability)
    assert "contact_discoverable = $2" in source
    assert "contact_sync_consent_enabled_at" in source
    assert "contact_sync_consent_rule_version + 1" in source
    assert "CASE WHEN $2 THEN NOW() ELSE NULL END" in source
    assert "CONTACT_SYNC_CONSENT_CONTRACT_VERSION" in source
    assert "contact_sync_consent_contract_version" in source
    assert "contact_sync_preference_state" in getter
    assert "CONTACT_SYNC_MATCH_POLICY_VERSION" in getter
    assert "marketplace_is_discoverable" in getter

    assert (
        contact_sync_preference_state(
            discoverable=False,
            enabled_at=None,
            rule_version=0,
            contract_version=None,
        )
        == "default"
    )
    assert (
        contact_sync_preference_state(
            discoverable=False,
            enabled_at=None,
            rule_version=2,
            contract_version=None,
        )
        == "disabled"
    )
    assert (
        contact_sync_preference_state(
            discoverable=True,
            enabled_at="2026-09-05T00:00:00Z",
            rule_version=2,
            contract_version="stale_contract",
        )
        == "invalid"
    )
    assert (
        contact_sync_preference_state(
            discoverable=False,
            enabled_at=None,
            rule_version=0,
            contract_version="",
        )
        == "invalid"
    )
    assert (
        contact_sync_preference_state(
            discoverable=True,
            enabled_at="2026-09-05T00:00:00Z",
            rule_version=2,
            contract_version=f" {CONTACT_SYNC_CONSENT_CONTRACT_VERSION} ",
        )
        == "invalid"
    )

    # A cached findability-only client sends no marker. The service rejects it
    # before opening a DB connection, so old UI copy cannot broaden authority.
    assert ContactDiscoverabilityRequest(enabled=True).consent_version is None
    with pytest.raises(RIAIAMPolicyError) as captured:
        await RIAIAMService().set_contact_discoverability(
            "target",
            True,
            consent_version=None,
        )
    assert captured.value.status_code == 409


def test_contact_only_pair_reuses_canonical_all_contacts_auto_approval() -> None:
    source = inspect.getsource(OneLocationAgentService.approve_request)
    assert "LOCATION_AUTO_APPROVE_CONTACT_SYNC_REQUIRES_APPROVAL" not in source
    assert 'active_origin_kinds == {"contact_sync"}' not in source


def test_migration_registers_combined_consent_provenance_budget_and_safe_rollback() -> None:
    migration = MIGRATION.read_text(encoding="utf-8")
    rollback = ROLLBACK.read_text(encoding="utf-8")
    manifest = json.loads((ROOT / "db" / "release_migration_manifest.json").read_text())

    assert "contact_sync_consent_enabled_at TIMESTAMPTZ" in migration
    assert "contact_sync_consent_rule_version BIGINT NOT NULL DEFAULT 0" in migration
    assert "contact_sync_consent_contract_version TEXT" in migration
    assert CONTACT_SYNC_CONSENT_CONTRACT_VERSION in migration
    assert "contact_discoverable SET DEFAULT FALSE" in migration
    assert "legacy row therefore fails closed" in migration
    assert "'contact_sync:' || source_ref" in migration
    assert "contact_sync_lookup_budgets" in migration
    assert "phone_number" not in migration
    assert "contact_hash" not in migration
    assert "contact_sync_rollback_connections" in rollback
    lock_marker = "IN EXCLUSIVE MODE NOWAIT"
    assert lock_marker in rollback
    assert rollback.index(lock_marker) < rollback.index(
        "CREATE TEMP TABLE contact_sync_rollback_connections"
    )
    for locked_table in (
        "actor_identity_cache",
        "actor_profiles",
        "connections",
        "connection_origins",
        "trusted_connections",
        "one_location_circles",
        "one_location_circle_memberships",
    ):
        assert locked_table in rollback[: rollback.index(lock_marker)]
    assert "NOT EXISTS (" in rollback
    assert "affected.contact_only" in rollback
    assert "UPDATE trusted_connections" in rollback
    assert "UPDATE one_location_circle_memberships" in rollback
    assert "status = 'revoked'" in rollback
    assert "status = 'removed'" in rollback
    assert "contact_sync_rollback" in rollback
    assert "rolledBackFrom', 'contact_sync'" not in rollback
    assert "origin.origin_kind = 'direct_request'" in rollback
    assert "origin.origin_kind IN ('circle_member', 'legacy_invite')" in rollback
    assert "THEN 'request'" in rollback
    assert "THEN 'circle_invite'" in rollback
    assert "175_contact_sync_connection_provenance.sql" in manifest["ordered_migrations"]
    assert "175_contact_sync_connection_provenance.sql" in manifest["groups"]["iam"]
    for contract_name in (
        "dev_minimum_schema",
        "prod_core_schema",
        "uat_integrated_schema",
    ):
        contract = json.loads((ROOT / "db" / "contracts" / f"{contract_name}.json").read_text())
        assert contract["contract_name"] == contract_name
        assert contract["required_tables"]["contact_sync_lookup_budgets"] == [
            "user_id",
            "bucket_kind",
            "bucket_start",
            "lookup_count",
            "updated_at",
        ]


def test_directory_policy_writers_share_the_graph_user_lock() -> None:
    migration = DIRECTORY_POLICY_MIGRATION.read_text(encoding="utf-8")
    rollback = DIRECTORY_POLICY_ROLLBACK.read_text(encoding="utf-8")
    manifest = json.loads((ROOT / "db" / "release_migration_manifest.json").read_text())
    graph_source = inspect.getsource(ConnectionGraphService.activate_contact_sync_pairs)
    setter_source = inspect.getsource(RIAIAMService.set_contact_discoverability)

    assert f"hashtextextended(affected_user_id, {CONTACT_SYNC_POLICY_LOCK_NAMESPACE})" in migration
    assert "actor_profiles_contact_sync_policy_lock" in migration
    assert "marketplace_profiles_contact_sync_policy_lock" in migration
    assert "UPDATE OF\n  contact_discoverable" in migration
    assert "UPDATE OF is_discoverable" in migration
    assert "pg_advisory_xact_lock(hashtextextended($1, $2))" in setter_source
    assert "CONTACT_SYNC_POLICY_LOCK_NAMESPACE" in setter_source
    assert setter_source.index("CONTACT_SYNC_POLICY_LOCK_NAMESPACE,") < setter_source.index(
        "await self._ensure_vault_user_row"
    )
    assert "WHERE connections.status = 'active'" in graph_source
    assert "DROP FUNCTION IF EXISTS lock_contact_sync_directory_policy_user" in rollback
    assert "200_contact_sync_directory_policy_lock.sql" in manifest["ordered_migrations"]
    assert "200_contact_sync_directory_policy_lock.sql" in manifest["groups"]["iam"]


def test_directory_policy_locks_explicit_inserts_without_locking_default_hydration() -> None:
    migration = DIRECTORY_POLICY_MIGRATION.read_text(encoding="utf-8")
    rollback = DIRECTORY_POLICY_ROLLBACK.read_text(encoding="utf-8")
    insert_trigger = migration.split(
        "CREATE TRIGGER actor_profiles_contact_sync_policy_insert_lock", 1
    )[1].split("EXECUTE FUNCTION", 1)[0]

    assert "BEFORE INSERT ON actor_profiles" in insert_trigger
    assert "FOR EACH ROW\nWHEN (" in insert_trigger
    assert "NEW.contact_sync_consent_rule_version IS DISTINCT FROM 0" in insert_trigger
    assert "OR NEW.contact_sync_consent_enabled_at IS NOT NULL" in insert_trigger
    assert "OR NEW.contact_sync_consent_contract_version IS NOT NULL" in insert_trigger
    assert "actor_profiles_contact_sync_policy_insert_lock" in rollback
    assert rollback.index("actor_profiles_contact_sync_policy_insert_lock") < rollback.index(
        "DROP FUNCTION IF EXISTS lock_contact_sync_directory_policy_user"
    )


def test_account_deletion_explicitly_purges_the_fk_free_abuse_budget() -> None:
    query = str(AccountService()._delete_by_user_queries["contact_sync_lookup_budgets"])
    assert "DELETE FROM contact_sync_lookup_budgets WHERE user_id = :user_id" in query
    full_delete_source = inspect.getsource(AccountService._delete_full_account)
    reset_source = inspect.getsource(AccountService._clear_user_data_tables)
    assert '"contact_sync_lookup_budgets"' in full_delete_source
    assert '"contact_sync_lookup_budgets"' not in reset_source


def test_ria_profile_deletion_preserves_contact_sync_lock_order() -> None:
    source = inspect.getsource(RIAIAMService.delete_ria_self_profile)

    assert "_ensure_actor_profile_row" not in source
    assert source.index("DELETE FROM actor_identity_cache") < source.index("UPDATE actor_profiles")


def test_read_models_expose_only_viewer_relative_contact_provenance() -> None:
    service_source = inspect.getsource(ConnectionsService.list_connections)
    location_source = inspect.getsource(OneLocationAgentService.list_verified_recipients)
    circle_source = (ROOT / "hushh_mcp" / "services" / "one_location_circle_service.py").read_text(
        encoding="utf-8"
    )

    assert "connectedFromContacts" in service_source
    assert "contact_origin.source_ref = :user_id" in service_source
    assert "connected_from_contacts" in location_source
    assert "contact_origin.source_ref = :owner_user_id" in location_source
    assert '"connectedFromContacts"' in circle_source
    assert "contact_origin.source_ref = :viewer_user_id" in circle_source
    assert "contact_origin.source_ref = :actor_user_id" in circle_source
