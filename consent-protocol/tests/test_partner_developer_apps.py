"""Tests for partner-class developer apps (CRM systems operating the Hussh MCP).

Architecture rule under test: every CRM system gets its OWN partner app +
token (kind='partner_crm', no owner_firebase_uid, optional soft crm_id link),
provisioned via ops, invisible to the self-serve portal, authenticating on
the same registry lane as self-serve tokens.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from hushh_mcp.services.developer_registry_service import (
    DeveloperPrincipal,
    DeveloperRegistryService,
)

ROOT = Path(__file__).resolve().parents[1]


def _result(rows):
    result = MagicMock()
    result.data = rows
    return result


def _service_with_db(db):
    with patch(
        "hushh_mcp.services.developer_registry_service.get_db",
        return_value=db,
    ):
        service = DeveloperRegistryService()
    service.ensure_tables = MagicMock()  # type: ignore[method-assign]
    return service


class TestProvisionPartnerApp:
    def test_creates_partner_app_and_issues_token(self):
        db = MagicMock()
        inserted_app = {
            "app_id": "app_hushh-technologies_abcd1234",
            "agent_id": "developer:app_hushh-technologies_abcd1234",
            "display_name": "Hushh Technologies",
            "kind": "partner_crm",
            "crm_id": None,
            "allowed_tool_groups": '["core_consent"]',
        }
        token_row = {
            "id": 7,
            "app_id": inserted_app["app_id"],
            "token_prefix": "hdk_deadbeef",
            "label": "partner-crm-primary",
        }
        service = _service_with_db(db)
        service.get_partner_app_by_display_name = MagicMock(return_value=None)  # type: ignore[method-assign]
        service.get_active_token = MagicMock(return_value=None)  # type: ignore[method-assign]
        db.execute_raw.return_value = _result([inserted_app])

        def _fake_create_token(**kwargs):
            assert kwargs["app_id"] == inserted_app["app_id"]
            assert kwargs["label"] == "partner-crm-primary"
            return {**token_row, "raw_token": "hdk_deadbeef_secretsecretsecret"}

        service.create_token = MagicMock(side_effect=lambda **kw: _fake_create_token(**kw))  # type: ignore[method-assign]

        outcome = service.provision_partner_app(
            display_name="Hushh Technologies",
            contact_email="partners@hushh.ai",
        )

        assert outcome["created_app"] is True
        assert outcome["issued_token"] is True
        assert outcome["raw_token"].startswith("hdk_")
        insert_sql = db.execute_raw.call_args[0][0]
        assert "'partner_crm'" in insert_sql
        params = db.execute_raw.call_args[0][1]
        assert params["display_name"] == "Hushh Technologies"
        assert params["contact_email"] == "partners@hushh.ai"
        # Partner apps never carry an owner uid.
        assert "owner_firebase_uid" not in insert_sql

    def test_rerun_reuses_app_and_does_not_reissue_active_token(self):
        db = MagicMock()
        existing_app = {
            "app_id": "app_hushh-technologies_abcd1234",
            "agent_id": "developer:app_hushh-technologies_abcd1234",
            "display_name": "Hushh Technologies",
            "kind": "partner_crm",
        }
        service = _service_with_db(db)
        service.get_partner_app_by_display_name = MagicMock(return_value=existing_app)  # type: ignore[method-assign]
        service.get_active_token = MagicMock(  # type: ignore[method-assign]
            return_value={"id": 7, "token_prefix": "hdk_deadbeef"}
        )
        service.create_token = MagicMock()  # type: ignore[method-assign]

        outcome = service.provision_partner_app(
            display_name="Hushh Technologies",
            contact_email="partners@hushh.ai",
        )

        assert outcome["created_app"] is False
        assert outcome["issued_token"] is False
        assert outcome["raw_token"] is None
        service.create_token.assert_not_called()

    def test_rejects_blank_display_name_and_bad_email(self):
        service = _service_with_db(MagicMock())
        with pytest.raises(ValueError):
            service.provision_partner_app(display_name="  ", contact_email="a@b.co")
        with pytest.raises(ValueError):
            service.provision_partner_app(
                display_name="Hushh Technologies", contact_email="not-an-email"
            )

    def test_unknown_tool_groups_fall_back_to_core_consent(self):
        db = MagicMock()
        service = _service_with_db(db)
        service.get_partner_app_by_display_name = MagicMock(return_value=None)  # type: ignore[method-assign]
        service.get_active_token = MagicMock(return_value=None)  # type: ignore[method-assign]
        service.create_token = MagicMock(  # type: ignore[method-assign]
            return_value={"id": 1, "raw_token": "hdk_x_y", "token_prefix": "hdk_x"}
        )
        db.execute_raw.return_value = _result([{"app_id": "app_x", "agent_id": "developer:app_x"}])

        service.provision_partner_app(
            display_name="Hushh Technologies",
            contact_email="partners@hushh.ai",
            allowed_tool_groups=["made_up_group"],
        )

        params = db.execute_raw.call_args[0][1]
        assert json.loads(params["allowed_tool_groups"]) == ["core_consent"]


class TestPartnerPrincipal:
    def test_principal_row_carries_kind_and_crm_id(self):
        row = {
            "app_id": "app_hushh-technologies_abcd1234",
            "agent_id": "developer:app_hushh-technologies_abcd1234",
            "display_name": "Hushh Technologies",
            "allowed_tool_groups": '["core_consent"]',
            "kind": "partner_crm",
            "crm_id": "salesforce-fsc-hushh",
            "token_id": 7,
        }
        principal = DeveloperRegistryService._principal_from_row(row)
        assert principal.kind == "partner_crm"
        assert principal.crm_id == "salesforce-fsc-hushh"
        assert principal.agent_id == "developer:app_hushh-technologies_abcd1234"

    def test_principal_defaults_to_self_serve_kind(self):
        row = {
            "app_id": "app_x",
            "agent_id": "developer:app_x",
            "display_name": "X",
            "allowed_tool_groups": '["core_consent"]',
        }
        principal = DeveloperRegistryService._principal_from_row(row)
        assert principal.kind == "self_serve"
        assert principal.crm_id is None

    def test_dataclass_defaults_keep_backward_compat(self):
        principal = DeveloperPrincipal(
            app_id="a",
            agent_id="developer:a",
            display_name="A",
            allowed_tool_groups=("core_consent",),
        )
        assert principal.kind == "self_serve"
        assert principal.crm_id is None


class TestPartnerMigrationContract:
    def test_migration_085_registered_and_shaped(self):
        migration = ROOT / "db" / "migrations" / "085_developer_partner_apps.sql"
        assert migration.exists()
        sql = migration.read_text()
        assert "ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'self_serve'" in sql
        assert "ADD COLUMN IF NOT EXISTS crm_id TEXT" in sql
        assert "developer_apps_kind_check" in sql
        assert "'partner_crm'" in sql

        manifest = json.loads((ROOT / "db" / "release_migration_manifest.json").read_text())
        assert "085_developer_partner_apps.sql" in manifest["ordered_migrations"]
        assert "085_developer_partner_apps.sql" in manifest["groups"]["developer"]
        assert len(manifest["ordered_migrations"]) == len(set(manifest["ordered_migrations"]))

    def test_uat_contract_covers_partner_columns(self):
        contract = json.loads(
            (ROOT / "db" / "contracts" / "uat_integrated_schema.json").read_text()
        )
        assert contract["expected_migration_version"] == 85
        cols = contract["required_tables"]["developer_apps"]
        assert "kind" in cols
        assert "crm_id" in cols
