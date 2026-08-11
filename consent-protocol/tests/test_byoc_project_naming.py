"""Naming and creating the project a person's pod will live in.

These are the rules a person meets in a form field, so the failure mode that matters is
not a crash — it is telling somebody something untrue about a name they are about to
commit to. Two of the tests here exist entirely because of that: a 403 must not be
rendered as "taken", and delegated creation must not be described as equivalent to
creating the project yourself.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hushh_mcp.services.user_gcp_project import (  # noqa: E402
    CREATION_DELEGATED,
    CREATION_GUIDED,
    check_project_id,
    create_project,
    delegated_creation_disclosure,
    guided_creation_instructions,
    suggest_project_id,
    validate_project_id,
)

OWNER = "HA1PROJECT000001"
OTHER = "HA1PROJECT000002"
FAKE_BEARER = "fake-bearer-for-tests"  # noqa: S105 - no service exists to authenticate to


class _Response:
    def __init__(self, status_code: int, payload=None, text: str = "") -> None:
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text

    def json(self):
        return self._payload


class _Session:
    def __init__(self, response) -> None:
        self._response = response
        self.calls: list[dict] = []

    def get(self, url, headers=None, timeout=None, **kw):
        self.calls.append({"method": "GET", "url": url})
        return self._response

    def post(self, url, headers=None, json=None, timeout=None, **kw):
        self.calls.append({"method": "POST", "url": url, "json": json})
        return self._response


# -- the suggestion ------------------------------------------------------------------


def test_the_suggestion_is_stable_for_a_person() -> None:
    """A name that changed between seeing it and accepting it would be a bad trick."""
    assert suggest_project_id(OWNER).project_id == suggest_project_id(OWNER).project_id


def test_two_people_get_different_suggestions() -> None:
    assert suggest_project_id(OWNER).project_id != suggest_project_id(OTHER).project_id


def test_the_suggestion_is_a_valid_project_id() -> None:
    """The pre-filled value must never be one Google would reject."""
    verdict = validate_project_id(suggest_project_id(OWNER).project_id)
    assert verdict.valid is True


def test_the_suggested_id_does_not_contain_the_hushh_id() -> None:
    """It ends up in URLs, logs and support threads; it must not carry an identifier."""
    pid = suggest_project_id(OWNER).project_id
    assert OWNER.lower() not in pid
    assert OWNER[3:].lower() not in pid


def test_the_suggestion_is_editable_and_says_so() -> None:
    suggestion = suggest_project_id(OWNER)
    assert suggestion.editable is True
    assert "your project" in suggestion.rationale


def test_a_display_hint_names_the_person_without_touching_the_id() -> None:
    """Display names live only in their own console; ids are public surface."""
    plain = suggest_project_id(OWNER)
    hinted = suggest_project_id(OWNER, display_hint="Manish")
    assert hinted.project_id == plain.project_id
    assert "Manish" in hinted.display_name


# -- validation ----------------------------------------------------------------------


@pytest.mark.parametrize(
    "bad,why",
    [
        ("", "empty"),
        ("ab", "too short"),
        ("a" * 31, "too long"),
        ("1starts-with-a-digit", "must start with a letter"),
        ("ends-with-hyphen-", "must not end with a hyphen"),
        ("Has-Capitals", "lowercase only"),
        ("has_underscore", "no underscores"),
        ("my-google-project", "reserved word"),
        ("ssl-thing-here", "reserved word"),
    ],
)
def test_google_s_rules_are_enforced_locally(bad: str, why: str) -> None:
    """Checked here so a person hears about it while typing, not after committing."""
    assert validate_project_id(bad).valid is False, why


def test_a_reasonable_name_passes() -> None:
    assert validate_project_id("my-own-agent-cloud").valid is True


def test_validation_does_no_network_io() -> None:
    """A form-field validator that silently made a network call would be surprising."""
    verdict = validate_project_id("my-own-agent-cloud")
    assert verdict.available is None


# -- availability, and its honest limits ---------------------------------------------


def test_404_means_the_name_is_free() -> None:
    verdict = check_project_id("my-own-agent-cloud", session=_Session(_Response(404)))
    assert verdict.available is True


def test_200_means_the_name_is_taken() -> None:
    verdict = check_project_id("my-own-agent-cloud", session=_Session(_Response(200, {"projectId": "x"})))
    assert verdict.available is False


def test_403_is_reported_as_unknown_not_as_taken() -> None:
    """403 means 'exists but hidden' OR 'we may not look'. Those are different facts.

    Showing a red X for the second would tell a person a perfectly free name is used,
    and they would rename their cloud for no reason.
    """
    verdict = check_project_id("my-own-agent-cloud", session=_Session(_Response(403)))
    assert verdict.available is None
    assert "could not check" in verdict.reason.lower()


def test_an_invalid_name_is_never_probed() -> None:
    """No point asking Google about a name it would reject on sight."""
    session = _Session(_Response(404))
    assert check_project_id("Bad_Name").valid is False
    assert session.calls == []


# -- guided creation: the default, and why -------------------------------------------


def test_guided_instructions_carry_both_a_link_and_a_command() -> None:
    plan = guided_creation_instructions(project_id="my-own-agent-cloud", display_name="My Agent")
    assert plan["mode"] == CREATION_GUIDED
    assert "my-own-agent-cloud" in plan["consoleUrl"]
    assert plan["cliCommand"].startswith("gcloud projects create my-own-agent-cloud")


def test_guided_creation_states_that_hushh_gets_nothing_yet() -> None:
    """The whole point of the default path: the project is theirs from second one."""
    plan = guided_creation_instructions(project_id="my-own-agent-cloud", display_name="My Agent")
    assert "nothing yet" in plan["whatHushhGets"]


def test_guided_creation_warns_about_billing_rather_than_discovering_it_later() -> None:
    """Google refuses almost every API in an unbilled project."""
    plan = guided_creation_instructions(project_id="my-own-agent-cloud", display_name="My Agent")
    assert "billing account" in plan["billingNote"]


# -- delegated creation: available, disclosed, and not the default -------------------


def test_the_disclosure_says_the_grant_is_broader_than_this_one_project() -> None:
    """A person agreeing to this must know it is not scoped to the project they want."""
    d = delegated_creation_disclosure(parent_type="organization", parent_id="123")
    assert d["grant"] == "roles/resourcemanager.projectCreator"
    assert "not only this one" in d["meaning"]
    assert "single service account" in d["why_this_is_larger"]
    assert "yourself" in d["alternative"]
    assert "Remove" in d["revocation"]


def test_delegated_creation_refuses_to_guess_a_parent() -> None:
    """Creating a project somewhere the person did not name is not a thing to infer."""
    with pytest.raises(ValueError, match="never guessed"):
        create_project(
            project_id="my-own-agent-cloud",
            display_name="My Agent",
            parent_type="organization",
            parent_id="",
            token=FAKE_BEARER,
            session=_Session(_Response(200)),
        )


def test_delegated_creation_refuses_an_invalid_id_before_calling_google() -> None:
    session = _Session(_Response(200))
    with pytest.raises(ValueError):
        create_project(
            project_id="Bad_Name",
            display_name="My Agent",
            parent_type="organization",
            parent_id="123",
            token=FAKE_BEARER,
            session=session,
        )
    assert session.calls == []


def test_a_created_project_is_labelled_user_owned() -> None:
    session = _Session(_Response(200, {"name": "operations/abc"}))
    result = create_project(
        project_id="my-own-agent-cloud",
        display_name="My Agent",
        parent_type="organization",
        parent_id="123",
        token=FAKE_BEARER,
        session=session,
    )
    assert result["ok"] is True
    assert result["mode"] == CREATION_DELEGATED
    assert session.calls[0]["json"]["labels"]["tenancy"] == "user-owned"


def test_creation_does_not_report_the_project_as_usable() -> None:
    """Creating a project does not pay for it, and an unbilled project runs nothing.

    Reporting 'created' as if it were ready is how somebody ends up debugging a
    bootstrap failure that was really a missing billing link.
    """
    result = create_project(
        project_id="my-own-agent-cloud",
        display_name="My Agent",
        parent_type="organization",
        parent_id="123",
        token=FAKE_BEARER,
        session=_Session(_Response(200, {"name": "operations/abc"})),
    )
    assert "billing" in result["next"]


def test_a_failed_creation_is_not_reported_as_ok() -> None:
    result = create_project(
        project_id="my-own-agent-cloud",
        display_name="My Agent",
        parent_type="organization",
        parent_id="123",
        token=FAKE_BEARER,
        session=_Session(_Response(409, text="already exists")),
    )
    assert result["ok"] is False
    assert result["status"] == 409
