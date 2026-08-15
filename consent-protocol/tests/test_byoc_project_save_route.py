"""Recording a person's cloud must PROVE the grant, not believe the form.

This route is what ends BYOC's single tenancy. Before it, the target project was
`os.getenv("HUSSH_USER_GCP_PROJECT")` -- one value for the whole deployment -- so the
second person to choose their own cloud would have had their pod, their bucket and
their KMS key built inside the first person's project.

The tests below are about the two properties that make the route worth having:

  1. `authorized` is established by minting a token, never by the request body. A
     person clicking "I ran the script" is not evidence that they ran it, and the
     failure that follows a wrong answer lands three steps into provisioning, inside
     someone else's cloud, with an error naming none of this.

  2. `hushhCaller` is returned on BOTH outcomes. It is the one value
     `deploy/iam/authorize_byoc_project.sh` cannot run without, and the moment a person
     needs it is precisely the moment they are NOT yet authorized. Returning it only on
     success would make the journey unrunnable.
"""

from __future__ import annotations

import pytest

from api.routes.one import runtime as runtime_routes


class _FakeRepo:
    """Captures what the route wrote, and whether a row existed at all."""

    def __init__(self, *, row_exists: bool = True) -> None:
        self.row_exists = row_exists
        self.calls: list[dict] = []

    async def set_user_cloud(self, **kwargs):
        self.calls.append(kwargs)
        return self.row_exists


@pytest.fixture
def wiring(monkeypatch):
    """Swap the two things that reach outside the process: IAM and the registry."""
    repo = _FakeRepo()
    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_registry_repo.PersonalAgentRegistryRepo",
        lambda *a, **k: repo,
    )
    monkeypatch.setenv(
        "HUSSH_CONSENT_PLANE_SA", "consent-protocol-runtime@hushh.iam.gserviceaccount.com"
    )
    return repo


def _grant_present(monkeypatch):
    monkeypatch.setattr(
        "hushh_mcp.services.user_gcp_bootstrap.mint_bootstrap_token",
        lambda **kwargs: "ya29.short-lived",
    )


def _grant_absent(monkeypatch):
    from hushh_mcp.services.user_gcp_bootstrap import BootstrapError

    def _raise(**kwargs):
        raise BootstrapError("could not impersonate: grant missing or revoked")

    monkeypatch.setattr("hushh_mcp.services.user_gcp_bootstrap.mint_bootstrap_token", _raise)


async def _save(**overrides):
    body = runtime_routes.ByocProjectSaveRequest(
        projectId=overrides.pop("projectId", "their-own-project"), **overrides
    )
    return await runtime_routes.save_byoc_project.__wrapped__(
        request=None, body=body, firebase_uid="uid-123"
    )


async def test_authorization_is_proven_by_minting_a_token(wiring, monkeypatch):
    """A real grant is what sets `authorized`, and it stamps the row's proof."""
    _grant_present(monkeypatch)

    result = await _save()

    assert result.authorized is True
    assert wiring.calls[0]["authorized"] is True
    assert wiring.calls[0]["project"] == "their-own-project"
    assert wiring.calls[0]["deployment_target"] == "user_gcp"
    assert wiring.calls[0]["model_credential_mode"] == "user_adc"


async def test_a_missing_grant_records_the_cloud_without_the_proof(wiring, monkeypatch):
    """Named-but-not-authorized is a normal onboarding stage, not an error.

    Broken on purpose: set `authorized = True` before the try block and this fails --
    which is the whole point, because provisioning refuses an unauthorized cloud rather
    than falling back to hushh's own.
    """
    _grant_absent(monkeypatch)

    result = await _save()

    assert result.authorized is False
    assert wiring.calls[0]["authorized"] is False
    # Recorded anyway: they need the coordinates kept while they go and run the script.
    assert wiring.calls[0]["project"] == "their-own-project"


async def test_the_caller_identity_is_returned_even_when_unauthorized(wiring, monkeypatch):
    """Without this value the authorization script cannot be run at all.

    HUSSH_CONSENT_PLANE_SA appeared nowhere a person could see it, so the documented
    journey was literally unrunnable. Returning it only on success would keep it that
    way, because the moment it is needed is the moment `authorized` is False.

    Broken on purpose: return hushhCaller only when authorized and this fails.
    """
    _grant_absent(monkeypatch)

    result = await _save()

    assert result.hushhCaller == "consent-protocol-runtime@hushh.iam.gserviceaccount.com"
    assert "HUSHH_CALLER=consent-protocol-runtime@hushh.iam.gserviceaccount.com" in result.nextStep
    assert "PROJECT_ID=their-own-project" in result.nextStep


async def test_the_caller_identity_is_normalized_out_of_iam_member_form(wiring, monkeypatch):
    """The same principal is spelled two ways, and the prefixed form breaks IAM.

    Handing someone `serviceAccount:...` has them build `serviceAccount:serviceAccount:...`,
    which IAM rejects with a 400 on every setIamPolicy, in their own project, with
    nothing naming the cause.
    """
    _grant_present(monkeypatch)
    monkeypatch.setenv(
        "HUSSH_CONSENT_PLANE_SA",
        "serviceAccount:consent-protocol-runtime@hushh.iam.gserviceaccount.com",
    )

    result = await _save()

    assert result.hushhCaller == "consent-protocol-runtime@hushh.iam.gserviceaccount.com"


async def test_the_bootstrap_account_matches_what_the_script_creates(wiring, monkeypatch):
    """deploy/iam/authorize_byoc_project.sh defaults BOOTSTRAP_SA_ID to `one-bootstrap`.

    Probing a different account would report every correctly-authorized person as
    unauthorized.
    """
    _grant_present(monkeypatch)

    result = await _save()

    assert result.bootstrapServiceAccount == (
        "one-bootstrap@their-own-project.iam.gserviceaccount.com"
    )
    assert wiring.calls[0]["bootstrap_sa"] == result.bootstrapServiceAccount


async def test_an_invalid_project_id_is_refused_before_any_iam_call(wiring, monkeypatch):
    from fastapi import HTTPException

    def _must_not_run(**kwargs):
        raise AssertionError("IAM was called for a project id that is not even valid")

    monkeypatch.setattr("hushh_mcp.services.user_gcp_bootstrap.mint_bootstrap_token", _must_not_run)

    with pytest.raises(HTTPException) as excinfo:
        await _save(projectId="Not A Valid Project")

    assert excinfo.value.status_code == 422


async def test_a_person_with_no_agent_record_is_told_rather_than_half_saved(monkeypatch):
    """Row creation belongs to phone verification, which alone has the HusshID."""
    from fastapi import HTTPException

    repo = _FakeRepo(row_exists=False)
    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_registry_repo.PersonalAgentRegistryRepo",
        lambda *a, **k: repo,
    )
    monkeypatch.setenv(
        "HUSSH_CONSENT_PLANE_SA", "consent-protocol-runtime@hushh.iam.gserviceaccount.com"
    )
    _grant_present(monkeypatch)

    with pytest.raises(HTTPException) as excinfo:
        await _save()

    assert excinfo.value.status_code == 409
    assert excinfo.value.detail["code"] == "NO_AGENT_RECORD"
