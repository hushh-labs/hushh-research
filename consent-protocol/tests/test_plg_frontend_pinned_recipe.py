"""Proposed input derivation proves neither provider state nor deployment."""

import hashlib
import os
import shlex
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "deploy/plg"))
sys.path.insert(0, str(ROOT / "consent-protocol/tests"))
import frontend_pinned_recipe as pinned  # noqa: E402
import test_plg_frontend_secret_pins as fixtures  # noqa: E402


def inputs():
    recipe = (ROOT / "deploy/frontend-image.cloudbuild.yaml").read_bytes().replace(b"\r\n", b"\n")
    overlays = {
        name: (ROOT / name).read_bytes().replace(b"\r\n", b"\n") for name in pinned.release.OVERLAYS
    }
    hashes = {
        name: hashlib.sha256(value).hexdigest()
        for name, value in {"deploy/frontend-image.cloudbuild.yaml": recipe, **overlays}.items()
    }
    return recipe, overlays, hashes


@pytest.mark.parametrize("environment", ["dev", "uat"])
def test_every_declared_and_dynamic_secret_access_is_pinned(environment):
    recipe, overlays, hashes = inputs()
    proposed, helpers, manifest = pinned.derive(
        environment, recipe, overlays, fixtures.inventory(environment), hashes
    )
    config = yaml.safe_load(proposed)
    for binding in config["availableSecrets"]["secretManager"]:
        assert binding["versionName"].endswith("/versions/3")
        assert "/versions/latest" not in binding["versionName"]
    assert b"gcloud secrets versions access latest" not in proposed
    assert all(b"gcloud secrets versions access latest" not in value for value in helpers.values())
    assert config["steps"][0]["args"][1].count("plg_pinned_secret_access") == 5
    assert manifest["providerVerified"] is manifest["consumptionVerified"] is False
    assert manifest["environmentAccepted"] is manifest["productionTrafficAuthorized"] is False
    assert hashlib.sha256(proposed).hexdigest() == manifest["recipeSha256"]


def test_changed_reviewed_input_and_unrecognized_binding_fail_closed():
    recipe, overlays, hashes = inputs()
    with pytest.raises(pinned.release.Refused, match="inputs changed"):
        pinned.derive("uat", recipe + b"\n", overlays, fixtures.inventory("uat"), hashes)
    config = yaml.safe_load(recipe)
    config["availableSecrets"]["secretManager"][0]["versionName"] += "-changed"
    changed = yaml.safe_dump(config, sort_keys=False).encode()
    hashes["deploy/frontend-image.cloudbuild.yaml"] = hashlib.sha256(changed).hexdigest()
    with pytest.raises(pinned.release.Refused, match="binding changed"):
        pinned.derive("uat", changed, overlays, fixtures.inventory("uat"), hashes)


def test_wrapper_forwards_only_fixed_project_and_numeric_pin(tmp_path):
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("bash unavailable")
    snapshot = pinned.pins.validate_inventory("dev", fixtures.inventory("dev"))
    shell = pinned._wrapper("dev", snapshot["versions"])
    script = (
        shell
        + """
gcloud() { printf '%s\\n' "$*"; }
plg_pinned_secret_access --secret=BACKEND_URL --project=hushh-pda-dev
if plg_pinned_secret_access --secret=BACKEND_URL --project=hushh-pda-uat; then exit 3; fi
if plg_pinned_secret_access --secret=UNREVIEWED --project=hushh-pda-dev; then exit 4; fi
if plg_pinned_secret_access --secret=NEXT_PUBLIC_GOOGLE_SIGN_IN_CLIENT_ID --project=hushh-pda-dev; then exit 5; fi
"""
    )
    result = subprocess.run(  # noqa: S603 -- fixed local synthetic shell test.
        [bash, "-c", script],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
        env=os.environ.copy(),
    )  # noqa: S603
    assert result.returncode == 0, result.stderr
    assert (
        result.stdout.strip()
        == "secrets versions access 3 --secret=BACKEND_URL --project=hushh-pda-dev"
    )
    assert "NOT_FOUND" in result.stderr


def test_wrapper_survives_cloud_build_dollar_unescaping_and_child_bash():
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("bash unavailable")
    recipe, overlays, hashes = inputs()
    proposed, _helpers, _manifest = pinned.derive(
        "dev", recipe, overlays, fixtures.inventory("dev"), hashes
    )
    script = yaml.safe_load(proposed)["steps"][0]["args"][1]
    wrapper = (
        script.split("set -euo pipefail\n", 1)[1].split("export -f plg_pinned_secret_access\n", 1)[
            0
        ]
        + "export -f plg_pinned_secret_access\n"
    )
    wrapper = wrapper.replace("$$", "$")
    wrapper += """
gcloud() { printf '%s\\n' "$*"; }
export -f gcloud
bash -c 'plg_pinned_secret_access --secret=BACKEND_URL --project=hushh-pda-dev'
"""
    result = subprocess.run(  # noqa: S603 -- fixed local synthetic shell test.
        [bash, "-c", wrapper],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
        env=os.environ.copy(),
    )
    assert result.returncode == 0, result.stderr
    assert (
        result.stdout.strip()
        == "secrets versions access 3 --secret=BACKEND_URL --project=hushh-pda-dev"
    )


def test_local_preparation_archives_derived_helpers(tmp_path, monkeypatch):
    recipe, overlays, hashes = inputs()
    attempt = pinned.release.Attempt("uat", "a" * 40, "123", "2")
    authority = {**hashes, "other-reviewed-file": "b" * 64}
    monkeypatch.setattr(pinned.release, "reviewed_inputs", lambda _attempt: authority)
    monkeypatch.setattr(pinned.release.frontend_validation, "verify", lambda *_args: {"runId": 42})
    original_git = pinned.release.source.backend._git

    def git(*args):
        if args[0] == "show" and args[1].startswith(attempt.workflow_sha + ":"):
            name = args[1].split(":", 1)[1]
            return recipe if name == "deploy/frontend-image.cloudbuild.yaml" else overlays[name]
        return original_git(*args)

    monkeypatch.setattr(pinned.release.source.backend, "_git", git)
    path = tmp_path / "source.tar.gz"
    derived, result = pinned.prepare_local(attempt, 42, fixtures.inventory("uat"), path)
    assert result["archive"]["archiveSha256"] == hashlib.sha256(path.read_bytes()).hexdigest()
    assert result["pins"]["recipeSha256"] == hashlib.sha256(derived).hexdigest()
    assert result["substitutions"] == attempt.substitutions()
    assert not result["providerVerified"] and not result["environmentAccepted"]
    with tarfile.open(path, "r:gz") as archive:
        for name, digest in result["pins"]["overlaysSha256"].items():
            contents = archive.extractfile(name).read()
            assert hashlib.sha256(contents).hexdigest() == digest
            assert b"gcloud secrets versions access latest" not in contents


def test_failed_recheck_returns_no_receipt_and_leaves_untrusted_archive(tmp_path, monkeypatch):
    recipe, overlays, hashes = inputs()
    attempt = pinned.release.Attempt("uat", "a" * 40, "123", "2")
    monkeypatch.setattr(pinned.release, "reviewed_inputs", lambda _attempt: hashes)
    calls = iter([{"runId": 42}, {"runId": 43}])
    monkeypatch.setattr(pinned.release.frontend_validation, "verify", lambda *_args: next(calls))
    monkeypatch.setattr(
        pinned.release.source.backend,
        "_git",
        lambda _command, ref: (
            recipe
            if ref.endswith("deploy/frontend-image.cloudbuild.yaml")
            else overlays[ref.split(":", 1)[1]]
        ),
    )

    def archive(path, derived):
        path.write_bytes(b"untrusted partial output")
        return {
            "sourceSha": pinned.release.SOURCE,
            "sourceTree": pinned.release.SOURCE_TREE,
            "overlays": {
                name: hashlib.sha256(value).hexdigest() for name, value in derived.items()
            },
            "environmentAccepted": False,
            "productionTrafficAuthorized": False,
        }

    monkeypatch.setattr(pinned.release, "archive_source", archive)
    path = tmp_path / "source.tar.gz"
    with pytest.raises(pinned.release.Refused, match="authority changed"):
        pinned.prepare_local(attempt, 42, fixtures.inventory("uat"), path)
    assert path.read_bytes() == b"untrusted partial output"


@pytest.mark.parametrize("mode", ["present", "absent", "denied"])
def test_real_derived_sign_in_helper_in_child_bash(tmp_path, mode):
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("bash unavailable")
    recipe, overlays, hashes = inputs()
    inventory = fixtures.inventory("dev")
    name = "NEXT_PUBLIC_GOOGLE_SIGN_IN_CLIENT_ID"
    if mode != "absent":
        inventory[name] = {
            "name": f"projects/hushh-pda-dev/secrets/{name}/versions/7",
            "state": "ENABLED",
        }
    proposed, helpers, _manifest = pinned.derive("dev", recipe, overlays, inventory, hashes)
    helper = tmp_path / "sign-in.sh"
    helper.write_bytes(helpers["scripts/deploy/resolve-google-sign-in-client.sh"])
    artifact = tmp_path / "client.txt"
    resolver = yaml.safe_load(proposed)["steps"][0]["args"][1]
    wrapper = (
        resolver.split("set -euo pipefail\n", 1)[1].split(
            "export -f plg_pinned_secret_access\n", 1
        )[0]
        + "export -f plg_pinned_secret_access\n"
    )
    wrapper = wrapper.replace("$$", "$")
    body = (
        "echo PERMISSION_DENIED >&2; return 1"
        if mode == "denied"
        else 'printf "%s\\n" "123-abc.apps.googleusercontent.com"'
    )
    script = (
        wrapper
        + f"\ngcloud() {{ {body}; }}\nexport -f gcloud\nbash {shlex.quote(helper.as_posix())} hushh-pda-dev {shlex.quote(artifact.as_posix())} ''\n"
    )
    result = subprocess.run(  # noqa: S603 -- fixed local synthetic shell test.
        [bash, "-c", script],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
        env=os.environ.copy(),
    )
    if mode == "denied":
        assert result.returncode != 0
    else:
        assert result.returncode == 0, result.stderr
        assert artifact.read_text() == (
            "123-abc.apps.googleusercontent.com" if mode == "present" else ""
        )
