"""Deploy-config contract for the Apple Wallet pass signing material.

Three separate files have to agree on three secret names or the pass never
signs, and the failure is invisible until someone taps *Add to Apple Wallet* in
production:

- ``scripts/ci/provision_wallet_pass_certificate.py`` **writes** the PEMs into
  Secret Manager under fixed names;
- ``hushh_mcp/runtime_settings.py`` **reads** them out of the process
  environment under those same names;
- the backend deploy config is the only thing that connects the two, and it had
  no idea they existed. Cloud Run would have started with all three unset, the
  signing service would have answered a permanent 503, and provisioning the
  certificate — an irreversible act that consumes a finite Apple slot — would
  have changed nothing.

That deploy config is now two files: ``deploy/backend.cloudbuild.yaml`` owns the
``substitutions:`` defaults and the ``env:`` list, while the behaviour — the
``append_optional_secret`` calls included — moved to
``scripts/deploy/backend-deploy.sh`` to get under Cloud Build's 10,000-character
per-arg cap. Assertions about *wiring* therefore read the combined surface; the
assertion about *defaults* still reads the YAML, which is where they live.

The wiring is deliberately *optional* (``add_secret`` probes with
``gcloud secrets describe`` and skips what is absent), so this contract can land
and deploy safely long before the certificate exists. These tests exist so the
name agreement cannot silently drift afterwards.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
from contextlib import contextmanager, nullcontext
from pathlib import Path

import pytest

from tests._deploy_contract import backend_deploy_surface

REPO_ROOT = Path(__file__).resolve().parents[2]

CLOUDBUILD = REPO_ROOT / "deploy" / "backend.cloudbuild.yaml"
PROVISION_SCRIPT = REPO_ROOT / "scripts" / "ci" / "provision_wallet_pass_certificate.py"
RUNTIME_SETTINGS = REPO_ROOT / "consent-protocol" / "hushh_mcp" / "runtime_settings.py"

PEM_ENV_NAMES = ("WALLET_PASS_CERT_PEM", "WALLET_PASS_KEY_PEM", "WALLET_PASS_WWDR_PEM")


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_the_deploy_passes_every_pem_through_to_cloud_run() -> None:
    surface = backend_deploy_surface()

    for env_name in PEM_ENV_NAMES:
        expected = f'append_optional_secret "${{_{env_name}_SECRET}}" "{env_name}"'
        assert expected in surface, f"{env_name} is never wired into the deploy"


def test_every_pem_substitution_reaches_the_deploy_script() -> None:
    """The YAML's `env:` list is the only way a substitution reaches the script.

    Splitting the step body out introduced a failure mode that did not exist while
    it was inline: the `append_optional_secret` call can be present in the script
    and the value still arrive empty, because nothing passed `${_FOO}` over. That
    would silently un-wire the pass signing material with every other assertion
    here still green.
    """
    cloudbuild = _read(CLOUDBUILD)

    for env_name in PEM_ENV_NAMES:
        key = f"_{env_name}_SECRET"
        assert f'- "{key}=${{{key}}}"' in cloudbuild, (
            f"{key} is never handed to scripts/deploy/backend-deploy.sh via the "
            f"deploy-backend step's env: list, so it arrives unset at deploy time"
        )


def test_each_pem_substitution_defaults_to_its_canonical_secret_name() -> None:
    """Defaulted rather than empty, so the first deploy after the certificate is
    minted picks the material up with no further change to the deploy config."""
    cloudbuild = _read(CLOUDBUILD)

    for env_name in PEM_ENV_NAMES:
        match = re.search(rf"^  _{env_name}_SECRET:\s*(\S+)\s*$", cloudbuild, flags=re.MULTILINE)
        assert match, f"_{env_name}_SECRET has no substitution default"
        assert match.group(1) == env_name


def test_the_deploy_names_match_the_names_provisioning_writes() -> None:
    """The provisioning script is the only writer of these secrets; a rename on
    either side would leave Cloud Run pointed at a secret that never exists."""
    provisioning = _read(PROVISION_SCRIPT)

    for env_name in PEM_ENV_NAMES:
        assert f'"{env_name}"' in provisioning, f"provisioning does not write {env_name}"


def test_the_deploy_names_match_the_names_the_runtime_reads() -> None:
    runtime = _read(RUNTIME_SETTINGS)

    for env_name in PEM_ENV_NAMES:
        assert f'{env_name}_ENV = "{env_name}"' in runtime


def test_the_pems_stay_optional_so_the_deploy_survives_their_absence() -> None:
    """``add_secret`` is what keeps an un-provisioned environment
    deployable. Promoting these to the mandatory ``secrets=`` string would break
    every deploy in every project until the certificate is minted."""
    cloudbuild = _read(CLOUDBUILD)

    for env_name in PEM_ENV_NAMES:
        assert f"{env_name}=${{_{env_name}_SECRET}}:latest" not in cloudbuild


def test_temporary_card_sharing_flag_reaches_runtime_and_defaults_off() -> None:
    cloudbuild = _read(CLOUDBUILD)
    assert (
        'append_optional_env "WALLET_CARD_ACCESS_ENABLED" "${_WALLET_CARD_ACCESS_ENABLED}"'
        in backend_deploy_surface()
    )
    assert "card_access=${_WALLET_CARD_ACCESS_ENABLED}" in cloudbuild
    assert '  _WALLET_CARD_ACCESS_ENABLED: "false"' in cloudbuild


def test_uat_enables_temporary_card_sharing_with_its_encryption_key() -> None:
    workflow = _read(REPO_ROOT / ".github/workflows/deploy-uat.yml")
    assert (
        "##_WALLET_CARD_ACCESS_ENABLED=${{ vars.WALLET_CARD_ACCESS_UAT_ENABLED || 'true' }}"
        in workflow
    )
    assert "##_DIRECT_MESSAGE_ENCRYPTION_KEY_V1_SECRET=DIRECT_MESSAGE_ENCRYPTION_KEY_V1" in workflow
    manifest = _read(REPO_ROOT / "consent-protocol/db/release_migration_manifest.json")
    assert '"302_wallet_temporary_card_access.sql"' in manifest
    production = _read(REPO_ROOT / ".github/workflows/deploy-production.yml")
    assert "_WALLET_CARD_ACCESS_ENABLED=true" not in production


@pytest.mark.parametrize("supports_flag", [False, True])
@pytest.mark.parametrize("flag_value", ["true", "false"])
def test_uat_card_sharing_substitution_preserves_historical_deploys(
    tmp_path: Path, supports_flag: bool, flag_value: str
) -> None:
    workflow = _read(REPO_ROOT / ".github/workflows/deploy-uat.yml")
    guard = re.search(
        r"(?m)^          if grep -q [^\n]*_WALLET_CARD_ACCESS_ENABLED[^\n]*\n"
        r"(?:^          .*\n)*?^          fi$",
        workflow,
    )
    assert guard, "UAT must guard new substitutions against the selected build config"
    deploy = tmp_path / "deploy"
    deploy.mkdir()
    (deploy / "backend.cloudbuild.yaml").write_text(
        'substitutions:\n  _WALLET_CARD_ACCESS_ENABLED: "false"\n'
        if supports_flag
        else 'substitutions:\n  _BACKEND_SERVICE: "consent-protocol"\n',
        encoding="utf-8",
    )
    script = guard.group().replace(
        "${{ vars.WALLET_CARD_ACCESS_UAT_ENABLED || 'true' }}", flag_value
    )
    result = subprocess.run(  # noqa: S603 - Checked-in workflow code and fixed test values.
        [
            "bash",
            "-euc",
            'SUBSTITUTIONS="_BACKEND_SERVICE=consent-protocol"\n'
            + script
            + '\nprintf "%s" "$SUBSTITUTIONS"',
        ],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=True,
    )
    expected = "_BACKEND_SERVICE=consent-protocol"
    if supports_flag:
        expected += f"##_WALLET_CARD_ACCESS_ENABLED={flag_value}"
    assert result.stdout == expected


@pytest.mark.parametrize(
    "packed,expected",
    [
        ("review=,wallet=true,card_access=false,phone_recovery=false", "|true|false|false"),
        ("review=false,wallet=,card_access=true,phone_recovery=true", "false||true|true"),
        ("review=true,wallet=false,card_access=,phone_recovery=false", "true|false||false"),
        ("review=,wallet=true,card_access=false,phone_recovery=", None),
        ("review=,wallet=true,card_access=false,phone_recovery=invalid", None),
        ("review=,wallet=true,card_access=invalid", None),
        ("review=,wallet=true,wallet=false", None),
        ("review=,wallet=true,unknown=false", None),
        ("review=,wallet=true,card_access=false,generation_admission=false", None),
        (
            "review=,wallet=true,card_access=false,phone_recovery=false,generation_admission=false",
            "|true|false|false",
        ),
        ("review=,wallet=true", None),
    ],
)
def test_application_flags_preserve_values_and_refuse_malformed_packing(packed, expected):
    parser = _read(REPO_ROOT / "scripts/deploy/backend-phone-rollback.sh") + "\n"
    parser += _read(REPO_ROOT / "scripts/deploy/backend-app-surface-settings.sh")
    result = subprocess.run(  # noqa: S603 - Repository parser, no cloud operations.
        [
            "bash",
            "-euc",
            parser
            + '\nprintf "%s|%s|%s|%s" "${_APP_REVIEW_MODE}" "${_ONE_WALLET_CARD_ENABLED}" "${_WALLET_CARD_ACCESS_ENABLED}" "${_AUTH_PHONE_RECOVERY_ENABLED}"',
        ],
        env={"_APP_SURFACE_SETTINGS": packed},
        capture_output=True,
        text=True,
        check=False,
    )
    if expected is None:
        assert result.returncode != 0
        assert result.stdout == ""
    else:
        assert result.returncode == 0, result.stderr
        assert result.stdout == expected


@pytest.fixture
def phone_image_qualifier():
    spec = importlib.util.spec_from_file_location(
        "phone_image_qualifier", REPO_ROOT / "deploy/phone/qualify_image.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.feature_auth_reliability
def test_phone_image_run_preserves_bounded_binary_input(phone_image_qualifier):
    payload = b"synthetic-image-evidence\x00\xff"
    assert (
        phone_image_qualifier.run(
            [sys.executable, "-c", "import sys; sys.stdout.buffer.write(sys.stdin.buffer.read())"],
            data=payload,
            timeout=5,
        )
        == payload
    )


@pytest.mark.feature_auth_reliability
@pytest.mark.parametrize("mode", ["overflow", "timeout"])
def test_phone_image_run_bounds_output_and_releases_owned_processes(
    phone_image_qualifier, monkeypatch, tmp_path, mode
):
    canonical_group = phone_image_qualifier.run_path(
        str(REPO_ROOT / "scripts/ci/process_group.py")
    )["command_group"]
    owned = []

    @contextmanager
    def track_group(command, **kwargs):
        with canonical_group(command, **kwargs) as pair:
            owned.append(pair)
            yield pair

    monkeypatch.setattr(
        phone_image_qualifier, "run_path", lambda _path: {"command_group": track_group}
    )
    child_pid = tmp_path / "child.pid"
    program = """
import pathlib, signal, subprocess, sys, time
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
def stop(_signum, _frame):
    child.terminate()
    child.wait(timeout=2)
    raise SystemExit(0)
signal.signal(signal.SIGTERM, stop)
pathlib.Path(sys.argv[1]).write_text(str(child.pid))
if sys.argv[2] == 'overflow':
    sys.stdout.buffer.write(b'x' * (1024 * 1024 + 1))
    sys.stdout.buffer.flush()
time.sleep(30)
"""
    failure = ValueError if mode == "overflow" else subprocess.TimeoutExpired
    try:
        with pytest.raises(failure) as error:
            phone_image_qualifier.run(
                [sys.executable, "-c", program, str(child_pid), mode], timeout=1
            )
        if mode == "overflow":
            assert str(error.value) == "phone_image_evidence_exceeds_bound"
        assert len(owned) == 1
        process, _stop = owned[0]
        assert process.poll() is not None
        assert process.stdout.closed
        with pytest.raises(ProcessLookupError):
            os.kill(int(child_pid.read_text()), 0)
    finally:
        for process, stop in owned:
            stop(force=True)
            process.wait(timeout=5)
            process.stdout.close()


@pytest.mark.feature_auth_reliability
@pytest.mark.parametrize(
    "cleanup,error_type",
    [
        ("already_absent", None),
        ("removed", None),
        ("inventory_unavailable", subprocess.CalledProcessError),
        ("remove_refused", subprocess.CalledProcessError),
        ("survives", ValueError),
    ],
)
def test_phone_image_probe_requires_proven_container_absence(
    phone_image_qualifier, monkeypatch, cleanup, error_type
):
    commands = []
    present = cleanup != "already_absent"
    container_name = None
    verdict = {
        "schema_version": 1,
        "phone_reader": phone_image_qualifier.EXPECTED,
        "probe_generation_admission": False,
    }

    def container_port(command, *, data=None, timeout=120):
        nonlocal present, container_name
        commands.append(command)
        if command[:2] == ["docker", "run"]:
            container_name = command[command.index("--name") + 1]
            assert not any("ACCOUNT_GENERATION_ADMISSION_ENABLED" in value for value in command)
            assert data == (REPO_ROOT / "deploy/phone/reader_probe.py").read_bytes()
            return json.dumps(verdict).encode()
        if command[:3] == ["docker", "container", "ls"]:
            assert f"name=^/{container_name}$" in command
            if cleanup == "inventory_unavailable":
                raise subprocess.CalledProcessError(1, command)
            return b"synthetic-container\n" if present else b""
        assert command == ["docker", "rm", "--force", container_name]
        if cleanup == "remove_refused":
            raise subprocess.CalledProcessError(1, command)
        present = cleanup == "survives"
        return b""

    monkeypatch.setattr(phone_image_qualifier, "run", container_port)
    with pytest.raises(error_type) if error_type is not None else nullcontext():
        assert phone_image_qualifier.probe("synthetic-image") == verdict
    if cleanup in {"removed", "remove_refused", "survives"}:
        assert [command[1] for command in commands] == ["run", "container", "rm"] + (
            [] if cleanup == "remove_refused" else ["container"]
        )
    if cleanup == "survives":
        assert present is True


@pytest.mark.feature_auth_reliability
def test_phone_image_probe_timeout_still_proves_cleanup(phone_image_qualifier, monkeypatch):
    commands = []
    present = True
    original = None

    def container_port(command, *, data=None, timeout=120):
        nonlocal present, original
        commands.append(command)
        if command[:2] == ["docker", "run"]:
            original = subprocess.TimeoutExpired(command, timeout)
            raise original
        if command[:3] == ["docker", "container", "ls"]:
            return b"synthetic-container\n" if present else b""
        assert command[:3] == ["docker", "rm", "--force"]
        present = False
        return b""

    monkeypatch.setattr(phone_image_qualifier, "run", container_port)
    with pytest.raises(subprocess.TimeoutExpired) as error:
        phone_image_qualifier.probe("synthetic-image")
    assert error.value is original
    assert present is False
    assert [command[1] for command in commands] == ["run", "container", "rm", "container"]
