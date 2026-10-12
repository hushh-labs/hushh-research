"""Public/private identity boundaries of the cumulative Magic rollout."""

from types import SimpleNamespace

import pytest

from hushh_mcp.services.magic_intelligence_admission import (
    PILOT_EMAIL,
    magic_intelligence_emails,
    magic_intelligence_owner_admitted,
)

INNER = [f"inner-{i}@example.test" for i in range(4)]
SENIOR = [f"senior-{i}@example.test" for i in range(4)]
QA = ["qa@example.test"]
MEMBERS = [
    (PILOT_EMAIL, 1),
    *[(email, 2) for email in INNER],
    *[(email, 3) for email in SENIOR],
    (QA[0], 4),
]


@pytest.fixture
def cohort(monkeypatch):
    for name, emails in (("INNER_TEAM", INNER), ("SENIOR_TEAM", SENIOR), ("QA", QA)):
        monkeypatch.setenv(f"ONE_MAGIC_INTELLIGENCE_{name}_EMAILS", ",".join(emails))
    return SimpleNamespace(uid="owner", disabled=False, email_verified=True, email=PILOT_EMAIL)


@pytest.mark.parametrize("phase", range(5))
@pytest.mark.parametrize("email,minimum", MEMBERS)
def test_only_the_current_and_previous_named_cohorts_are_admitted(
    monkeypatch, cohort, phase, email, minimum
):
    monkeypatch.setenv("ONE_MAGIC_INTELLIGENCE_PHASE", str(phase))
    cohort.email = email
    assert magic_intelligence_owner_admitted("owner", cohort) is (phase >= minimum)
    assert len(magic_intelligence_emails()) == [0, 1, 5, 9, 10][phase]


@pytest.mark.parametrize("phase", [None, "", "all", "5", "-1", "1.0", "01"])
def test_missing_or_invalid_phase_denies_every_owner(monkeypatch, cohort, phase):
    if phase is None:
        monkeypatch.delenv("ONE_MAGIC_INTELLIGENCE_PHASE", raising=False)
    else:
        monkeypatch.setenv("ONE_MAGIC_INTELLIGENCE_PHASE", phase)
    assert not magic_intelligence_owner_admitted("owner", cohort)


@pytest.mark.parametrize(
    "roster",
    [
        "",
        ",".join(INNER[:3]),
        ",".join(INNER + QA),
        ",".join(INNER[:3] + [INNER[0]]),
        ",".join(INNER[:3] + [PILOT_EMAIL]),
        ",".join(INNER[:3] + ["*@example.test"]),
        ",".join(INNER[:3] + ["not an email"]),
        ",".join(INNER[:3] + ["owner-uid"]),
    ],
)
def test_incomplete_or_ambiguous_promotion_closes_the_whole_feature(monkeypatch, cohort, roster):
    monkeypatch.setenv("ONE_MAGIC_INTELLIGENCE_PHASE", "2")
    monkeypatch.setenv("ONE_MAGIC_INTELLIGENCE_INNER_TEAM_EMAILS", roster)
    assert not magic_intelligence_owner_admitted("owner", cohort)


@pytest.mark.parametrize(
    "email",
    [
        "parth.mawi.12@gmail.com",
        "parthmawai12@gmail.com",
        "parth.mawai.12+pilot@gmail.com",
        "parth.mawai.12@googlemail.com",
        "parth@hushh.ai",
        None,
        "",
        "inner-0@example.test",
    ],
)
def test_pilot_is_the_exact_corrected_primary_email(monkeypatch, cohort, email):
    monkeypatch.setenv("ONE_MAGIC_INTELLIGENCE_PHASE", "1")
    cohort.email = email
    assert not magic_intelligence_owner_admitted("owner", cohort)


@pytest.mark.parametrize(
    "field,value",
    [("uid", "other"), ("disabled", True), ("email_verified", False), ("email_verified", "true")],
)
def test_aliases_phone_and_shadow_claims_never_replace_fresh_owner_identity(
    monkeypatch, cohort, field, value
):
    monkeypatch.setenv("ONE_MAGIC_INTELLIGENCE_PHASE", "1")
    cohort.phone_number = "+15555550123"
    setattr(cohort, field, value)
    assert not magic_intelligence_owner_admitted("owner", cohort)


def test_case_and_outer_whitespace_are_safe_and_rollback_is_uncached(monkeypatch, cohort):
    monkeypatch.setenv("ONE_MAGIC_INTELLIGENCE_PHASE", "1")
    cohort.email = f" {PILOT_EMAIL.upper()} "
    assert magic_intelligence_owner_admitted("owner", cohort)
    monkeypatch.setenv("ONE_MAGIC_INTELLIGENCE_PHASE", "0")
    assert not magic_intelligence_owner_admitted("owner", cohort)


def test_later_invalid_cohorts_do_not_block_an_earlier_phase(monkeypatch, cohort):
    monkeypatch.setenv("ONE_MAGIC_INTELLIGENCE_PHASE", "1")
    monkeypatch.setenv("ONE_MAGIC_INTELLIGENCE_INNER_TEAM_EMAILS", "unconfirmed")
    assert magic_intelligence_owner_admitted("owner", cohort)
    monkeypatch.setenv("ONE_MAGIC_INTELLIGENCE_PHASE", "2")
    assert not magic_intelligence_owner_admitted("owner", cohort)
