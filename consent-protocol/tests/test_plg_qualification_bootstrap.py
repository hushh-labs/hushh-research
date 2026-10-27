"""Qualification resources never acquire shared targets, mail authority or keys."""

import copy
import importlib
import io
import json
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError

import pytest

from tests.helpers.plg_qualification import ExistingSecret, SyntheticBaseline

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def modules(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "deploy/plg"))
    return tuple(
        importlib.import_module("qualification_" + name)
        for name in ("target", "resources", "database", "bootstrap")
    )


@pytest.mark.parametrize("environment", ["production", "hushh-pda", "../uat", "UAT", ""])
def test_target_refuses_production_or_arbitrary_environment(modules, environment):
    target, *_ = modules
    with pytest.raises(target.QualificationError, match="qualification_environment_invalid"):
        target.Target(environment)


@pytest.mark.parametrize("environment", ["dev", "uat"])
def test_private_candidate_cannot_mount_migrator_or_external_delivery_secrets(modules, environment):
    target, *_ = modules
    selection = target.Target(environment)
    versions = dict.fromkeys(target.RUNTIME_SECRETS, "7")
    image = f"gcr.io/{selection.project}/consent-protocol@sha256:" + "a" * 64
    service = selection.service_document(image, versions, "19")
    spec = service["spec"]["template"]["spec"]
    mounts = [
        row["valueFrom"]["secretKeyRef"]
        for row in spec["containers"][0]["env"]
        if "valueFrom" in row
    ]
    assert all(row["name"].startswith(target.PREFIX) and row["key"] == "7" for row in mounts)
    assert {row["name"] for row in mounts} == {
        target.PREFIX + name for name in target.RUNTIME_SECRETS
    }
    assert not (
        {target.PREFIX + name for name in target.MIGRATOR_SECRETS} & {row["name"] for row in mounts}
    )
    assert service["metadata"]["annotations"]["run.googleapis.com/invoker-iam-disabled"] == "false"
    config = selection.runtime_config()
    assert all(config[key] is False for key in config if key.endswith("enabled"))
    assert selection.project != "hushh-pda" and selection.instance.startswith(
        selection.project + ":"
    )
    assert selection.plan()["environmentAccepted"] is False


@pytest.mark.parametrize(
    "mutation", ["prod-image", "mutable-image", "latest-secret", "extra-secret"]
)
def test_service_manifest_refuses_cross_environment_or_mutable_authority(modules, mutation):
    target, *_ = modules
    selection = target.Target("uat")
    image = "gcr.io/hushh-pda-uat/consent-protocol@sha256:" + "a" * 64
    versions = dict.fromkeys(target.RUNTIME_SECRETS, "7")
    if mutation == "prod-image":
        image = image.replace("hushh-pda-uat", "hushh-pda")
    elif mutation == "mutable-image":
        image = "gcr.io/hushh-pda-uat/consent-protocol:latest"
    elif mutation == "latest-secret":
        versions["DB_PASSWORD"] = "latest"
    else:
        versions["MIGRATOR_DB_PASSWORD"] = "7"
    with pytest.raises(target.QualificationError):
        selection.service_document(image, versions, "19")


@pytest.mark.parametrize("status", [403, 404, 409, 429, 500])
def test_only_formal_404_admits_missing_resource(modules, monkeypatch, status):
    target, resources, *_ = modules
    cloud = object.__new__(resources.Cloud)
    cloud.target, cloud.project_number, cloud._token = target.Target("uat"), "1234", "synthetic"

    def unavailable(request, **_kwargs):
        raise HTTPError(request.full_url, status, "synthetic", {}, None)

    monkeypatch.setattr(resources, "urlopen", unavailable)
    path = "projects/hushh-pda-uat/secrets/PLG_QUALIFICATION_DB_PASSWORD"
    if status == 404:
        assert cloud.request("secretmanager", path, missing=True) is None
    else:
        with pytest.raises(RuntimeError, match="qualification_cloud_request_refused"):
            cloud.request("secretmanager", path, missing=True)


def test_cloud_error_keeps_only_status_reason_and_field_names(modules, monkeypatch):
    target, resources, *_ = modules
    cloud = object.__new__(resources.Cloud)
    cloud.target, cloud.project_number, cloud._token = target.Target("dev"), "1234", "synthetic"
    private = "sensitive_material_must_not_escape"

    def refused(request, **_kwargs):
        body = {
            "error": {
                "status": "INVALID_ARGUMENT",
                "message": private,
                "details": [
                    {
                        "reason": "ORG_POLICY_VIOLATION",
                        "fieldViolations": [
                            {"field": "replication.automatic", "description": private}
                        ],
                    }
                ],
            }
        }
        raise HTTPError(
            request.full_url, 400, "synthetic", {}, io.BytesIO(json.dumps(body).encode())
        )

    monkeypatch.setattr(resources, "urlopen", refused)
    with pytest.raises(resources.CloudRequestError) as caught:
        cloud.request(
            "secretmanager",
            "projects/hushh-pda-dev/secrets",
            method="POST",
            secret_id=target.PREFIX + "APP_SIGNING_KEY",
            body={},
        )
    assert caught.value.safe_details() == {
        "api": "secretmanager",
        "method": "POST",
        "httpStatus": 400,
        "reasons": ["INVALID_ARGUMENT", "ORG_POLICY_VIOLATION"],
        "fields": ["replication.automatic"],
    }
    assert private not in str(caught.value) + repr(caught.value) + json.dumps(vars(caught.value))


def test_failed_write_404_is_not_classified_as_absent(modules, monkeypatch):
    target, resources, *_ = modules
    cloud = object.__new__(resources.Cloud)
    cloud.target, cloud.project_number, cloud._token = target.Target("dev"), "1234", "synthetic"

    def missing(request, **_kwargs):
        raise HTTPError(request.full_url, 404, "synthetic", {}, None)

    monkeypatch.setattr(resources, "urlopen", missing)
    with pytest.raises(resources.CloudRequestError) as caught:
        cloud.request(
            "secretmanager", "projects/hushh-pda-dev/secrets", method="POST", missing=True
        )
    assert caught.value.http_status == 404


@pytest.mark.parametrize("environment", ["dev", "uat"])
def test_rest_quota_header_is_pinned_to_fixed_target(modules, monkeypatch, environment):
    target, resources, *_ = modules
    cloud = object.__new__(resources.Cloud)
    cloud.target, cloud.project_number, cloud._token = (
        target.Target(environment),
        "1234",
        "synthetic",
    )
    monkeypatch.setenv("GOOGLE_CLOUD_QUOTA_PROJECT", "hushh-pda")
    observed = []

    def response(request, **_kwargs):
        observed.append({name.lower(): value for name, value in request.header_items()})
        return io.BytesIO(b"{}")

    monkeypatch.setattr(resources, "urlopen", response)
    cloud.request("cloudresourcemanager", "projects/" + cloud.target.project)
    assert observed[0]["x-goog-user-project"] == cloud.target.project
    assert observed[0]["x-goog-user-project"] != "hushh-pda"


def test_cloud_adapter_refuses_prod_even_before_network(modules, monkeypatch):
    target, resources, *_ = modules
    cloud = object.__new__(resources.Cloud)
    cloud.target, cloud.project_number, cloud._token = target.Target("uat"), "1234", "synthetic"
    monkeypatch.setattr(resources, "urlopen", lambda *_args, **_kwargs: pytest.fail("network used"))
    with pytest.raises(target.QualificationError, match="qualification_cloud_target_invalid"):
        cloud.request("secretmanager", "projects/hushh-pda/secrets/DB_PASSWORD")


def test_enabled_owned_secret_is_reused_without_rotation(modules):
    target, resources, *_ = modules
    selection = target.Target("uat")
    cloud = ExistingSecret(selection, "DB_PASSWORD", b"z" * 43)
    version, value = resources.ensure_secret(cloud, selection, "DB_PASSWORD")
    assert version == "7" and value == b"z" * 43
    assert cloud.posts == []


@pytest.mark.parametrize(
    "case",
    [
        "disabled",
        "public",
        "copied-config",
        "migrator-public",
        "migrator-public-empty",
        "migrator-runtime",
        "migrator-runtime-conditioned",
    ],
)
def test_unsafe_existing_material_is_not_repaired_or_mounted(modules, case):
    target, resources, *_ = modules
    selection = target.Target("uat")
    name, data = "DB_PASSWORD", b"z" * 43
    if case == "copied-config":
        name, data = "BACKEND_RUNTIME_CONFIG_JSON", b'{"db_name":"hushh_vault"}'
    if case.startswith("migrator-"):
        name = "MIGRATOR_DB_PASSWORD"
    cloud = ExistingSecret(
        selection,
        name,
        data,
        state="DISABLED"
        if case == "disabled"
        else "MISSING"
        if case.endswith("empty")
        else "ENABLED",
        public=case in {"public", "migrator-public", "migrator-public-empty"},
        runtime_access=case.startswith("migrator-runtime")
        if case.startswith("migrator-")
        else None,
        conditioned=case.endswith("conditioned"),
    )
    with pytest.raises(target.QualificationError):
        resources.ensure_secret(cloud, selection, name)
    assert cloud.posts == []
    if case == "public" or case.startswith("migrator-"):
        assert cloud.policy_reads == 1 and cloud.value_reads == 0


@pytest.mark.parametrize(
    "name,data",
    [("MIGRATOR_DB_USER", b"plg_qualification_migrator"), ("MIGRATOR_DB_PASSWORD", b"z" * 43)],
)
def test_private_migrator_secret_policy_is_checked_without_runtime_grant(modules, name, data):
    target, resources, *_ = modules
    selection = target.Target("uat")
    cloud = ExistingSecret(selection, name, data)
    version, value = resources.ensure_secret(cloud, selection, name)
    assert (version, value) == ("7", data)
    assert cloud.policy_reads == 1 and cloud.value_reads == 1
    assert cloud.posts == []


def test_shared_database_is_refused_before_namespace_ddl(modules):
    target, _, database, _ = modules
    executed = []

    class Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def execute(self, query, *_args):
            executed.append(query)

        def fetchone(self):
            return ("hushh_vault",)

    class Connection:
        autocommit = True

        def cursor(self):
            return Cursor()

    with pytest.raises(target.QualificationError, match="qualification_database_target_mismatch"):
        database.ensure_namespace(Connection(), target.Target("uat"), {})
    assert executed == ["SELECT current_database()"]


def test_default_plan_has_no_cloud_or_database_side_effects(modules, monkeypatch, tmp_path):
    _, _, _, bootstrap = modules
    output = tmp_path / "plan.json"
    monkeypatch.setattr(bootstrap, "source_boundary", lambda: {})
    monkeypatch.setattr(bootstrap, "Cloud", lambda *_args: pytest.fail("cloud used"))
    monkeypatch.setattr(
        bootstrap, "connect", lambda *_args, **_kwargs: pytest.fail("database used")
    )
    monkeypatch.setattr(
        "sys.argv", ["qualification", "--environment", "uat", "--output", str(output)]
    )
    assert bootstrap.main() == 0
    plan = json.loads(output.read_bytes())
    assert plan["status"] == "planned" and plan["trafficAuthorized"] is False
    assert plan["environmentAccepted"] is False


def test_missing_reviewed_foundation_stops_before_cloud(modules, monkeypatch, tmp_path):
    target, _, _, bootstrap = modules
    monkeypatch.setattr(bootstrap.release_source, "ROOT", tmp_path)
    monkeypatch.setattr(bootstrap, "Cloud", lambda *_args: pytest.fail("cloud used"))
    with pytest.raises(
        target.QualificationError, match="qualification_reviewed_synthetic_foundation_required"
    ):
        bootstrap.preflight(target.Target("uat"))


def test_fixed_foundation_uses_deployed_initializer_without_legacy_users(modules):
    foundation = importlib.import_module("qualification_foundation")
    record = json.loads((ROOT / foundation.PATH).read_bytes())
    foundation.validate_contract(record)
    assert record["foundationRelations"] == ["consent_audit"]
    assert record["legacyUsersRequired"] is False
    assert record["initializer"]["arguments"] == ["--init", "--release-environment", "production"]
    assert record["initializer"]["runsCanonicalReleaseMigrations"] is True


@pytest.mark.parametrize(
    "mutation", ["users-required", "wrong-source", "owner-exemption", "bool-version"]
)
def test_foundation_rejects_changed_authority_or_owner_table_exemption(modules, mutation):
    target, *_ = modules
    foundation = importlib.import_module("qualification_foundation")
    record = copy.deepcopy(json.loads((ROOT / foundation.PATH).read_bytes()))
    if mutation == "users-required":
        record["legacyUsersRequired"] = True
    elif mutation == "wrong-source":
        record["sourceSha"] = "0" * 40
    elif mutation == "owner-exemption":
        record["sourceSeededCatalogs"]["actor_profiles"] = {"columns": ["user_id"], "rows": []}
    else:
        record["sourceSeededCatalogs"]["one_referral_policies"]["rows"][0][0] = True
    with pytest.raises(
        target.QualificationError, match="qualification_foundation_contract_mismatch"
    ):
        foundation.validate_contract(record)


@pytest.mark.parametrize(
    "relation",
    ["consent_scope_templates", "one_referral_policies", "one_referral_program_settings"],
)
def test_only_exact_source_seeded_catalog_identities_are_allowed(modules, relation):
    target, *_ = modules
    foundation = importlib.import_module("qualification_foundation")

    class Cursor:
        def execute(self, _query):
            pass

        def fetchall(self):
            return self.rows

    cursor = Cursor()
    cursor.rows = copy.deepcopy(foundation.CATALOGS[relation]["rows"])
    foundation.inspect_catalog(cursor, relation)
    cursor.rows.append(["unexpected-owner-or-version"])
    with pytest.raises(target.QualificationError, match="qualification_source_catalog_changed"):
        foundation.inspect_catalog(cursor, relation)
    with pytest.raises(target.QualificationError, match="qualification_catalog_not_admitted"):
        foundation.inspect_catalog(cursor, "actor_profiles")


@pytest.mark.parametrize("owner_rows", [False, True])
def test_seeded_baseline_without_users_still_refuses_owner_rows(modules, owner_rows):
    target, _, database, _ = modules
    foundation = importlib.import_module("qualification_foundation")
    connection = SyntheticBaseline(target, database, foundation, owner_rows)
    if owner_rows:
        with pytest.raises(target.QualificationError, match="qualification_baseline_contains_rows"):
            database.inspect_baseline(connection, target.Target("uat"))
    else:
        boundary = database.inspect_baseline(connection, target.Target("uat"))
        assert boundary["ownerRowsCopied"] == 0
        assert boundary["environmentAccepted"] is False


@pytest.mark.parametrize("observed_project", ["hushh-pda-uat", "hushh-pda"])
def test_process_token_avoids_credential_cli_but_still_checks_project(
    modules, monkeypatch, observed_project
):
    target, resources, *_ = modules
    monkeypatch.setenv("CLOUDSDK_AUTH_ACCESS_TOKEN", "synthetic-operator-token")
    monkeypatch.setattr(
        resources.subprocess, "run", lambda *_a, **_k: pytest.fail("credential CLI used")
    )
    monkeypatch.setattr(resources.shutil, "which", lambda *_a: pytest.fail("CLI lookup used"))

    def project(self, api, path, **_kwargs):
        assert api == "cloudresourcemanager" and path == "projects/hushh-pda-uat"
        assert self._token == "synthetic-operator-token"
        return {"projectId": observed_project, "projectNumber": "1234"}

    monkeypatch.setattr(resources.Cloud, "request", project)
    if observed_project == "hushh-pda-uat":
        assert resources.Cloud(target.Target("uat")).project_number == "1234"
    else:
        with pytest.raises(
            target.QualificationError, match="qualification_project_identity_unverified"
        ):
            resources.Cloud(target.Target("uat"))


def test_missing_fallback_cli_refuses_before_credential_or_cloud_calls(modules, monkeypatch):
    target, resources, *_ = modules
    monkeypatch.delenv("CLOUDSDK_AUTH_ACCESS_TOKEN", raising=False)
    monkeypatch.setattr(resources.shutil, "which", lambda *_a: None)
    monkeypatch.setattr(resources.subprocess, "run", lambda *_a, **_k: pytest.fail("CLI used"))
    monkeypatch.setattr(resources.Cloud, "request", lambda *_a, **_k: pytest.fail("cloud used"))
    with pytest.raises(target.QualificationError, match="qualification_cloud_cli_required"):
        resources.Cloud(target.Target("uat"))


def test_fallback_uses_resolved_windows_cli_path(modules, monkeypatch):
    target, resources, *_ = modules
    monkeypatch.delenv("CLOUDSDK_AUTH_ACCESS_TOKEN", raising=False)
    resolved = "C:/synthetic-sdk/gcloud.cmd"
    monkeypatch.setattr(
        resources.shutil, "which", lambda name: resolved if name == "gcloud" else None
    )
    calls = []

    def credential(argv, **_kwargs):
        calls.append(argv)
        return SimpleNamespace(returncode=0, stdout="synthetic-cli-token\n")

    monkeypatch.setattr(resources.subprocess, "run", credential)
    monkeypatch.setattr(
        resources.Cloud,
        "request",
        lambda *_a, **_k: {"projectId": "hushh-pda-uat", "projectNumber": "1234"},
    )
    cloud = resources.Cloud(target.Target("uat"))
    assert cloud.project_number == "1234"
    assert calls == [[resolved, "auth", "print-access-token", "--project=hushh-pda-uat"]]
