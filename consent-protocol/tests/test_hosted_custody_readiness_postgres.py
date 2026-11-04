"""Explicit Dev custody profile, migration replay, and runtime readiness tests."""

from __future__ import annotations

import pytest

from tests.hosted_custody_profile_support import complete_custody_sql, dev_custody_environment
from tests.hosted_custody_readiness_scenario import run_dev_owner_only_readiness_scenario
from tests.test_hosted_pilot_admission_postgres import ROOT
from tests.test_hosted_pilot_admission_postgres import pg as pg
from tests.test_hosted_pilot_admission_postgres import pytestmark as pytestmark


def test_dev_custody_profile_requires_explicit_exact_runtime_configuration():
    from db.hosted_custody_qualification import (
        CUSTODY_PROFILE_ENV,
        DEV_CONTROL_PLANE_OWNER_PROFILE,
        STRICT_CUSTODY_PROFILE,
        hosted_custody_profile_from_environment,
    )

    config = dev_custody_environment()
    profile = hosted_custody_profile_from_environment(config)
    assert profile.name == DEV_CONTROL_PLANE_OWNER_PROFILE
    assert profile.system_identifier_sha256 == (
        "320fe60c039c7a44aa11e7b670de5e3576d9c4ab7e95de76657719b6c56810b0"
    )

    unselected = dict(config)
    del unselected[CUSTODY_PROFILE_ENV]
    assert hosted_custody_profile_from_environment(unselected).name == STRICT_CUSTODY_PROFILE

    for key, wrong_value in (
        ("ENVIRONMENT", "uat"),
        ("GCP_PROJECT_ID", "hushh-pda-uat"),
        ("GOOGLE_CLOUD_PROJECT", "hushh-pda-uat"),
        ("CLOUDSQL_INSTANCE_CONNECTION_NAME", "hushh-pda-prod:us-central1:hushh-prod-pg"),
        ("DB_NAME", "scope_commerce_sandbox"),
        ("DB_USER", "service_role"),
        ("DEV_TARGET", "scope-commerce-sandbox"),
    ):
        wrong = {**config, key: wrong_value}
        with pytest.raises(ValueError, match=key):
            hosted_custody_profile_from_environment(wrong)

    with pytest.raises(ValueError, match="DEV_TARGET"):
        hosted_custody_profile_from_environment(
            {CUSTODY_PROFILE_ENV: config[CUSTODY_PROFILE_ENV], "ENVIRONMENT": "dev"}
        )


def test_dev_profile_keeps_complete_979_family_checks_and_420_421_binding(monkeypatch):
    from db.hosted_custody_qualification import (
        DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256,
        ROLLBACK_SOURCE_PREIMAGES,
        hosted_custody_profile_from_environment,
    )
    from db.migration_authority import build_manifest_entries
    from db.private_agent_adoption import execution_sql

    profile = hosted_custody_profile_from_environment(dev_custody_environment())
    sql = complete_custody_sql(profile)
    assert "function vector or metadata" in sql
    assert "rollback marker shape or ACL" in sql
    assert "rollback preimages" in sql
    assert "upgrade host trigger" in sql
    assert "project grant trigger" in sql
    assert "erasure registry trigger" in sql
    assert "overload or missing function" in sql
    assert DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256 in sql
    assert "hushh_uat_app" in sql
    assert "service_role')" in sql

    from db.hosted_custody_adoption import HOSTED_FILES_QUALIFIED, QUALIFIED

    for digest in (*QUALIFIED.values(), *HOSTED_FILES_QUALIFIED.values()):
        assert digest.encode().hex() in sql
    for digest in ROLLBACK_SOURCE_PREIMAGES.values():
        assert digest.encode().hex() in sql

    entries = build_manifest_entries(
        ROOT / "db/migrations",
        ["420_private_agent_lifecycle_foundation.sql", "421_cloud_removal_recovery.sql"],
    )
    for key, value in dev_custody_environment().items():
        monkeypatch.setenv(key, value)
    for entry in entries:
        replay_sql = execution_sql(entry)
        assert replay_sql.count("Dev database identity") >= 2
        assert DEV_CUSTODY_SYSTEM_IDENTIFIER_SHA256 in replay_sql
        assert "owner-only function ACL" in replay_sql

    invalid_config = dev_custody_environment()
    invalid_config["CLOUDSQL_INSTANCE_CONNECTION_NAME"] = "local-proxy"
    monkeypatch.setenv(
        "HUSHH_HOSTED_CUSTODY_PROFILE", invalid_config["HUSHH_HOSTED_CUSTODY_PROFILE"]
    )
    monkeypatch.setenv("DEV_TARGET", invalid_config["DEV_TARGET"])
    monkeypatch.setenv("GCP_PROJECT_ID", invalid_config["GCP_PROJECT_ID"])
    monkeypatch.setenv(
        "CLOUDSQL_INSTANCE_CONNECTION_NAME", invalid_config["CLOUDSQL_INSTANCE_CONNECTION_NAME"]
    )
    monkeypatch.setenv("DB_NAME", invalid_config["DB_NAME"])
    monkeypatch.setenv("DB_USER", invalid_config["DB_USER"])
    with pytest.raises(ValueError, match="CLOUDSQL_INSTANCE_CONNECTION_NAME"):
        execution_sql(entries[0])


def test_provider_transition_footprint_probe_accepts_prearchive_schema(monkeypatch, tmp_path):
    from db.hosted_custody_adoption import (
        HOSTED_PROVIDER_ACCOUNT_TRANSITION_ARCHIVE_SHA256,
        HOSTED_PROVIDER_ACCOUNT_TRANSITION_QUALIFIED,
        HOSTED_PROVIDER_ACCOUNT_TRANSITION_TRIGGER,
    )
    from db.hosted_custody_qualification import _provider_transition_family_qualification_sql
    from tests.pkm_conformance import postgres_harness
    from tests.pkm_conformance.postgres_harness import TempPostgres

    empty_prelude = tmp_path / "empty-postgres-prelude.sql"
    empty_prelude.write_text("SELECT 1;\n", encoding="utf-8")
    monkeypatch.setattr(postgres_harness, "PRELUDE", empty_prelude)
    monkeypatch.setattr(postgres_harness, "MIGRATIONS", [])
    pg = TempPostgres()
    pg.start()
    try:
        assert pg.execute(
            "SELECT to_regprocedure('public.personal_agent_erasure_archive(jsonb,jsonb)') IS NULL"
        )[0][0]
        pg.execute(
            _provider_transition_family_qualification_sql(
                family=HOSTED_PROVIDER_ACCOUNT_TRANSITION_QUALIFIED,
                trigger=HOSTED_PROVIDER_ACCOUNT_TRANSITION_TRIGGER,
                archive_sha256=HOSTED_PROVIDER_ACCOUNT_TRANSITION_ARCHIVE_SHA256,
                dev_profile=False,
            )
        )
    finally:
        pg.stop()


def test_dev_owner_only_readiness_rejects_wrong_cluster_service_role_and_acl_drift(
    pg, monkeypatch, request, tmp_path
):
    run_dev_owner_only_readiness_scenario(pg, monkeypatch, request, tmp_path)
