"""Migration 160 makes a Circle the product depends on undeletable.

Issue #5426 turns SMS emergency contacts into a real Circle. A real Circle can
be deleted, and this one must not be: SOS resolves its recipients from the
roster, so deleting it is indistinguishable from silently switching emergency
alerts off -- a failure that surfaces only at the moment it matters.

The assertions below are about shape, because the release-migration gate reads
these same files. The runtime behaviour (both delete paths refused, ordinary
Circles unaffected, the row still editable) was exercised against a real
Postgres 16 while writing the migration; what is guarded here is that the
guard, the index and the flag do not quietly go missing.
"""

from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
MANIFEST_PATH = REPO_ROOT / "db" / "release_migration_manifest.json"
CONTRACTS_DIR = REPO_ROOT / "db" / "contracts"
SERVICE_PATH = REPO_ROOT / "hushh_mcp" / "services" / "one_location_circle_service.py"

MIGRATION = "160_one_location_system_circles.sql"
ROLLBACK = "160_one_location_system_circles.rollback.sql"


def _migration() -> str:
    return (MIGRATIONS_DIR / MIGRATION).read_text(encoding="utf-8")


def _rollback() -> str:
    return (MIGRATIONS_DIR / "rollback" / ROLLBACK).read_text(encoding="utf-8")


def _service() -> str:
    return SERVICE_PATH.read_text(encoding="utf-8")


def _statements(sql: str) -> str:
    """The executable half of a migration, with `--` commentary stripped.

    These files explain themselves at length, and the commentary necessarily
    names the things the migration deliberately does NOT touch. Asserting
    absence against the raw text fails on the sentence explaining the absence.
    """
    lines = [
        line.split("--", 1)[0] for line in sql.splitlines() if not line.lstrip().startswith("--")
    ]
    return chr(10).join(lines)


def _ensure_hook() -> str:
    """Just `ensure_sms_system_circle` and the helpers it delegates to.

    The service is 3000+ lines and legitimately deletes SMS contact rows
    elsewhere -- `_cleanup_ineligible_sms_contacts` prunes them when an account
    is deleted. Scoping to the migration hook is what makes "this hook reads,
    never empties" a real assertion rather than a claim about the whole file.
    """
    service = _service()
    start = service.index("    def ensure_sms_system_circle(")
    end = service.index("    def update_circle(", start)
    return service[start:end]


def test_system_circle_migration_is_registered_in_release_order() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    assert (MIGRATIONS_DIR / MIGRATION).exists()
    assert (MIGRATIONS_DIR / "rollback" / ROLLBACK).exists()
    # Registered and ordered after the table it alters, rather than pinned as
    # the release head -- see the same note in the 158 test.
    ordered = manifest["ordered_migrations"]
    assert MIGRATION in ordered
    assert ordered.index("134_one_location_named_circles.sql") < ordered.index(MIGRATION)
    assert MIGRATION in manifest["groups"]["iam"]


def test_schema_contracts_require_the_new_column() -> None:
    for name in ("prod_core_schema.json", "uat_integrated_schema.json"):
        contract = json.loads((CONTRACTS_DIR / name).read_text(encoding="utf-8"))
        assert contract["expected_migration_version"] >= 160, name
        # The service selects this column on every Circle read, so a database
        # without it is not one this build can run against.
        assert "is_system" in contract["required_tables"]["one_location_circles"], name


def test_migration_guards_both_delete_paths() -> None:
    migration = _migration()

    assert "ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false" in migration
    assert "CREATE TRIGGER one_location_circles_block_system_delete" in migration
    assert "BEFORE DELETE OR UPDATE ON one_location_circles" in migration
    # Hard delete.
    assert "TG_OP = 'DELETE'" in migration
    # Soft delete -- the one `delete_circle` actually takes. Guarding only the
    # hard path would guard the path nothing takes.
    assert "NEW.status = 'deleted'" in migration
    assert "restrict_violation" in migration


def test_one_live_system_circle_per_owner() -> None:
    migration = _migration()

    # `ensure_sms_system_circle` is a find-or-create that runs on every
    # bootstrap, potentially from two devices at once. Without this a race
    # writes two Circles and SOS reads whichever it finds first.
    assert "CREATE UNIQUE INDEX IF NOT EXISTS uq_one_location_circles_owner_system" in migration
    assert "WHERE is_system AND status = 'active'" in migration


def test_migration_provisions_nothing_by_itself() -> None:
    migration = _migration()

    # Provisioning belongs to the service, where the membership write can fan
    # out through the connection graph like every other Circle join.
    statements = _statements(migration)
    assert "INSERT INTO one_location_circles" not in statements
    assert "INSERT INTO one_location_circle_memberships" not in statements
    assert "one_location_sms_contacts" not in statements


def test_rollback_keeps_the_circles_it_can_no_longer_protect() -> None:
    rollback = _rollback()

    assert "DROP TRIGGER IF EXISTS one_location_circles_block_system_delete" in rollback
    assert "DROP COLUMN IF EXISTS is_system" in rollback
    # Dropping the flag does not unmake a membership or a connection, and
    # deleting the Circles to "clean up" would destroy the contact list SOS
    # reads. A rollback returns the shape and keeps the data.
    assert "DELETE FROM one_location_circles" not in rollback
    assert "DELETE FROM one_location_circle_memberships" not in rollback
    assert "DROP TABLE IF EXISTS one_location_sms_contacts" not in rollback


def test_service_refuses_to_delete_a_system_circle() -> None:
    service = _service()

    assert "LOCATION_CIRCLE_SYSTEM_PROTECTED" in service
    assert "_reject_system_circle_delete" in service
    # Called before the statement runs, so the API answers with a sentence
    # rather than surfacing a raw trigger violation as a 500.
    assert "self._reject_system_circle_delete(cleaned_circle_id)" in service


def test_service_migration_never_resurrects_a_removed_contact() -> None:
    hook = _ensure_hook()

    # The bootstrap hook re-runs on every login. Inserting every SMS contact
    # unconditionally would undo a removal the owner made on purpose, and would
    # do it silently, every time they signed in.
    assert "NOT EXISTS (" in hook
    assert "FROM one_location_circle_memberships m" in hook
    # Read, never emptied: the legacy table stays for one release so backing
    # this change out cannot lose anybody's emergency contacts. (Account
    # deletion still prunes it elsewhere -- that is a different question.)
    assert "DELETE FROM one_location_sms_contacts" not in hook
    assert "TRUNCATE" not in hook


def test_deleting_your_whole_account_can_still_delete_your_system_circle() -> None:
    """The trigger and the escape from it are one decision, not two.

    Migration 160's `one_location_circles_block_system_delete` refuses to hard-
    or soft-delete any is_system Circle, so no ordinary product path can
    silently switch off somebody's SOS roster. It was written thinking about
    the Circles surface and broke a screen nobody was looking at: account
    deletion and account reset both issue an unconditional
    DELETE FROM one_location_circles for the owner, so every user who had
    logged in since -- ensure_sms_system_circle provisions on bootstrap -- got
    a RestrictViolation and a 500 from /api/account/delete (#5574).

    "You cannot delete your emergency list" and "you cannot delete your
    account" are not the same sentence. The first protects a live account from
    a careless tap; it has nothing left to protect once the identity it served
    is being wiped. account_service demotes is_system in the same transaction
    immediately before the delete.

    This test exists so the two halves cannot be changed independently again.
    Tighten the trigger and this fails; drop the demotion and this fails.
    """

    from pathlib import Path

    migration = Path(__file__).resolve().parents[1] / "db" / "migrations"
    trigger_sql = (migration / "160_one_location_system_circles.sql").read_text(encoding="utf-8")

    # Half one: the trigger still refuses both delete shapes.
    assert "one_location_circles_block_system_delete" in trigger_sql
    assert "BEFORE DELETE OR UPDATE ON one_location_circles" in trigger_sql

    # Half two: account deletion still has its way past it.
    account_service = (
        Path(__file__).resolve().parents[1] / "hushh_mcp" / "services" / "account_service.py"
    ).read_text(encoding="utf-8")
    assert "SET is_system = FALSE" in account_service
    demote_index = account_service.index("SET is_system = FALSE")
    delete_index = account_service.index("DELETE FROM one_location_circles")
    assert demote_index < delete_index, (
        "the demotion must run BEFORE the delete it exists to unblock"
    )


def test_deletion_is_the_only_power_a_system_circle_removes() -> None:
    service = _service()

    # The Circle cannot be deleted...
    assert '"canDeleteCircle": is_owner and not is_system' in service
    # ...and that is the whole of it. Members see each other here on the same
    # terms as any other Circle: if something happens to the owner, the people
    # on the emergency list are the ones who may need to reach each other, and
    # a roster only the owner can read is useless exactly then.
    assert "canViewRoster" not in service


def test_system_circle_adds_take_effect_without_an_invitation() -> None:
    service = _service()

    # An emergency contact has never needed the other person's agreement --
    # add_sms_contact (migration 116) added them outright. Routing system-Circle
    # adds through the pending-invitation flow would change that in the worst
    # direction: the owner sees someone on their emergency list, believes SOS
    # will reach them, and it will not until an invitation nobody mentioned is
    # accepted.
    # The membership records HOW someone got there, so a system-Circle add
    # stays distinguishable from an ordinary one long after the fact.
    assert '"sms_system_circle" if is_system_circle else "direct_add"' in service
    assert "INSERT INTO one_location_circle_memberships" in service

    # Every OTHER Circle used to require acceptance, and this test used to
    # assert that the two paths stayed apart. They no longer do, and the reason
    # is that the wall was in the wrong place: only ACTIVE DIRECT CONNECTIONS
    # can be added to any Circle, so both people had already chosen each other
    # before the sheet opened. The invitation asked a question that had been
    # answered, and made the asker wait 72 hours for the echo.
    #
    # What used to be the invitation's job is now split between two things that
    # already existed: connecting is where the consent is, and leaving is where
    # the exit is.
    assert "INSERT INTO one_location_circle_member_invites" not in service
    assert "LOCATION_CIRCLE_DIRECT_CONNECTION_REQUIRED" in service

    # And the exemption that makes a system Circle different survives the
    # merge: nobody on an emergency list is introduced to anybody else on it.
    assert "if not is_system_circle:" in service
    assert "_connect_member_to_circle" in service
