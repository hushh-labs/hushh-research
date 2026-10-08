"""The moment a person is asked to hand over a cloud project, and what they are shown.

Two defects met here, and they were the same defect from opposite sides.

The setup page told people to run `bash deploy/iam/authorize_byoc_project.sh`. That path
exists only in this repository, so whenever the one-click OAuth route was unavailable or
refused, the journey dead-ended on an instruction nobody outside the team could follow --
at exactly the step that decides whether their agent is built in their own cloud.

And `authorization_request`, written for precisely this moment ("here is every role, here
is what hushh never receives, here is how to take it back"), had no production caller at
all. So the person was shown a shell command and no account of what it does.

Serving the checked-in file would not have fixed the first: `deploy/` is at the repo root
and the backend image's build context is `consent-protocol`, so the file is not in the
image and reading it at runtime would 500 in production while passing every local test.
The script is rendered from the same tuples the applier binds instead.
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

import pytest
from fastapi import HTTPException

from api.routes.one import runtime as runtime_routes
from hushh_mcp.services.user_cloud_service import UserCloud

_PROJECT = "alices-own-cloud"
_BOOTSTRAP = f"one-bootstrap@{_PROJECT}.iam.gserviceaccount.com"
_CALLER = "consent-protocol-runtime@hushh.iam.gserviceaccount.com"


def _cloud(**over) -> UserCloud:
    base = {
        "deployment_target": "user_gcp",
        "model_credential_mode": "user_adc",
        "project": _PROJECT,
        "region": "us-central1",
        "bootstrap_sa": _BOOTSTRAP,
        "authorized": False,
    }
    base.update(over)
    return UserCloud(**base)


@pytest.fixture
def wiring(monkeypatch):
    monkeypatch.setenv("HUSSH_CONSENT_PLANE_SA", _CALLER)

    async def _resolve(_uid, **_kw):
        return _cloud()

    monkeypatch.setattr(runtime_routes, "resolve_user_cloud", _resolve)
    return monkeypatch


async def _instructions():
    return await runtime_routes.byoc_authorization_instructions.__wrapped__(
        request=None, firebase_uid="uid-123"
    )


async def test_the_disclosure_and_the_script_arrive_together(wiring):
    """The rule /byoc/project/plan already follows: the permission is read NEXT TO what
    it buys, never discovered after choosing."""
    out = await _instructions()

    assert out.projectId == _PROJECT
    assert out.hushhCaller == _CALLER
    assert out.script, "the person was told to run a file they do not have"
    assert out.disclosure["grants_to_hushh"], "the disclosure had no caller before this"
    assert out.disclosure["hushh_never_receives"], "the half people most need to read"
    assert out.authorized is False


async def test_the_generated_script_is_valid_bash(wiring):
    """A generated script that does not parse is worse than the dead path it replaces.

    `bash -n` is the smallest authoritative check: it parses the whole file without
    running any of it, so this cannot touch a cloud project.
    """
    out = await _instructions()
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "authorize.sh"
        path.write_text(out.script, encoding="utf-8")
        result = subprocess.run(  # noqa: S603 - fixed argv, no shell, no network
            ["/bin/bash", "-n", str(path)], capture_output=True, text=True, check=False
        )
    assert result.returncode == 0, f"generated script does not parse: {result.stderr}"


async def test_the_script_cannot_name_a_role_the_applier_does_not_bind(wiring):
    """Rendering from BOOTSTRAP_ROLES removes the hand-kept mirror as a category.

    The checked-in file lists these by hand, which is why it needs a parity test. This
    one is the same tuple, so drift is not representable.
    """
    from hushh_mcp.services.user_gcp_bootstrap import BOOTSTRAP_ROLES

    out = await _instructions()
    for role, _why in BOOTSTRAP_ROLES:
        assert role in out.script, f"{role} is bound by the applier and absent from the script"


async def test_the_script_enables_every_service_the_applier_requires(wiring):
    """Seven of ten were off in a real empty project, which was the actual blocker
    people kept mistaking for 'you need to create a project'."""
    from hushh_mcp.services.user_gcp_bootstrap import REQUIRED_SERVICES

    out = await _instructions()
    for service in REQUIRED_SERVICES:
        assert service in out.script, f"{service} would be left disabled"


async def test_the_script_carries_no_key_material(wiring):
    """It is rendered for a person to read, save and paste around.

    The whole BYOC posture is that hushh holds no standing credential, so anything
    key-shaped reaching this surface would contradict the thing being disclosed.
    """
    out = await _instructions()
    lowered = out.script.lower()
    assert "private_key" not in lowered
    assert "begin private key" not in lowered
    assert "ya29." not in lowered, "a live access token reached a downloadable artifact"


async def test_the_revoke_command_undoes_exactly_the_grant_the_script_creates(wiring):
    """Same binding, same account, same member -- or the revoke is decoration."""
    out = await _instructions()

    assert "roles/iam.serviceAccountTokenCreator" in out.revokeCommand
    assert out.bootstrapServiceAccount in out.revokeCommand
    assert _CALLER in out.revokeCommand
    assert "remove-iam-policy-binding" in out.revokeCommand
    # and the script really does create that grant
    assert "roles/iam.serviceAccountTokenCreator" in out.script


async def test_a_person_with_no_named_cloud_gets_a_refusal_not_an_empty_script(monkeypatch):
    """Naming the project comes first. A script rendered against an empty project id
    would be a runnable instruction that authorizes nothing."""
    monkeypatch.setenv("HUSSH_CONSENT_PLANE_SA", _CALLER)

    async def _none(_uid, **_kw):
        return None

    monkeypatch.setattr(runtime_routes, "resolve_user_cloud", _none)

    with pytest.raises(HTTPException) as caught:
        await _instructions()
    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "NO_CLOUD_NAMED"


async def test_an_unset_caller_identity_refuses_rather_than_granting_to_nobody(wiring):
    """The failure mode this closes is a script that RUNS and authorizes nothing.

    With no caller, the grant binds `serviceAccount:` to an empty member. gcloud either
    rejects it or binds something meaningless, the person believes they are done, and
    provisioning refuses them later for a reason this screen never mentioned.
    """
    wiring.delenv("HUSSH_CONSENT_PLANE_SA", raising=False)

    with pytest.raises(HTTPException) as caught:
        await _instructions()
    assert caught.value.status_code == 503
    assert caught.value.detail["code"] == "CALLER_IDENTITY_UNSET"
