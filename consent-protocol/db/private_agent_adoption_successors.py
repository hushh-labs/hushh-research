"""Exact successor pins for immutable private-agent adoption guards."""

from __future__ import annotations

from db.hosted_custody_qualification import QUALIFIED_FAMILY_SETTING

_WORKER_EVENT_SUCCESSOR_SHA256 = "460ee7e26e2e65acd6937e29284f5d5f0c38013829337e8aa5ec03c27173a91c"


def _qualify_vm_publication_successor(sql: str) -> str:
    """Admit the exact host-binding VM proof only behind the complete family gate."""
    from db.migration_authority import MigrationAuthorityError

    anchor = (
        "ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN "
        "('5329963e73fc583df179883023536066a523583372c6ebd860d40df84107b918') THEN"
    )
    replacement = (
        "ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN "
        "('5329963e73fc583df179883023536066a523583372c6ebd860d40df84107b918') "
        "AND NOT ((current_setting('"
        + QUALIFIED_FAMILY_SETTING
        + "',true)='true') IS TRUE AND encode(sha256(convert_to(actual,'UTF8')),'hex')="
        "'1748051f173f41e3fdbed624b30a1027658a4448ae8592e6287196bc15bdc4fb') THEN"
    )
    if sql.count(anchor) != 1:
        raise MigrationAuthorityError("Private-agent Azure VM publication guard shape changed")
    return sql.replace(anchor, replacement, 1)


def _qualify_erasure_substrate_successor(sql: str) -> str:
    """Admit the exact 979 substrate validator only behind the complete family gate."""
    from db.migration_authority import MigrationAuthorityError

    anchor = (
        "ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN "
        "('9f42b37fa525127a5d18761ab6efbac6b00230627e4901aeac4d2fe467d85205') THEN"
    )
    replacement = (
        "ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN "
        "('9f42b37fa525127a5d18761ab6efbac6b00230627e4901aeac4d2fe467d85205') "
        "AND NOT ((current_setting('"
        + QUALIFIED_FAMILY_SETTING
        + "',true)='true') IS TRUE AND encode(sha256(convert_to(actual,'UTF8')),'hex')="
        "'a46891a22a5a07be0de6edcaa8e195b26f47951b8abf5fa5bfddec2b2b60c3ba') THEN"
    )
    if sql.count(anchor) != 1:
        raise MigrationAuthorityError("Private-agent erasure substrate guard shape changed")
    return sql.replace(anchor, replacement, 1)


def _qualify_worker_event_successor(sql: str) -> str:
    """Admit the measured worker-event successor behind the complete family gate."""
    from db.migration_authority import MigrationAuthorityError

    anchor = (
        "ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN "
        "('95233dcf09e1b7a056cf3d846beb562e157ebf5be907ba33592e96cd45654cb4') THEN"
    )
    successor = _WORKER_EVENT_SUCCESSOR_SHA256
    replacement = (
        "ELSIF encode(sha256(convert_to(actual,'UTF8')),'hex') NOT IN "
        "('95233dcf09e1b7a056cf3d846beb562e157ebf5be907ba33592e96cd45654cb4') "
        "AND NOT ((current_setting('"
        + QUALIFIED_FAMILY_SETTING
        + "',true)='true') IS TRUE AND encode(sha256(convert_to(actual,'UTF8')),'hex')="
        f"'{successor}') THEN"
    )
    if sql.count(anchor) != 1:
        raise MigrationAuthorityError("Private-agent Azure worker-event guard shape changed")
    return sql.replace(anchor, replacement, 1)


def qualify_private_agent_successors(sql: str) -> str:
    """Accept only measured successor validators under the full custody-family GUC."""
    sql = _qualify_vm_publication_successor(sql)
    sql = _qualify_erasure_substrate_successor(sql)
    return _qualify_worker_event_successor(sql)
