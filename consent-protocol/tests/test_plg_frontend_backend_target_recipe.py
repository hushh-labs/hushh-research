"""The proposed isolated target check does not authenticate a provider pair."""

import copy
import gzip
import io
import json
import os
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
import frontend_backend_target_recipe as target  # noqa: E402
import frontend_fixture_runtime as runtime  # noqa: E402
import frontend_pinned_recipe as pinned  # noqa: E402
import test_plg_frontend_pinned_recipe as inputs  # noqa: E402
import test_plg_frontend_secret_pins as fixtures  # noqa: E402


def fixture():
    recipe, overlays, hashes = inputs.inputs()
    inventory = fixtures.inventory("uat", fixture_backend=True)
    derived, _helpers, _manifest = pinned.derive(
        "uat", recipe, overlays, inventory, hashes, fixture_backend=True
    )
    pair = {
        "kind": "proposed-private-plg-backend-pair-v1",
        "environment": "uat",
        "project": "hushh-pda-uat",
        "candidateUrl": "https://tag---s.example.run.app",
        "providerVerified": False,
        "durableFenceVerified": False,
        "frontendPairAccepted": False,
        "productionTrafficAuthorized": False,
    }
    return (
        derived,
        pair,
        {
            "inventory": inventory,
            "original_recipe": recipe,
            "original_overlays": overlays,
            "expected_hashes": hashes,
        },
    )


@pytest.mark.parametrize("matches", [True, False])
def test_backend_url_is_checked_without_printing_secret(matches):
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("bash unavailable")
    recipe, pair, context = fixture()
    bound, proof = target.bind(recipe, pair, "uat", **context)
    step = yaml.safe_load(bound)["steps"][0]
    binding = next(
        item
        for item in yaml.safe_load(bound)["availableSecrets"]["secretManager"]
        if item["env"] == "BACKEND_URL_VAL"
    )
    assert (
        binding["versionName"]
        == "projects/hushh-pda-uat/secrets/PLG_QUALIFICATION_FRONTEND_BACKEND_URL/versions/3"
    )
    check = step["args"][1].split("set -euo pipefail\n", 1)[1].splitlines()[0].replace("$$", "$")
    value = pair["candidateUrl"] if matches else "https://unexpected.example.run.app"
    env = os.environ.copy()
    env["BACKEND_URL_VAL"] = value
    result = subprocess.run(  # noqa: S603 -- synthetic fixed shell test.
        [bash, "-c", "set -euo pipefail\n" + check],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
        env=env,
    )  # noqa: S603
    assert (result.returncode == 0) is matches
    assert value not in result.stdout and value not in result.stderr
    assert (
        not proof["backendIdentityVerified"]
        and not proof["secretPayloadVerified"]
        and not proof["maySubmit"]
    )


@pytest.mark.parametrize(
    "case",
    [
        "wrong_project",
        "unsafe_origin",
        "production",
        "claim_authority",
        "latest_secret",
        "other_step",
        "wrong_version",
    ],
)
def test_unverified_or_unpinned_binding_is_refused(case):
    recipe, pair, context = fixture()
    pair = copy.deepcopy(pair)
    if case == "wrong_project":
        pair["project"] = "hushh-pda-dev"
    elif case == "unsafe_origin":
        pair["candidateUrl"] = "https://attacker.invalid/$(echo-bad)"
    elif case == "production":
        pair["environment"] = "production"
    elif case == "claim_authority":
        pair["providerVerified"] = True
    elif case == "other_step":
        config = yaml.safe_load(recipe)
        config["steps"][1]["name"] = "attacker/image"
        recipe = yaml.safe_dump(config).encode()
    elif case == "wrong_version":
        context["inventory"][target.secret_pins.FIXTURE_BACKEND]["name"] = (
            "projects/hushh-pda-uat/secrets/PLG_QUALIFICATION_FRONTEND_BACKEND_URL/versions/4"
        )
    else:
        config = yaml.safe_load(recipe)
        next(
            item
            for item in config["availableSecrets"]["secretManager"]
            if item["env"] == "BACKEND_URL_VAL"
        )["versionName"] = "projects/hushh-pda-uat/secrets/BACKEND_URL/versions/latest"
        recipe = yaml.safe_dump(config).encode()
    with pytest.raises(target.release.Refused):
        target.bind(recipe, pair, "uat", **context)


def test_fixture_installer_binds_immutable_config_and_runtime_numeric_secret(tmp_path):
    recipe, pair, context = fixture()
    recipe, _binding = target.bind(recipe, pair, "uat", **context)
    attempt = target.release.Attempt("uat", "a" * 40, "123", "2")
    pair.update(
        {
            "serviceUid": "service-uid",
            "revisionUid": "revision-uid",
            "revision": "consent-protocol-plg-qual-q0123456789ab",
            "serviceUrl": "https://service.example.run.app",
        }
    )
    scripts = {name: (ROOT / name).read_bytes() for name in runtime.SCRIPTS}
    authority = {name: runtime.digest(raw) for name, raw in scripts.items()}
    dockerfile = b'FROM node:24-alpine\nCMD ["node", "server.js"]\n'
    derived, proof = runtime.bundle(attempt, pair, recipe, scripts, authority, dockerfile)
    installer = yaml.safe_load(derived)["steps"][1]
    app = tmp_path / "hushh-webapp"
    (app / "scripts").mkdir(parents=True)
    (app / "Dockerfile").write_bytes(dockerfile)
    (app / "server.js").write_bytes(b"original-application")
    result = subprocess.run(  # noqa: S603 -- bounded synthetic installer, no cloud.
        [sys.executable, *installer["args"]],
        cwd=tmp_path,
        capture_output=True,
        timeout=10,
        check=False,
    )
    assert result.returncode == 0
    assert (app / "server.js").read_bytes() == b"original-application"
    assert (app / "Dockerfile").read_bytes().startswith(dockerfile)
    for name, expected in proof["filesSha256"].items():
        assert runtime.digest((app / "scripts/plg-fixture" / name).read_bytes()) == expected
    document = runtime.service_document(
        attempt,
        "gcr.io/hushh-pda-uat/hushh-webapp@sha256:" + "b" * 64,
        context["inventory"],
        proof,
    )
    container = document["spec"]["template"]["spec"]["containers"][0]
    backend = next(row for row in container["env"] if row["name"] == "BACKEND_URL")
    assert backend["valueFrom"]["secretKeyRef"] == {
        "name": "PLG_QUALIFICATION_FRONTEND_BACKEND_URL",
        "key": "3",
    }
    assert document["metadata"]["name"] == "hushh-webapp-plg-qual"
    assert runtime.iam_plan(attempt)["projectRoles"] == []
    tar = io.BytesIO()
    with tarfile.open(fileobj=tar, mode="w") as archive:
        for name in proof["filesSha256"]:
            raw = (app / "scripts/plg-fixture" / name).read_bytes()
            entry = tarfile.TarInfo("opt/plg-fixture/" + name)
            entry.size, entry.mode = len(raw), 0o444
            archive.addfile(entry, io.BytesIO(raw))
    layer = gzip.compress(tar.getvalue())
    child = json.dumps(
        {
            "layers": [
                {
                    "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
                    "digest": "sha256:" + runtime.digest(layer),
                    "size": len(layer),
                }
            ]
        }
    ).encode()
    assert runtime.verify_runtime_layer(child, layer, proof)["bundledFilesVerified"]
    changed_proof = copy.deepcopy(proof)
    changed_proof["filesSha256"]["transport.json"] = "a" * 64
    with pytest.raises(target.release.Refused, match="image bytes changed"):
        runtime.verify_runtime_layer(child, layer, changed_proof)
    changed = dict(scripts)
    changed[runtime.SCRIPTS[0]] = b"changed"
    with pytest.raises(target.release.Refused):
        runtime.bundle(attempt, pair, recipe, changed, authority, dockerfile)
