import json
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from hushh_mcp.services.account_service import (
    PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE,
    TRANSACTIONAL_ACCOUNT_ERASURE_TABLES,
    AccountService,
)

REPO_ROOT = Path(__file__).resolve().parents[3]


@contextmanager
def _db(conn):
    yield conn


def test_delete_user_rows_if_table_exists_supports_pkm_data(monkeypatch):
    service = AccountService()
    conn = MagicMock()
    params = {"user_id": "user_123"}

    monkeypatch.setattr(service, "_table_exists", lambda _conn, _table: True)

    service._delete_user_rows_if_table_exists(conn, table_name="pkm_data", params=params)

    conn.execute.assert_called_once_with(service._delete_by_user_queries["pkm_data"], params)


def test_delete_user_rows_if_table_exists_skips_missing_table(monkeypatch):
    service = AccountService()
    conn = MagicMock()

    monkeypatch.setattr(service, "_table_exists", lambda _conn, _table: False)

    service._delete_user_rows_if_table_exists(
        conn,
        table_name="pkm_data",
        params={"user_id": "user_123"},
    )

    conn.execute.assert_not_called()


def test_delete_user_rows_if_table_exists_rejects_unsupported_table(monkeypatch):
    service = AccountService()

    monkeypatch.setattr(service, "_table_exists", lambda _conn, _table: True)

    with pytest.raises(ValueError, match="Unsafe or unsupported cleanup table requested"):
        service._delete_user_rows_if_table_exists(
            MagicMock(),
            table_name="unsafe_table",
            params={"user_id": "user_123"},
        )


@pytest.mark.asyncio
async def test_full_account_delete_forwards_only_authenticated_uid(monkeypatch):
    service = AccountService()
    captured = {}

    monkeypatch.setattr(
        service,
        "_load_actor_profile",
        lambda _user_id: {"personas": ["investor"], "investor_marketplace_opt_in": False},
    )

    async def _full_delete(
        user_id,
        *,
        requested_target,
    ):
        captured["user_id"] = user_id
        captured["target"] = requested_target
        return {"success": True, "account_deleted": True}

    monkeypatch.setattr(service, "_delete_full_account", _full_delete)

    result = await service.delete_account(
        "user_123",
        target="both",
    )

    assert result["account_deleted"] is True
    assert captured == {
        "user_id": "user_123",
        "target": "both",
    }


@pytest.mark.asyncio
async def test_persona_only_delete_does_not_run_full_account_delete(monkeypatch):
    service = AccountService()

    monkeypatch.setattr(
        service,
        "_load_actor_profile",
        lambda _user_id: {
            "personas": ["investor", "ria"],
            "investor_marketplace_opt_in": False,
        },
    )

    async def _delete_investor(**_kwargs):
        return {"success": True, "account_deleted": False}

    async def _unexpected_full_delete(*_args, **_kwargs):
        pytest.fail("persona-only cleanup must not invoke full-account deletion")

    monkeypatch.setattr(service, "_delete_investor_persona", _delete_investor)
    monkeypatch.setattr(service, "_delete_full_account", _unexpected_full_delete)

    result = await service.delete_account(
        "user_123",
        target="investor",
    )

    assert result["account_deleted"] is False


@pytest.mark.asyncio
async def test_full_account_deletion_covers_account_owned_tables(monkeypatch):
    service = AccountService()
    conn = MagicMock()
    user_id = "user_delete_123"

    monkeypatch.setattr(service, "_table_exists", lambda _conn, _table: True)

    def _delete_personal_agent_state(_conn, *, params, results):
        for table_name in (
            "byoc_setup_jobs",
            "pod_lifecycle_events",
            "personal_agent_registry",
        ):
            _conn.execute(service._delete_by_user_queries[table_name], params)
            results[table_name] = True
        results["personal_agent_external_resources_absent"] = True

    monkeypatch.setattr(service, "_delete_personal_agent_state", _delete_personal_agent_state)

    with patch("hushh_mcp.services.account_service.get_db_connection", return_value=_db(conn)):
        result = await service._delete_full_account(
            user_id,
            requested_target="both",
        )

    assert result["success"] is True
    assert result["account_deleted"] is True
    assert result["details"]["one_location_circle_member_invites"] is True
    assert result["details"]["connection_origins"] is True
    assert result["details"]["contact_sync_lookup_budgets"] is True
    assert result["details"]["kai_analyze_runs"] is True
    assert result["details"]["one_location_map_preferences"] is True
    assert result["details"]["one_location_network_connections"] is True
    assert result["details"]["one_location_visibility_preferences"] is True
    assert result["details"]["one_location_visibility_exclusions"] is True
    assert result["details"]["kai_location_referrals"] is True
    assert result["details"]["byoc_setup_jobs"] is True
    assert result["details"]["pod_lifecycle_events"] is True
    assert result["details"]["personal_agent_registry"] is True
    assert result["details"]["personal_agent_external_resources_absent"] is True
    assert result["details"]["ria_pick_legacy_retirements"] is True
    assert result["details"]["developer_apps"] is True
    assert result["details"]["pwm_documents"] is True
    assert result["details"]["fabric_subscription_grants"] is True
    assert result["details"]["fabric_consent_requests"] is True
    assert result["details"]["marketplace_delivery_envelopes"] is True
    assert result["details"]["marketplace_access_requests"] is True
    assert result["details"]["marketplace_recipient_keys"] is True
    assert result["details"]["marketplace_opportunity_signals"] is True
    assert result["details"]["one_referral_relationships"] is True
    assert result["details"]["one_referral_attributions"] is True
    assert result["details"]["one_referral_codes"] is True
    assert result["details"]["feed_events"] is True
    assert result["details"]["account_deletion_tombstone"] is True
    assert result["details"]["firebase_cleanup_intent_count"] == 1

    executed_sql = "\n".join(str(call.args[0]) for call in conn.execute.call_args_list)
    assert "INSERT INTO account_deletion_tombstones" in executed_sql
    assert executed_sql.count("INSERT INTO account_deletion_tombstones") == 1
    first_insert_offset = next(
        index
        for index, call in enumerate(conn.execute.call_args_list)
        if "INSERT INTO account_deletion_tombstones" in str(call.args[0])
    )
    pre_insert_sql = "\n".join(
        str(call.args[0]) for call in conn.execute.call_args_list[:first_insert_offset]
    )
    assert first_insert_offset == 3
    assert pre_insert_sql.count("pg_advisory_xact_lock") == 3
    assert conn.execute.call_args_list[0].args[1] == {"lock_key": "fabric_receipts:user_delete_123"}
    first_delete_offset = executed_sql.index("DELETE FROM")
    assert executed_sql.index("INSERT INTO account_deletion_tombstones") < first_delete_offset
    expected_fragments = [
        "DELETE FROM contact_sync_lookup_budgets",
        "DELETE FROM kai_funding_trade_events",
        "DELETE FROM kai_funding_trade_intents",
        "DELETE FROM kai_funding_transfer_events",
        "DELETE FROM kai_funding_transfers",
        "DELETE FROM kai_funding_ach_relationships",
        "DELETE FROM kai_funding_plaid_accounts",
        "DELETE FROM kai_funding_plaid_items",
        "DELETE FROM kai_funding_brokerage_accounts",
        "DELETE FROM kai_funding_alpaca_connect_sessions",
        "DELETE FROM kai_gmail_receipts",
        "DELETE FROM kai_gmail_sync_runs",
        "DELETE FROM kai_gmail_connections",
        "DELETE FROM kai_analyze_runs",
        "DELETE FROM consent_export_refresh_jobs",
        "DELETE FROM consent_exports",
        "DELETE FROM connected_system_audit_events",
        "DELETE FROM connected_system_record_bindings",
        "DELETE FROM connected_system_intents",
        "DELETE FROM connected_system_owner_signing_keys",
        "DELETE FROM connected_system_zk_contexts",
        "DELETE FROM fabric_consent_requests",
        "DELETE FROM fabric_subscription_grants",
        "DELETE FROM pwm_documents",
        "DELETE FROM marketplace_delivery_envelopes",
        "DELETE FROM marketplace_access_requests",
        "DELETE FROM marketplace_recipient_keys",
        "DELETE FROM marketplace_opportunity_signals",
        "DELETE FROM one_referral_risk_reviews",
        "DELETE FROM one_referral_events",
        "DELETE FROM one_referral_relationships",
        "DELETE FROM one_referral_attributions",
        "DELETE FROM one_referral_codes",
        "DELETE FROM one_agent_engagement_sessions",
        "DELETE FROM trusted_device_challenges",
        "DELETE FROM trusted_device_authorizations",
        "DELETE FROM trusted_device_audit_events",
        "DELETE FROM trusted_devices",
        "DELETE FROM pkm_default_available_projections",
        "DELETE FROM pkm_upgrade_steps",
        "DELETE FROM pkm_upgrade_runs",
        "DELETE FROM world_model_index_v2",
        "DELETE FROM pkm_migration_state",
        "DELETE FROM kai_receipt_memory_artifacts",
        "DELETE FROM kai_portfolio_source_preferences",
        "DELETE FROM relationship_share_events",
        "DELETE FROM relationship_share_grants",
        "DELETE FROM ria_pick_share_artifacts",
        "DELETE FROM advisor_investor_relationships",
        "DELETE FROM marketplace_investor_actions",
        "DELETE FROM marketplace_public_profiles",
        "DELETE FROM one_kyc_workflows",
        "DELETE FROM one_location_auto_approve_preferences",
        "DELETE FROM one_location_visibility_exclusions",
        "DELETE FROM one_location_visibility_preferences",
        "DELETE FROM one_location_map_preferences",
        "DELETE FROM one_location_network_connections",
        "DELETE FROM one_location_events",
        "DELETE FROM one_location_nearby_presences",
        "DELETE FROM one_location_sms_contacts",
        "DELETE FROM one_location_referrals",
        "DELETE FROM kai_location_referrals",
        "DELETE FROM one_location_public_invite_submissions",
        "DELETE FROM one_location_public_invites",
        "DELETE FROM one_location_circle_invites",
        "DELETE FROM one_location_circle_member_invites",
        "DELETE FROM one_location_circle_invite_codes",
        "DELETE FROM connection_origins",
        "DELETE FROM one_location_circle_memberships",
        "DELETE FROM one_location_circles",
        "DELETE FROM connection_requests",
        "DELETE FROM connections",
        "DELETE FROM trusted_connections",
        "DELETE FROM one_location_access_requests",
        "DELETE FROM one_location_envelopes",
        "DELETE FROM one_location_share_grants",
        "DELETE FROM one_location_recipient_keys",
        "DELETE FROM one_wallet_cards",
        "DELETE FROM feed_events",
        "DELETE FROM ria_pick_legacy_retirements",
        "DELETE FROM developer_oauth_tokens",
        "DELETE FROM developer_oauth_authorizations",
        "DELETE FROM developer_oauth_audit_events",
        "DELETE FROM developer_applications",
        "DELETE FROM developer_apps",
        "DELETE FROM byoc_setup_jobs",
        "DELETE FROM pod_lifecycle_events",
        "DELETE FROM personal_agent_registry",
        "DELETE FROM actor_verified_email_aliases",
        "DELETE FROM actor_identity_cache",
        "DELETE FROM runtime_persona_state",
        "DELETE FROM actor_profiles",
        "DELETE FROM vault_key_wrappers",
        "DELETE FROM vault_keys",
    ]
    for fragment in expected_fragments:
        assert fragment in executed_sql
    assert "DELETE FROM fabric_receipts" not in executed_sql

    assert executed_sql.index("DELETE FROM actor_profiles") < executed_sql.index(
        "DELETE FROM vault_key_wrappers"
    )
    assert executed_sql.index("DELETE FROM vault_key_wrappers") < executed_sql.index(
        "DELETE FROM vault_keys"
    )
    assert executed_sql.index("DELETE FROM consent_export_refresh_jobs") < executed_sql.index(
        "DELETE FROM consent_exports"
    )
    assert executed_sql.index("DELETE FROM pkm_upgrade_steps") < executed_sql.index(
        "DELETE FROM pkm_upgrade_runs"
    )
    assert executed_sql.index("DELETE FROM connected_system_record_bindings") < executed_sql.index(
        "DELETE FROM connected_system_intents"
    )
    assert executed_sql.index("DELETE FROM trusted_device_challenges") < executed_sql.index(
        "DELETE FROM trusted_devices"
    )
    assert executed_sql.index("DELETE FROM relationship_share_events") < executed_sql.index(
        "DELETE FROM relationship_share_grants"
    )
    assert executed_sql.index("DELETE FROM relationship_share_grants") < executed_sql.index(
        "DELETE FROM advisor_investor_relationships"
    )
    assert executed_sql.index("DELETE FROM one_location_events") < executed_sql.index(
        "DELETE FROM one_location_share_grants"
    )
    assert executed_sql.index("DELETE FROM one_location_circle_invite_codes") < executed_sql.index(
        "DELETE FROM one_location_circles"
    )
    assert executed_sql.index("DELETE FROM one_location_circle_member_invites") < (
        executed_sql.index("DELETE FROM one_location_circles")
    )
    assert executed_sql.index("DELETE FROM connection_origins") < executed_sql.index(
        "DELETE FROM one_location_circles"
    )
    assert executed_sql.index("DELETE FROM one_location_circles") < executed_sql.index(
        "DELETE FROM one_location_circle_memberships"
    )
    assert executed_sql.index("DELETE FROM one_location_share_grants") < executed_sql.index(
        "DELETE FROM actor_identity_cache"
    )
    # The public Wallet Profile card holds denormalized PII (name/email/phone/links) and
    # is resolvable from an unauthenticated endpoint, so it must be removed while the
    # account still exists — before the identity spine is torn down. Contract §2.
    assert executed_sql.index("DELETE FROM one_wallet_cards") < executed_sql.index(
        "DELETE FROM actor_profiles"
    )
    assert executed_sql.index("DELETE FROM one_location_recipient_keys") < (
        executed_sql.index("DELETE FROM feed_events")
    )
    assert executed_sql.index("DELETE FROM feed_events") < executed_sql.index(
        "DELETE FROM actor_profiles"
    )
    assert executed_sql.index("DELETE FROM ria_pick_legacy_retirements") < executed_sql.index(
        "DELETE FROM actor_profiles"
    )
    assert executed_sql.index("DELETE FROM developer_oauth_tokens") < executed_sql.index(
        "DELETE FROM developer_oauth_authorizations"
    )
    assert executed_sql.index("DELETE FROM developer_applications") < executed_sql.index(
        "DELETE FROM developer_apps"
    )
    assert executed_sql.index("DELETE FROM fabric_consent_requests") < executed_sql.index(
        "DELETE FROM fabric_subscription_grants"
    )
    assert executed_sql.index("DELETE FROM fabric_subscription_grants") < executed_sql.index(
        "DELETE FROM pwm_documents"
    )
    assert executed_sql.index("DELETE FROM marketplace_delivery_envelopes") < (
        executed_sql.index("DELETE FROM marketplace_access_requests")
    )
    assert executed_sql.index("DELETE FROM marketplace_access_requests") < (
        executed_sql.index("DELETE FROM marketplace_recipient_keys")
    )
    assert executed_sql.index("DELETE FROM one_referral_risk_reviews") < (
        executed_sql.index("DELETE FROM one_referral_events")
    )
    assert executed_sql.index("DELETE FROM one_referral_events") < (
        executed_sql.index("DELETE FROM one_referral_relationships")
    )
    assert executed_sql.index("DELETE FROM one_referral_relationships") < (
        executed_sql.index("DELETE FROM one_referral_attributions")
    )
    assert executed_sql.index("DELETE FROM one_referral_attributions") < (
        executed_sql.index("DELETE FROM one_referral_codes")
    )
    assert executed_sql.index("DELETE FROM one_referral_codes") < (
        executed_sql.index("DELETE FROM actor_profiles")
    )
    assert executed_sql.index("DELETE FROM byoc_setup_jobs") < executed_sql.index(
        "DELETE FROM pod_lifecycle_events"
    )
    assert executed_sql.index("DELETE FROM pod_lifecycle_events") < executed_sql.index(
        "DELETE FROM personal_agent_registry"
    )
    assert executed_sql.index("DELETE FROM one_location_visibility_exclusions") < (
        executed_sql.index("DELETE FROM one_location_visibility_preferences")
    )


def _mapped_result(row):
    result = MagicMock()
    result.mappings.return_value.first.return_value = row
    return result


def test_personal_agent_cleanup_blocks_provisioned_registry_and_byoc_without_partial_delete(
    monkeypatch,
):
    service = AccountService()
    conn = MagicMock()
    monkeypatch.setattr(service, "_table_exists", lambda _conn, _table: True)
    conn.execute.side_effect = [
        _mapped_result(
            {
                "registry": {
                    "hushh_id": "hussh_opaque_123",
                    "backend": "gcp",
                    "external_agent_id": "agent-123",
                    "deployment_target": "user_gcp",
                    "region": "us-central1",
                    "space_id": "space-123",
                    "user_cloud_project": "customer-project-123",
                    "user_cloud_region": "us-central1",
                    "user_cloud_bootstrap_sa": "bootstrap@example.iam.gserviceaccount.com",
                    "phone_e164_hash": "must-not-be-retained",
                    "pod_pubkey": "must-not-be-retained",
                }
            }
        ),
        _mapped_result(
            {
                "job": {
                    "job_id": "job-123",
                    "project_id": "customer-project-123",
                    "status": "running",
                    "error_message": "must-not-be-retained",
                }
            }
        ),
        _mapped_result({"present": True}),
        _mapped_result(None),
    ]

    with pytest.raises(RuntimeError, match="EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING"):
        service._delete_personal_agent_state(
            conn,
            params={"user_id": "user-123"},
            results={},
        )

    executed_sql = [str(call.args[0]) for call in conn.execute.call_args_list]
    assert not any("INSERT INTO personal_agent_deletion_tombstones" in sql for sql in executed_sql)
    assert not any("DELETE FROM" in sql for sql in executed_sql)


def test_personal_agent_cleanup_erases_only_demonstrably_unprovisioned_state(monkeypatch):
    service = AccountService()
    conn = MagicMock()
    present = {"personal_agent_registry", "pod_lifecycle_events"}
    monkeypatch.setattr(
        service,
        "_table_exists",
        lambda _conn, table_name: table_name in present,
    )
    conn.execute.side_effect = [
        _mapped_result(
            {
                "registry": {
                    "hushh_id": "hussh_opaque_123",
                    "status": "unprovisioned",
                }
            }
        ),
        _mapped_result(None),
        MagicMock(),
        MagicMock(),
    ]
    results: dict[str, bool] = {}

    service._delete_personal_agent_state(
        conn,
        params={"user_id": "user-123"},
        results=results,
    )

    executed_sql = [str(call.args[0]) for call in conn.execute.call_args_list]
    lifecycle_delete_index = next(
        index for index, sql in enumerate(executed_sql) if "DELETE FROM pod_lifecycle_events" in sql
    )
    registry_delete_index = next(
        index
        for index, sql in enumerate(executed_sql)
        if "DELETE FROM personal_agent_registry" in sql
    )
    assert lifecycle_delete_index < registry_delete_index
    assert not any("personal_agent_deletion_tombstones" in sql for sql in executed_sql)
    assert all(results.values())


def test_personal_agent_cleanup_fails_closed_for_stale_external_coordinates(monkeypatch):
    service = AccountService()
    conn = MagicMock()
    present = {"personal_agent_registry"}
    monkeypatch.setattr(
        service,
        "_table_exists",
        lambda _conn, table_name: table_name in present,
    )
    conn.execute.return_value = _mapped_result(
        {
            "registry": {
                "hushh_id": "hussh_opaque_123",
                "status": "unprovisioned",
                "space_id": "stale-external-space-123",
            }
        }
    )

    with pytest.raises(RuntimeError, match="EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING"):
        service._delete_personal_agent_state(
            conn,
            params={"user_id": "user-123"},
            results={},
        )

    executed_sql = "\n".join(str(call.args[0]) for call in conn.execute.call_args_list)
    assert "DELETE FROM" not in executed_sql


def test_personal_agent_cleanup_is_a_noop_when_live_drift_tables_are_absent(monkeypatch):
    service = AccountService()
    conn = MagicMock()
    monkeypatch.setattr(service, "_table_exists", lambda _conn, _table: False)
    results: dict[str, bool] = {}

    service._delete_personal_agent_state(
        conn,
        params={"user_id": "user-123"},
        results=results,
    )

    conn.execute.assert_not_called()
    assert results == {
        "byoc_setup_jobs": True,
        "pod_lifecycle_events": True,
        "personal_agent_registry": True,
        "personal_agent_external_resources_absent": True,
    }


def test_personal_agent_cleanup_fails_closed_for_orphaned_byoc_job(monkeypatch):
    service = AccountService()
    conn = MagicMock()
    monkeypatch.setattr(service, "_table_exists", lambda _conn, _table: True)
    conn.execute.side_effect = [
        _mapped_result(None),
        _mapped_result({"job": {"job_id": "job-123", "project_id": "project-123"}}),
        _mapped_result(None),
    ]

    with pytest.raises(RuntimeError, match="EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING"):
        service._delete_personal_agent_state(
            conn,
            params={"user_id": "user-123"},
            results={},
        )

    executed_sql = "\n".join(str(call.args[0]) for call in conn.execute.call_args_list)
    assert "DELETE FROM" not in executed_sql


@pytest.mark.parametrize("registry", [None, {"registry": {"status": "unprovisioned"}}])
def test_personal_agent_cleanup_fails_closed_for_orphaned_lifecycle_row(monkeypatch, registry):
    service = AccountService()
    conn = MagicMock()
    present = {"personal_agent_registry", "pod_lifecycle_events"}
    monkeypatch.setattr(
        service,
        "_table_exists",
        lambda _conn, table_name: table_name in present,
    )
    conn.execute.side_effect = [
        _mapped_result(registry),
        _mapped_result({"present": True}),
    ]

    with pytest.raises(RuntimeError, match="EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING"):
        service._delete_personal_agent_state(
            conn,
            params={"user_id": "user-123"},
            results={},
        )

    executed_sql = "\n".join(str(call.args[0]) for call in conn.execute.call_args_list)
    assert "DELETE FROM" not in executed_sql


def test_personal_agent_cleanup_fails_closed_when_deprovision_is_already_pending(
    monkeypatch,
):
    service = AccountService()
    conn = MagicMock()
    monkeypatch.setattr(service, "_table_exists", lambda _conn, _table: True)
    conn.execute.side_effect = [
        _mapped_result(
            {
                "registry": {
                    "hushh_id": "hussh_opaque_123",
                    "status": "unprovisioned",
                }
            }
        ),
        _mapped_result(None),
        _mapped_result(None),
        _mapped_result((True,)),
    ]

    with pytest.raises(RuntimeError, match="EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING"):
        service._delete_personal_agent_state(
            conn,
            params={"user_id": "user-123"},
            results={},
        )

    executed_sql = "\n".join(str(call.args[0]) for call in conn.execute.call_args_list)
    assert "INSERT INTO personal_agent_deletion_tombstones" not in executed_sql
    assert "DELETE FROM" not in executed_sql


@pytest.mark.asyncio
async def test_full_account_delete_returns_stable_external_resource_block_without_deletes(
    monkeypatch,
):
    service = AccountService()
    conn = MagicMock()
    present = {"personal_agent_registry"}
    monkeypatch.setattr(
        service,
        "_table_exists",
        lambda _conn, table_name: table_name in present,
    )
    conn.execute.return_value = _mapped_result(
        {
            "registry": {
                "hushh_id": "hussh_opaque_123",
                "status": "provisioned",
                "external_agent_id": "agent-123",
            }
        }
    )
    monkeypatch.setattr(
        "hushh_mcp.services.account_service."
        "AccountDeletionLifecycleService.record_pending_many_in_transaction",
        lambda _conn, *, user_ids: tuple(user_ids),
    )

    with patch("hushh_mcp.services.account_service.get_db_connection", return_value=_db(conn)):
        result = await service._delete_full_account("user-123", requested_target="both")

    assert result["success"] is False
    assert result["account_deleted"] is False
    assert result["error_code"] == PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE
    assert "private agent or cloud setup" in result["message"]
    executed_sql = "\n".join(str(call.args[0]) for call in conn.execute.call_args_list)
    assert "DELETE FROM" not in executed_sql


def test_live_erasure_catalog_is_documented_and_has_explicit_predicates():
    service = AccountService()
    contract = json.loads(
        (REPO_ROOT / "docs/reference/architecture/runtime-db-data-plane-contract.json").read_text(
            encoding="utf-8"
        )
    )
    documented_tables = {
        table_name
        for family in contract["table_families"]
        for table_name in family.get("exact_tables", [])
    }

    assert TRANSACTIONAL_ACCOUNT_ERASURE_TABLES <= documented_tables
    assert TRANSACTIONAL_ACCOUNT_ERASURE_TABLES <= service._delete_by_user_queries.keys()
    visibility_exclusions_sql = str(
        service._delete_by_user_queries["one_location_visibility_exclusions"]
    )
    kai_referrals_sql = str(service._delete_by_user_queries["kai_location_referrals"])
    assert "owner_user_id = :user_id" in visibility_exclusions_sql
    assert "excluded_user_id = :user_id" in visibility_exclusions_sql
    assert "owner_user_id = :user_id" in kai_referrals_sql
    assert "referrer_user_id = :user_id" in kai_referrals_sql
    assert "candidate_user_id = :user_id" in kai_referrals_sql
    assert "hushh_tech_link_events" not in service._delete_by_user_queries


def test_one_referral_cleanup_fails_closed_on_partial_migration_shape(monkeypatch):
    service = AccountService()
    conn = MagicMock()
    present = {
        "one_referral_relationships",
        "one_referral_attributions",
        "one_referral_codes",
    }
    monkeypatch.setattr(
        service,
        "_table_exists",
        lambda _conn, table_name: table_name in present,
    )

    with pytest.raises(RuntimeError, match="incomplete migration-165 referral schema"):
        service._delete_one_referral_graph(
            conn,
            params={"user_id": "referral-user"},
            results={},
        )

    conn.execute.assert_not_called()


def test_one_referral_cleanup_removes_cross_account_links_before_attribution(monkeypatch):
    service = AccountService()
    conn = MagicMock()
    monkeypatch.setattr(service, "_table_exists", lambda _conn, _table: True)
    results: dict[str, bool] = {}

    service._delete_one_referral_graph(
        conn,
        params={"user_id": "referred-user"},
        results=results,
    )

    executed_sql = [str(call.args[0]) for call in conn.execute.call_args_list]
    relationships_sql = next(
        sql for sql in executed_sql if "DELETE FROM one_referral_relationships" in sql
    )
    attributions_sql = next(
        sql for sql in executed_sql if "DELETE FROM one_referral_attributions" in sql
    )
    assert "relationship.referrer_user_id = :user_id" in relationships_sql
    assert "relationship.referred_user_id = :user_id" in relationships_sql
    assert "attribution.bound_user_id = :user_id" in relationships_sql
    assert "referral_code.owner_user_id = :user_id" in relationships_sql
    assert "attribution.bound_user_id = :user_id" in attributions_sql
    assert executed_sql.index(relationships_sql) < executed_sql.index(attributions_sql)
    assert all(results.values())


@pytest.mark.asyncio
async def test_ria_persona_delete_removes_restricting_legacy_retirement_first(monkeypatch):
    service = AccountService()
    conn = MagicMock()
    monkeypatch.setattr(service, "_table_exists", lambda _conn, _table: True)

    with patch("hushh_mcp.services.account_service.get_db_connection", return_value=_db(conn)):
        result = await service._delete_ria_persona(
            user_id="ria_user",
            remaining_personas=["investor"],
            investor_marketplace_opt_in=False,
            requested_target="ria",
        )

    assert result["success"] is True
    assert result["details"]["ria_pick_legacy_retirements"] is True
    executed_sql = [str(call.args[0]) for call in conn.execute.call_args_list]
    retirement_index = next(
        index
        for index, sql in enumerate(executed_sql)
        if "DELETE FROM ria_pick_legacy_retirements" in sql
    )
    profile_index = next(
        index for index, sql in enumerate(executed_sql) if "DELETE FROM ria_profiles" in sql
    )
    assert retirement_index < profile_index


def test_fetch_optional_many_rows_returns_empty_when_table_missing(monkeypatch):
    service = AccountService()
    conn = MagicMock()

    monkeypatch.setattr(service, "_table_exists", lambda _conn, _table: False)

    rows = service._fetch_optional_many_rows(
        conn,
        table_name="pkm_blobs",
        query_name="encrypted_pkm_blobs",
        params={"user_id": "user_123"},
    )

    assert rows == []
    conn.execute.assert_not_called()


def test_fetch_optional_single_row_returns_none_when_table_missing(monkeypatch):
    service = AccountService()
    conn = MagicMock()

    monkeypatch.setattr(service, "_table_exists", lambda _conn, _table: False)

    row = service._fetch_optional_single_row(
        conn,
        table_name="actor_profiles",
        query_name="actor_profile",
        params={"user_id": "user_123"},
    )

    assert row is None
    conn.execute.assert_not_called()


@pytest.mark.asyncio
async def test_reset_account_clears_data_but_keeps_account_spine(monkeypatch):
    service = AccountService()
    conn = MagicMock()
    user_id = "user_reset_123"

    monkeypatch.setattr(service, "_table_exists", lambda _conn, _table: True)

    with patch("hushh_mcp.services.account_service.get_db_connection", return_value=_db(conn)):
        result = await service.reset_account(user_id)

    assert result["success"] is True
    assert result["account_deleted"] is False
    assert result["account_reset"] is True
    assert result["details"]["one_location_circle_member_invites"] is True
    assert result["details"]["one_location_auto_approve_preferences"] is True
    assert result["details"]["one_location_map_preferences"] is True
    assert result["details"]["one_location_network_connections"] is True
    assert result["details"]["connection_origins"] is True
    assert result["details"]["feed_events"] is True
    assert result["details"]["pwm_documents"] is True
    assert result["details"]["fabric_subscription_grants"] is True
    assert result["details"]["marketplace_access_requests"] is True

    first_sql = str(conn.execute.call_args_list[0].args[0])
    assert "pg_advisory_xact_lock" in first_sql
    assert conn.execute.call_args_list[0].args[1] == {"lock_key": "fabric_receipts:user_reset_123"}

    executed_sql = "\n".join(str(call.args[0]) for call in conn.execute.call_args_list)

    # Personal data is cleared.
    cleared_fragments = [
        "DELETE FROM kai_funding_trade_events",
        "DELETE FROM kai_gmail_receipts",
        "DELETE FROM pkm_events",
        "DELETE FROM pkm_blobs",
        "DELETE FROM connected_system_intents",
        "DELETE FROM connected_system_owner_signing_keys",
        "DELETE FROM connected_system_zk_contexts",
        "DELETE FROM fabric_consent_requests",
        "DELETE FROM fabric_subscription_grants",
        "DELETE FROM pwm_documents",
        "DELETE FROM marketplace_delivery_envelopes",
        "DELETE FROM marketplace_access_requests",
        "DELETE FROM marketplace_recipient_keys",
        "DELETE FROM marketplace_opportunity_signals",
        "DELETE FROM trusted_device_challenges",
        "DELETE FROM trusted_device_authorizations",
        "DELETE FROM trusted_device_audit_events",
        "DELETE FROM trusted_devices",
        "DELETE FROM consent_audit",
        "DELETE FROM one_kyc_workflows",
        "DELETE FROM one_location_auto_approve_preferences",
        "DELETE FROM one_location_map_preferences",
        "DELETE FROM one_location_network_connections",
        "DELETE FROM one_location_events",
        "DELETE FROM one_location_nearby_presences",
        "DELETE FROM one_location_sms_contacts",
        "DELETE FROM one_location_circle_member_invites",
        "DELETE FROM one_location_circle_invite_codes",
        "DELETE FROM connection_origins",
        "DELETE FROM one_location_circle_memberships",
        "DELETE FROM one_location_circles",
        "DELETE FROM connection_requests",
        "DELETE FROM connections",
        "DELETE FROM one_wallet_cards",
        "DELETE FROM feed_events",
    ]
    for fragment in cleared_fragments:
        assert fragment in executed_sql
    assert "DELETE FROM fabric_receipts" not in executed_sql

    assert executed_sql.index("DELETE FROM one_location_recipient_keys") < (
        executed_sql.index("DELETE FROM feed_events")
    )
    assert "WHERE user_id = :user_id" in str(service._delete_by_user_queries["feed_events"])

    # The account spine survives a reset: no DELETE touches identity or vault.
    spine_fragments = [
        "DELETE FROM actor_profiles",
        "DELETE FROM actor_identity_cache",
        "DELETE FROM actor_verified_email_aliases",
        "DELETE FROM runtime_persona_state",
        "DELETE FROM vault_key_wrappers",
        "DELETE FROM vault_keys",
    ]
    for fragment in spine_fragments:
        assert fragment not in executed_sql

    # The spine is re-seeded to a clean One default, and setup flags reset.
    assert "UPDATE actor_profiles" in executed_sql
    assert "UPDATE runtime_persona_state" in executed_sql
    assert "UPDATE vault_keys" in executed_sql
    assert "setup_completed = NULL" in executed_sql
    assert "contact_discoverable = FALSE" in executed_sql
    assert "contact_sync_consent_enabled_at = NULL" in executed_sql
    assert "contact_sync_consent_rule_version + 1" in executed_sql
    assert "contact_sync_consent_contract_version = NULL" in executed_sql


def test_owned_circle_cleanup_preserves_relationship_order(monkeypatch):
    service = AccountService()
    conn = MagicMock()
    circle_result = MagicMock()
    circle_result.mappings.return_value.all.return_value = [
        {
            "id": "circle_b",
            "is_owner": True,
            "has_active_membership": True,
        },
        {
            "id": "circle_a",
            "is_owner": True,
            "has_active_membership": True,
        },
    ]
    member_result = MagicMock()
    member_result.mappings.return_value.all.return_value = [
        {"user_id": "owner"},
        {"user_id": "member_a"},
        {"user_id": "member_b"},
    ]

    def execute(query, _params=None):
        if (
            "circle.id" in str(query)
            and "FROM one_location_circles circle" in str(query)
            and "FOR UPDATE OF circle" in str(query)
        ):
            return circle_result
        if "SELECT DISTINCT membership.user_id" in str(query):
            return member_result
        return MagicMock()

    conn.execute.side_effect = execute
    monkeypatch.setattr(service, "_table_exists", lambda _conn, _table: True)

    with (
        patch(
            "hushh_mcp.services.one_location_circle_service."
            "OneLocationCircleService._cleanup_ineligible_sms_contacts"
        ) as cleanup_sms,
        patch(
            "hushh_mcp.services.connection_graph_service."
            "ConnectionGraphService.revoke_named_circle_origins"
        ) as revoke_origins,
        patch(
            "hushh_mcp.services.one_location_circle_service."
            "OneLocationCircleService._reconcile_circle_sourced_grants"
        ) as reconcile_grants,
    ):
        results: dict[str, bool] = {}
        service._delete_owned_named_circles(
            conn,
            user_id="owner",
            results=results,
        )

    executed_sql = [str(call.args[0]) for call in conn.execute.call_args_list]
    circle_lock_index = next(
        index
        for index, sql in enumerate(executed_sql)
        if "FROM one_location_circles circle" in sql and "FOR UPDATE OF circle" in sql
    )
    code_revoke_index = next(
        index
        for index, sql in enumerate(executed_sql)
        if "UPDATE one_location_circle_invite_codes" in sql and "revoked_at = NOW()" in sql
    )
    invite_cancel_index = next(
        index
        for index, sql in enumerate(executed_sql)
        if "UPDATE one_location_circle_member_invites" in sql and "cancelled_at = NOW()" in sql
    )
    event_cleanup_index = next(
        index
        for index, sql in enumerate(executed_sql)
        if "DELETE FROM one_location_events event" in sql
    )
    circle_delete_index = next(
        index for index, sql in enumerate(executed_sql) if "DELETE FROM one_location_circles" in sql
    )
    origin_delete_index = next(
        index for index, sql in enumerate(executed_sql) if "DELETE FROM connection_origins" in sql
    )
    assert (
        circle_lock_index
        < code_revoke_index
        < invite_cancel_index
        < event_cleanup_index
        < origin_delete_index
        < circle_delete_index
    )
    assert "member_invite.inviter_user_id = :user_id" in executed_sql[circle_lock_index]
    assert "member_invite.invitee_user_id = :user_id" in executed_sql[circle_lock_index]
    assert "inviter_user_id = :user_id" in executed_sql[invite_cancel_index]
    assert "origin.status = 'revoked'" in executed_sql[origin_delete_index]
    assert [call.kwargs["source_circle_id"] for call in revoke_origins.call_args_list] == [
        "circle_a",
        "circle_b",
    ]
    assert [call.kwargs["circle_id"] for call in reconcile_grants.call_args_list] == [
        "circle_a",
        "circle_b",
    ]
    assert [call.kwargs["user_id"] for call in cleanup_sms.call_args_list] == [
        "member_a",
        "member_b",
        "owner",
    ]
    assert results["one_location_circle_invite_codes"] is True
    assert results["one_location_circle_member_invites"] is True
    assert results["connection_origins"] is True
    assert results["one_location_circles"] is True


@pytest.mark.asyncio
async def test_reset_account_returns_failure_on_error(monkeypatch):
    service = AccountService()

    def _boom(_conn, _user_id, _results):
        raise RuntimeError("db down")

    monkeypatch.setattr(service, "_clear_user_data_tables", _boom)

    conn = MagicMock()
    with patch("hushh_mcp.services.account_service.get_db_connection", return_value=_db(conn)):
        result = await service.reset_account("user_reset_err")

    assert result["success"] is False
    assert result["account_reset"] is False
    assert result["error"] == "account_reset_failed"


def _owned_circle_conn(monkeypatch, service, *, circle_rows):
    """A conn double shaped like the real owned-Circle cleanup queries.

    Regression coverage for migration 160
    (`one_location_circles_block_system_delete`): the hard
    `DELETE FROM one_location_circles WHERE owner_user_id = :user_id` in
    `_delete_owned_named_circles` is refused by that trigger for any row with
    `is_system = true` (the SMS/Emergency Circle every user gets provisioned
    on login), because the trigger's job is to stop an ordinary code path from
    silently switching off SOS. Account-level cleanup is not an ordinary code
    path -- it is the same owner's entire account being deleted or reset -- so
    it must demote is_system before the hard delete instead of being blocked
    by it. This reproduces the exact production failure
    (psycopg2.errors.RestrictViolation, UAT 2026-08-19) and proves the fix.
    """
    conn = MagicMock()
    circle_result = MagicMock()
    circle_result.mappings.return_value.all.return_value = circle_rows
    member_result = MagicMock()
    member_result.mappings.return_value.all.return_value = []

    def execute(query, _params=None):
        sql = str(query)
        if (
            "circle.id" in sql
            and "FROM one_location_circles circle" in sql
            and "FOR UPDATE OF circle" in sql
        ):
            return circle_result
        if "SELECT DISTINCT membership.user_id" in sql:
            return member_result
        return MagicMock()

    conn.execute.side_effect = execute
    monkeypatch.setattr(service, "_table_exists", lambda _conn, _table: True)
    monkeypatch.setattr(service, "_column_exists", lambda _conn, _table, _column: True)
    monkeypatch.setattr(
        "hushh_mcp.services.one_location_circle_service."
        "OneLocationCircleService._cleanup_ineligible_sms_contacts",
        lambda *_a, **_k: None,
    )
    monkeypatch.setattr(
        "hushh_mcp.services.connection_graph_service."
        "ConnectionGraphService.revoke_named_circle_origins",
        lambda *_a, **_k: None,
    )
    monkeypatch.setattr(
        "hushh_mcp.services.one_location_circle_service."
        "OneLocationCircleService._reconcile_circle_sourced_grants",
        lambda *_a, **_k: None,
    )
    return conn


def test_owned_circle_cleanup_also_clears_system_kind_before_hard_delete(monkeypatch):
    """Incident #5574, arriving a second time by a different column.

    Migration 163 widened `one_location_circles_block_system_delete` to fire on
    `system_kind IS NOT NULL` as well, because a Trusted Circle is deliberately
    NOT `is_system`. Clearing only the flag therefore stopped being enough to
    open this escape hatch, and the failure is not limited to Trusted: 163
    backfills `system_kind = 'sms'` onto every SMS Circle that already exists,
    so the row the demotion above handles ALSO still trips the trigger.

    That is the exact production failure of 2026-08-19 -- account deletion
    500s with RestrictViolation -- reachable by every account that has signed
    in since 160 shipped.
    """

    service = AccountService()
    conn = _owned_circle_conn(
        monkeypatch,
        service,
        circle_rows=[
            {"id": "circle_sms", "is_owner": True, "has_active_membership": True},
            {"id": "circle_trusted", "is_owner": True, "has_active_membership": True},
        ],
    )

    results: dict[str, bool] = {}
    service._delete_owned_named_circles(conn, user_id="owner", results=results)

    executed_sql = [str(call.args[0]) for call in conn.execute.call_args_list]
    clear_index = next(
        index
        for index, sql in enumerate(executed_sql)
        if "UPDATE one_location_circles" in sql and "SET system_kind = NULL" in sql
    )
    delete_index = next(
        index for index, sql in enumerate(executed_sql) if "DELETE FROM one_location_circles" in sql
    )

    assert clear_index < delete_index
    # Scoped to this owner, and to rows that actually carry a kind.
    assert "AND system_kind IS NOT NULL" in executed_sql[clear_index]
    assert conn.execute.call_args_list[clear_index].args[1] == {"user_id": "owner"}
    assert results["one_location_circles"] is True


def test_owned_circle_cleanup_demotes_system_circle_before_hard_delete(monkeypatch):
    service = AccountService()
    conn = _owned_circle_conn(
        monkeypatch,
        service,
        circle_rows=[
            {"id": "circle_system", "is_owner": True, "has_active_membership": True},
            {"id": "circle_ordinary", "is_owner": True, "has_active_membership": True},
        ],
    )

    results: dict[str, bool] = {}
    service._delete_owned_named_circles(conn, user_id="owner", results=results)

    executed_sql = [str(call.args[0]) for call in conn.execute.call_args_list]
    demote_index = next(
        index
        for index, sql in enumerate(executed_sql)
        if "UPDATE one_location_circles" in sql and "SET is_system = FALSE" in sql
    )
    demote_params = conn.execute.call_args_list[demote_index].args[1]
    delete_index = next(
        index for index, sql in enumerate(executed_sql) if "DELETE FROM one_location_circles" in sql
    )

    # The demotion runs in the SAME transaction, scoped to this owner only,
    # and strictly before the hard delete -- otherwise the trigger still fires.
    assert demote_index < delete_index
    assert "AND is_system" in executed_sql[demote_index]
    assert demote_params == {"user_id": "owner"}
    assert results["one_location_circles"] is True


def test_owned_circle_cleanup_skips_is_system_demotion_when_column_missing(monkeypatch):
    """Environments that have not yet run migration 160 must not regress.

    `is_system` is a real column, not an optional-table cleanup entry, so this
    guards the one case `_table_exists` alone would miss: the table is there
    (migration 134) but migration 160 has not applied yet on that replica.
    """
    service = AccountService()
    conn = _owned_circle_conn(
        monkeypatch,
        service,
        circle_rows=[{"id": "circle_a", "is_owner": True, "has_active_membership": True}],
    )
    monkeypatch.setattr(service, "_column_exists", lambda _conn, _table, _column: False)

    results: dict[str, bool] = {}
    service._delete_owned_named_circles(conn, user_id="owner", results=results)

    executed_sql = [str(call.args[0]) for call in conn.execute.call_args_list]
    assert not any("SET is_system = FALSE" in sql for sql in executed_sql)
    assert any("DELETE FROM one_location_circles" in sql for sql in executed_sql)


def test_owned_circle_cleanup_handles_owner_with_no_circles(monkeypatch):
    """Legacy / already-cleaned accounts: zero owned Circles must not crash."""
    service = AccountService()
    conn = _owned_circle_conn(monkeypatch, service, circle_rows=[])

    results: dict[str, bool] = {}
    service._delete_owned_named_circles(conn, user_id="owner_no_circles", results=results)
    # Idempotent: calling it again (e.g. a retried delete request) is also safe.
    service._delete_owned_named_circles(conn, user_id="owner_no_circles", results=results)

    assert results["one_location_circles"] is True


@pytest.mark.asyncio
async def test_full_account_deletion_demotes_system_circle_before_deleting_it(monkeypatch):
    """End-to-end reproduction of the DELETE /api/account/delete regression."""
    service = AccountService()
    monkeypatch.setattr(service, "_table_exists", lambda _conn, _table: True)
    monkeypatch.setattr(service, "_column_exists", lambda _conn, _table, _column: True)

    def _skip_personal_agent_state(_conn, *, params, results):
        del _conn, params
        results.update(
            {
                "byoc_setup_jobs": True,
                "pod_lifecycle_events": True,
                "personal_agent_registry": True,
                "personal_agent_external_resources_absent": True,
            }
        )

    monkeypatch.setattr(service, "_delete_personal_agent_state", _skip_personal_agent_state)

    conn = _owned_circle_conn(
        monkeypatch,
        service,
        circle_rows=[{"id": "sms_circle", "is_owner": True, "has_active_membership": True}],
    )

    with patch("hushh_mcp.services.account_service.get_db_connection", return_value=_db(conn)):
        result = await service._delete_full_account(
            "user_with_system_circle", requested_target="both"
        )

    assert result["success"] is True
    assert result["account_deleted"] is True

    executed_sql = [str(call.args[0]) for call in conn.execute.call_args_list]
    demote_index = next(
        index
        for index, sql in enumerate(executed_sql)
        if "UPDATE one_location_circles" in sql and "SET is_system = FALSE" in sql
    )
    delete_index = next(
        index for index, sql in enumerate(executed_sql) if "DELETE FROM one_location_circles" in sql
    )
    assert demote_index < delete_index


@pytest.mark.asyncio
async def test_reset_account_demotes_system_circle_before_deleting_it(monkeypatch):
    """End-to-end reproduction of the POST /api/account/reset regression."""
    service = AccountService()
    monkeypatch.setattr(service, "_table_exists", lambda _conn, _table: True)
    monkeypatch.setattr(service, "_column_exists", lambda _conn, _table, _column: True)

    conn = _owned_circle_conn(
        monkeypatch,
        service,
        circle_rows=[{"id": "sms_circle", "is_owner": True, "has_active_membership": True}],
    )

    with patch("hushh_mcp.services.account_service.get_db_connection", return_value=_db(conn)):
        result = await service.reset_account("user_with_system_circle")

    assert result["success"] is True
    assert result["account_reset"] is True

    executed_sql = [str(call.args[0]) for call in conn.execute.call_args_list]
    demote_index = next(
        index
        for index, sql in enumerate(executed_sql)
        if "UPDATE one_location_circles" in sql and "SET is_system = FALSE" in sql
    )
    delete_index = next(
        index for index, sql in enumerate(executed_sql) if "DELETE FROM one_location_circles" in sql
    )
    assert demote_index < delete_index
    # Reset keeps sign-in: the identity/vault spine is never deleted.
    spine_fragments = [
        "DELETE FROM actor_profiles",
        "DELETE FROM vault_keys",
        "DELETE FROM vault_key_wrappers",
    ]
    for fragment in spine_fragments:
        assert fragment not in "\n".join(executed_sql)
