"""Deploy contract for same-login start fresh (account generation admission).

Each deploy workflow decides the flag once, before the account-deletion fence installs
(UAT also before runtime secrets sync and for every scope), and turns it on only for a
target whose web app keys data by the validated owner. A refusal after the fence would
pause every account deletion.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import textwrap
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _workflow_steps(workflow: str) -> list[str]:
    return re.findall(r"(?m)^      - name: (.+)$", workflow)


def _step_script(workflow: str, name: str) -> str:
    match = re.search(
        rf"(?ms)^      - name: {re.escape(name)}\n.*?^        run: \|\n(.*?)(?=^      - name: )",
        workflow,
    )
    assert match, name
    return textwrap.dedent(match.group(1))


GENERATION_DECISION = "Decide account generation admission before the deletion fence"
SERVING_REFUSAL = "Refuse the HushhTech client beside a serving revision that admits generations"
OWNER_SPLIT_MARKER = "hushh-webapp/__tests__/lib/auth/application-owner-ratchet.contract.test.ts"


def _run_step(workflow: str, name: str, tmp_path: Path, **env: str) -> tuple[int, dict[str, str]]:
    output = tmp_path / "github-output"
    result = subprocess.run(  # noqa: S603 - Checked-in workflow code and fixed test values.
        ["bash", "-euc", _step_script(workflow, name)],
        cwd=tmp_path,
        env={**os.environ, "GITHUB_OUTPUT": str(output), **env},
        capture_output=True,
        text=True,
        check=False,
    )
    lines = output.read_text(encoding="utf-8").splitlines() if output.exists() else []
    return result.returncode, dict(line.split("=", 1) for line in lines if "=" in line)


def _decide_generation_admission(
    workflow: str, tmp_path: Path, *, owner_split: bool, **env: str
) -> tuple[int, str | None]:
    if owner_split:
        marker = tmp_path / OWNER_SPLIT_MARKER
        marker.parent.mkdir(parents=True)
        marker.write_text("", encoding="utf-8")
    returncode, outputs = _run_step(workflow, GENERATION_DECISION, tmp_path, **env)
    return returncode, outputs.get("enabled")


@pytest.mark.parametrize(
    "admission,hushh_tech_client,owner_split,expected",
    [
        ("true", "false", True, "true"),
        # The workflow comes from main; an older target without the owner split stays off.
        ("true", "false", False, "false"),
        ("false", "true", True, "false"),
        # Refused whatever the target: the serving revision would fail startup.
        ("true", " True ", True, None),
        ("true", "on", False, None),
        # Python's strip() at startup also removes Unicode and separator whitespace.
        ("true", "true ", True, None),
        ("true", "true\x1f", True, None),
        ("yes", "false", True, None),
    ],
)
def test_uat_decides_generation_admission_before_secrets_and_the_deletion_fence(
    tmp_path: Path, admission: str, hushh_tech_client: str, owner_split: bool, expected: str | None
) -> None:
    # A bad value fails Cloud Build and the HushhTech pairing fails startup; both
    # must stop the release before runtime secrets sync or the fence installs.
    workflow = _read(REPO_ROOT / ".github/workflows/deploy-uat.yml")
    steps = _workflow_steps(workflow)
    decision = steps.index(GENERATION_DECISION)
    assert decision < steps.index("Sync canonical hosted runtime secrets")
    assert decision < steps.index("Qualify uninterrupted account deletion")
    step = re.search(
        rf"(?ms)^      - name: {re.escape(GENERATION_DECISION)}\n(.*?)^        run:", workflow
    )
    assert step and "if:" not in step.group(1), "the decision runs for every UAT scope"
    returncode, enabled = _decide_generation_admission(
        workflow,
        tmp_path,
        owner_split=owner_split,
        ACCOUNT_GENERATION_ADMISSION_ENABLED=admission,
        HUSSH_TECH_CLIENT_ENABLED=hushh_tech_client,
    )
    assert (returncode != 0) is (expected is None)
    assert enabled == expected


ADMISSION_ENV = "ACCOUNT_GENERATION_ADMISSION_ENABLED"
SECRET_BINDING = {"secretKeyRef": {"name": "flag", "key": "latest"}}


@pytest.mark.parametrize(
    "serving_env,revision,refused",
    [
        ([{"name": ADMISSION_ENV, "value": "true"}], "consent-protocol-00001-abc", True),
        ([{"name": ADMISSION_ENV, "value": " TRUE "}], "consent-protocol-00001-abc", True),
        ([{"name": ADMISSION_ENV, "value": "false"}], "consent-protocol-00001-abc", False),
        ([], "consent-protocol-00001-abc", False),
        # What this step cannot read fails closed.
        (
            [{"name": ADMISSION_ENV, "valueFrom": SECRET_BINDING}],
            "consent-protocol-00001-abc",
            True,
        ),
        (
            [{"name": ADMISSION_ENV, "value": "false"}, {"name": ADMISSION_ENV, "value": "true"}],
            "consent-protocol-00001-abc",
            True,
        ),
        ([], "", True),
        (None, "consent-protocol-00001-abc", True),
    ],
)
def test_uat_refuses_the_hushhtech_client_while_the_serving_backend_admits_generations(
    tmp_path: Path, serving_env: list[dict] | None, revision: str, refused: bool
) -> None:
    # Turning admission off and the client on in one release would still restart the
    # serving revision's instances into a refused startup after secrets sync.
    workflow = _read(REPO_ROOT / ".github/workflows/deploy-uat.yml")
    steps = _workflow_steps(workflow)
    refusal = steps.index(SERVING_REFUSAL)
    assert steps.index("Capture predeploy Cloud Run state") < refusal
    assert refusal < steps.index("Sync canonical hosted runtime secrets")
    assert refusal < steps.index("Qualify uninterrupted account deletion")
    assert (
        f"      - name: {SERVING_REFUSAL}\n"
        "        if: steps.generation-admission.outputs.client_enabled == 'true'\n"
        "        shell: bash\n"
        "        env:\n"
        "          SERVING_BACKEND_REVISION: ${{ steps.predeploy-state.outputs.backend_revision }}\n"
    ) in workflow
    # The runtime receives the decided value, never a differently spliced raw variable.
    assert (
        '--hushh-tech-client-enabled "${{ steps.generation-admission.outputs.client_enabled }}"'
    ) in workflow
    decision_dir = tmp_path / "decision"
    decision_dir.mkdir()
    _, outputs = _run_step(
        workflow,
        GENERATION_DECISION,
        decision_dir,
        ACCOUNT_GENERATION_ADMISSION_ENABLED="false",
        HUSSH_TECH_CLIENT_ENABLED=" On ",
    )
    assert outputs.get("client_enabled") == "true"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    gcloud = bin_dir / "gcloud"
    payload = json.dumps({"spec": {"containers": [{"env": serving_env}]}})
    # The stub answers only the exact serving-revision describe; anything else fails.
    gcloud.write_text(
        "#!/bin/sh\n"
        f'[ "$1 $2 $3 $4" = "run revisions describe {revision}" ] || exit 3\n'
        'case "$*" in *--format=json*) ;; *) exit 3 ;; esac\n'
        + ("exit 1\n" if serving_env is None else f"echo '{payload}'\n"),
        encoding="utf-8",
    )
    gcloud.chmod(0o755)
    returncode, _ = _run_step(
        workflow,
        SERVING_REFUSAL,
        tmp_path,
        PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        SERVING_BACKEND_REVISION=revision,
        SERVING_PROJECT_ID="project",
        SERVING_REGION="region",
    )
    assert (returncode != 0) is refused


@pytest.mark.parametrize(
    "admission,owner_split,expected",
    [
        ("true", True, "true"),
        ("true", False, "false"),
        ("false", True, "false"),
        ("on", True, None),
    ],
)
def test_generation_admission_runs_on_shared_dev_and_stays_off_in_production(
    tmp_path: Path, admission: str, owner_split: bool, expected: str | None
) -> None:
    dev = _read(REPO_ROOT / ".github/workflows/deploy-dev.yml")
    steps = _workflow_steps(dev)
    assert steps.index(GENERATION_DECISION) < steps.index(
        "Apply dev DB migrations and predeploy schema gate"
    )
    assert (
        'if [[ "${DEV_TARGET:-shared-dev}" != "scope-commerce-sandbox" ]]; then\n'
        '            SUBSTITUTIONS="${SUBSTITUTIONS}##_ACCOUNT_GENERATION_ADMISSION_ENABLED='
        "${{ steps.generation-admission.outputs.enabled || 'false' }}\""
    ) in dev
    returncode, enabled = _decide_generation_admission(
        dev, tmp_path, owner_split=owner_split, ACCOUNT_GENERATION_ADMISSION_ENABLED=admission
    )
    assert (returncode != 0) is (expected is None)
    assert enabled == expected
    # Production phone rollback, cold fallback and restoration gates require it off.
    production = _read(REPO_ROOT / ".github/workflows/deploy-production.yml")
    assert "_ACCOUNT_GENERATION_ADMISSION_ENABLED=true" not in production
    assert "vars.ACCOUNT_GENERATION_ADMISSION" not in production
