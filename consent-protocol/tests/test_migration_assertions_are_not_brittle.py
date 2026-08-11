"""Guard against migration assertions that break on every later migration.

Root cause this prevents
------------------------
Several migration tests asserted that *their* migration was the last entry in
``release_migration_manifest.json``, or that ``expected_migration_version``
equalled *their* exact number. Both are true only until the next migration
lands. Adding migration 132 turned four unrelated, previously-green tests red,
and one (``test_pkm_device_sync_migration``) had already been red on ``main``
for several migrations because nobody noticed it was structurally doomed.

The rule
--------
A migration test may assert that its migration is **registered** and that the
schema contract is **at least** its version. It must not assert last-position or
version equality, because neither is a property of the migration under test —
both are properties of whatever shipped most recently.

Correct forms::

    assert MIGRATION_NAME in manifest["ordered_migrations"]
    assert contract["expected_migration_version"] >= 132

Incorrect forms (rejected by this test)::

    assert manifest["ordered_migrations"][-1] == MIGRATION_NAME
    assert contract["expected_migration_version"] == 132
"""

from __future__ import annotations

import re
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent

# ``ordered_migrations[-1] == ...`` / ``groups["iam"][-1] == ...``
_LAST_POSITION = re.compile(
    r'(?:ordered_migrations|groups"\]\["[a-z_]+)"\]\[-1\]\s*==',
)

# ``expected_migration_version"] == 131``
_EXACT_VERSION = re.compile(
    r'expected_migration_version"\]\s*==\s*\d+',
)

_SELF = Path(__file__).name


def _offending_lines(pattern: re.Pattern[str]) -> list[str]:
    findings: list[str] = []
    for path in sorted(TESTS_DIR.rglob("test_*.py")):
        if path.name == _SELF:
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            if pattern.search(line):
                findings.append(f"{path.relative_to(TESTS_DIR)}:{number}: {stripped}")
    return findings


def test_no_test_asserts_a_migration_is_the_last_registered_one() -> None:
    offenders = _offending_lines(_LAST_POSITION)
    assert not offenders, (
        "A migration test asserts its migration is the LAST manifest entry. That "
        "breaks the moment any later migration ships. Assert membership instead:\n"
        '    assert MIGRATION_NAME in manifest["ordered_migrations"]\n\n' + "\n".join(offenders)
    )


def test_no_test_pins_an_exact_expected_migration_version() -> None:
    offenders = _offending_lines(_EXACT_VERSION)
    assert not offenders, (
        "A migration test pins expected_migration_version to an exact number. "
        "Every later migration bumps it, so use a floor instead:\n"
        '    assert contract["expected_migration_version"] >= <your version>\n\n'
        + "\n".join(offenders)
    )
