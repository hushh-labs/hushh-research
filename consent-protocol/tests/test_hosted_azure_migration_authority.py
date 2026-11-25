# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Contracts for additive migration 461 hosted-Azure successor qualifications."""

from __future__ import annotations

import hashlib

from db import private_agent_adoption, private_agent_adoption_successors


def test_hosted_azure_target_check_hash_matches_successor_pin() -> None:
    """The migration 461 CHECK definition digest matches the successor allowlists."""
    expected_sha = hashlib.sha256(
        private_agent_adoption.HOSTED_AZURE_TARGET_CHECK_DEFINITION.encode("utf-8")
    ).hexdigest()
    assert private_agent_adoption.HOSTED_AZURE_TARGET_CHECK_SHA256 == expected_sha
    assert (
        private_agent_adoption_successors._HOSTED_AZURE_TARGET_CHECK_SUCCESSOR_SHA256
        == expected_sha
    )


def test_qualify_hosted_azure_target_check_successor_admits_461() -> None:
    """Replay SQL admits the migration 461 constraint SHA alongside baseline 420."""
    sample = (
        "ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN "
        "('15c9243d622f15d2ca2690cb232af88e3e51b5d586e72042b9000177cc4cc300') THEN\n"
        "  RAISE EXCEPTION 'Unqualified schema drift: personal_agent_registry_deployment_target_check';"
    )
    updated = private_agent_adoption_successors._qualify_hosted_azure_target_check_successor(sample)
    assert private_agent_adoption.HOSTED_AZURE_TARGET_CHECK_SHA256 in updated
    assert "15c9243d622f15d2ca2690cb232af88e3e51b5d586e72042b9000177cc4cc300" in updated


def test_retention_inventory_includes_hosted_azure_constraints() -> None:
    """Private-agent retention inventory admits both migration 461 table checks."""
    sample_sql = (
        " IF EXISTS(SELECT 1 FROM pg_constraint k JOIN pg_class c"
        " ON c.oid=k.conrelid WHERE true) expected(t,name,definition,validated)"
        " THEN RAISE EXCEPTION 'Unqualified private-agent constraint drift'; END IF;"
    )
    updated = private_agent_adoption._retention_inventory_sql(sample_sql)
    assert "personal_agent_registry_deployment_target_check" in updated
    assert private_agent_adoption.HOSTED_AZURE_NO_OWNER_CLOUD_CHECK in updated
