"""Every `ALTER TABLE ... ADD CONSTRAINT` must survive being run twice.

Root cause this prevents
------------------------
Both consent-protocol environments run the FULL migration set in replay mode
on every deploy. There is no ledger that skips already-applied files, so a
migration is re-executed against a database it already applied cleanly to --
and Postgres has no `ADD CONSTRAINT IF NOT EXISTS`. An unguarded add is
therefore fine exactly once and fatal from the second deploy onward.

Migration 158 shipped without that property. Its DO block dropped every stale
`member_limit` CHECK constraint *except* the one it was about to create:

    AND con.conname <> 'one_location_circles_member_limit_bounds'

so it cleared every historical name and left the target name -- which is
precisely the name its own previous run leaves behind. The next deploy that
replayed it died with `DuplicateObjectError: constraint
"one_location_circles_member_limit_bounds" ... already exists`, the
transaction aborted, the advisory unlock then failed with
`InFailedSQLTransactionError`, and the release rolled both Cloud Run
revisions back. 159 was written by copying 158's shape and inherited the same
bug before it had ever run once.

That happened, was fixed, was deleted wholesale by the mass revert
`a60c51dfc`, shipped broken a second time, and was fixed again in #5641 --
this time with no test. This file is the guard, so there is no third time.

Why a whole-set rule rather than two assertions
-----------------------------------------------
The bug is not a property of migration 158. It is a property of the idiom, and
158 got it wrong by copying a neighbour. A test pinned to 158 and 159 would
have caught neither the original nor the copy. All 96 add-constraint sites on
`main` already satisfy this rule, so it costs nothing today and refuses the
next copy of the mistake.

Static by design: this reads the shipped SQL rather than exercising a live
database, so it runs in the ordinary unit lane with no Postgres to stand up --
the same choice every other migration test in this directory makes.
"""

from __future__ import annotations

import re
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "db" / "migrations"

_ADD_CONSTRAINT = re.compile(r"ADD\s+CONSTRAINT\s+([a-zA-Z0-9_]+)", re.IGNORECASE)


# `DROP CONSTRAINT x`, with or without IF EXISTS, and whether it sits at the
# top level or inside an `IF EXISTS (...) THEN ... END IF` block. Both are
# replay-safe; only the second is needed when the constraint may be absent.
def _dropped_before(name: str, text: str) -> bool:
    return bool(
        re.search(
            r"DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?" + re.escape(name) + r"\b",
            text,
            re.IGNORECASE,
        )
    )


# The other accepted idiom: the add is wrapped in a NOT EXISTS check naming
# this constraint, so a replay simply skips it. Both catalogue spellings are
# in use -- `pg_constraint.conname` and
# `information_schema.constraint_column_usage.constraint_name` -- and either
# answers the same question.
def _guarded_by_not_exists(name: str, text: str) -> bool:
    for opener in re.finditer(r"IF\s+NOT\s+EXISTS\s*\(", text, re.IGNORECASE):
        window = text[opener.start() :]
        if re.search(
            r"(?:conname|constraint_name)\s*=\s*'" + re.escape(name) + r"'",
            window,
            re.IGNORECASE,
        ):
            return True
    return False


def _executable(sql: str) -> str:
    """The executable half of a migration, with `--` commentary stripped.

    These files explain themselves at length and quote the shapes they are
    replacing, so a raw-text search would accept a migration whose only
    remaining drop lives in a sentence describing the bug it once had.
    """
    return "\n".join(
        line.split("--", 1)[0] for line in sql.splitlines() if not line.lstrip().startswith("--")
    )


def _unguarded_adds() -> list[str]:
    findings: list[str] = []
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        sql = _executable(path.read_text(encoding="utf-8"))
        for match in _ADD_CONSTRAINT.finditer(sql):
            name = match.group(1)
            preceding = sql[: match.start()]
            if _dropped_before(name, preceding):
                continue
            if _guarded_by_not_exists(name, preceding):
                continue
            findings.append(f"{path.name}: {name}")
    return findings


def test_every_added_constraint_survives_a_replay() -> None:
    unguarded = _unguarded_adds()
    assert not unguarded, (
        "These constraints are added without surviving a second run, which is "
        "what every deploy does:\n  "
        + "\n  ".join(unguarded)
        + "\n\nPostgres has no ADD CONSTRAINT IF NOT EXISTS. Use one of the two "
        "idioms already used throughout this directory:\n"
        "  1. DROP CONSTRAINT IF EXISTS <name>;  immediately before the ADD\n"
        "  2. wrap the ADD in IF NOT EXISTS (SELECT ... conname = '<name>')\n"
        "Excluding the target name from a cleanup loop is NOT one of them: "
        "that name is exactly what the migration's own previous run left behind."
    )


def test_the_two_circle_migrations_that_caused_this_are_covered() -> None:
    """The rule is general, but these two are why it exists.

    Named explicitly so that deleting them from the migration set -- which has
    already happened once, via the mass revert -- cannot quietly reduce this
    file to a rule with nothing left to check.
    """
    for migration, constraint in (
        (
            "158_one_location_circle_member_limit_100.sql",
            "one_location_circles_member_limit_bounds",
        ),
        (
            "159_one_location_circle_invite_max_uses_100.sql",
            "one_location_circle_invite_codes_max_uses_bounds",
        ),
    ):
        path = MIGRATIONS_DIR / migration
        assert path.exists(), f"{migration} is missing from the migration set"
        sql = _executable(path.read_text(encoding="utf-8"))

        added = re.search(
            r"ADD\s+CONSTRAINT\s+" + re.escape(constraint) + r"\b", sql, re.IGNORECASE
        )
        assert added is not None, f"{migration} no longer adds {constraint}"

        preceding = sql[: added.start()]
        assert _dropped_before(constraint, preceding) or _guarded_by_not_exists(
            constraint, preceding
        ), f"{migration} adds {constraint} without dropping or guarding it first"
