#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Read-only fixed preview resource, mount, DB and canonical app attestation."""

import argparse
import asyncio
import json
import os
import subprocess
from pathlib import Path
from runpy import run_path
from urllib.parse import urlencode, urlsplit
from urllib.request import Request

ROOT = Path(__file__).resolve().parents[2]
TARGET = run_path(str(Path(__file__).with_name("commerce-preview-target.py")))
PreviewError = TARGET["PreviewError"]
PREFIX = TARGET["PREFIX"]
PROJECT = TARGET["PROJECT"]


class CloudReader:
    """Only describe/access operations; returned values stay in process memory."""

    @staticmethod
    def command(*args: str) -> str:
        result = subprocess.run(  # noqa: S603 - fixed gcloud read commands authored in this module.
            ["gcloud", *args], capture_output=True, text=True, check=False
        )
        if result.returncode:
            raise PreviewError("preview_resource_unavailable")
        return result.stdout.strip()

    def service(self, name: str) -> dict:
        return json.loads(
            self.command(
                "run",
                "services",
                "describe",
                name,
                "--project",
                PROJECT,
                "--region",
                "us-central1",
                "--format=json",
            )
        )

    def secret(self, name: str) -> str:
        value = self.command(
            "secrets",
            "versions",
            "access",
            "latest",
            "--project",
            PROJECT,
            "--secret",
            PREFIX + name,
        )
        if not value:
            raise PreviewError("preview_secret_unavailable")
        return value


def secret_binding(document: dict, reference: str) -> str:
    aliases = {}
    template = document["spec"]["template"]
    for metadata in (document.get("metadata", {}), template.get("metadata", {})):
        value = metadata.get("annotations", {}).get("run.googleapis.com/secrets", "")
        for item in value.split(",") if value else ():
            alias, separator, resource = item.partition(":")
            if (
                not separator
                or not alias
                or not resource
                or (alias in aliases and aliases[alias] != resource)
            ):
                raise PreviewError("preview_secret_alias_unverified")
            aliases[alias] = resource
    resource = aliases.get(reference, reference)
    if "/" in resource:
        parts = resource.split("/")
        projects = {PROJECT, document.get("metadata", {}).get("namespace")}
        if (
            len(parts) != 4
            or parts[0] != "projects"
            or parts[2] != "secrets"
            or parts[1] not in projects
        ):
            raise PreviewError("preview_secret_project_mismatch")
        resource = parts[3]
    if not resource.startswith(PREFIX):
        raise PreviewError("preview_shared_secret_binding")
    if resource.removeprefix(PREFIX) in TARGET["MIGRATION_SECRETS"]:
        raise PreviewError("preview_migration_credential_mounted")
    return resource


def validate_mounts(document: dict, expected: dict[str, str]) -> None:
    containers = document["spec"]["template"]["spec"]["containers"]
    if len(containers) != 1:
        raise PreviewError("preview_container_unverified")
    mounted = {}
    for row in containers[0].get("env", []):
        if row.get("name") in TARGET["MIGRATION_SECRETS"]:
            raise PreviewError("preview_migration_credential_mounted")
        ref = row.get("valueFrom", {}).get("secretKeyRef")
        if ref:
            mounted[row["name"]] = secret_binding(document, ref["name"])
    for volume in document["spec"]["template"]["spec"].get("volumes", []):
        secret = volume.get("secret", {}).get("secretName")
        if secret:
            secret_binding(document, secret)
    if any(mounted.get(key) != PREFIX + value for key, value in expected.items()):
        raise PreviewError("preview_required_mount_missing")


def validate_runtime_database_role(role: dict | None) -> None:
    if (
        not role
        or role.get("rolname") != TARGET["DATABASE"]
        or any(
            role.get(field) is not False
            for field in (
                "rolsuper",
                "rolcreaterole",
                "rolcreatedb",
                "rolreplication",
                "rolbypassrls",
                "elevated_membership",
                "other_database_ownership",
            )
        )
    ):
        raise PreviewError("preview_runtime_database_privileged")


def validate_oauth_process(document: dict) -> None:
    """Check rehearsal process bounds; these settings do not prove OAuth completion."""
    template = document["spec"]["template"]
    containers = template["spec"]["containers"]
    if len(containers) != 1:
        raise PreviewError("preview_oauth_process_unverified")
    workers = [
        row.get("value")
        for row in containers[0].get("env", [])
        if row.get("name") == "WEB_CONCURRENCY"
    ]
    service_max = (
        document.get("metadata", {})
        .get("annotations", {})
        .get("run.googleapis.com/maxScale")
    )
    revision_max = (
        template.get("metadata", {})
        .get("annotations", {})
        .get("autoscaling.knative.dev/maxScale")
    )
    if workers != ["1"] or str(service_max) != "1" or str(revision_max) != "1":
        raise PreviewError("preview_oauth_process_unverified")


def validate_serving_template(document: dict) -> None:
    """Reuse release traffic authority; a no-traffic template is not live evidence."""
    resolver = run_path(str(ROOT / "scripts/ci/resolve-cloud-run-serving-state.py"))
    try:
        state = resolver["resolve_serving_state"](document)
    except ValueError:
        raise PreviewError("preview_serving_revision_unverified") from None
    template = (
        document.get("spec", {}).get("template", {}).get("metadata", {}).get("name")
    )
    # Cloud Run omits metadata.name for server-generated revision names. Its
    # observed created/ready revisions must still identify this serving template;
    # a pending or rolled-back template cannot attest the live mounts.
    if (
        (template is not None and state.revision != template)
        or state.revision != document["status"].get("latestReadyRevisionName")
        or state.revision != document["status"].get("latestCreatedRevisionName")
    ):
        raise PreviewError("preview_serving_revision_unverified")


class PreviewVerifier:
    def __init__(self, reader: CloudReader | None = None):
        self.reader = reader or CloudReader()
        self.target = TARGET["PreviewTarget"]()
        self.stage = "resources"

    def resources(self, *, mounts: bool, serving: bool = False) -> dict:
        backend = self.reader.service(self.target.backend)
        frontend = self.reader.service(self.target.frontend)
        backend_origin = self.target.service_origin(backend, self.target.backend)
        app_origin = self.target.service_origin(frontend, self.target.frontend)
        if serving:
            self.stage = "serving_revision"
            validate_serving_template(backend)
            validate_serving_template(frontend)
        self.stage = "runtime_bindings"
        config = json.loads(self.reader.secret("BACKEND_RUNTIME_CONFIG_JSON"))
        policy_module = run_path(
            str(ROOT / "scripts/ops/scope_commerce_runtime_policy.py")
        )
        policy_module["_validated_scope_commerce_policy"](
            {
                key: value
                for key, value in config.items()
                if key.startswith("scope_commerce_")
            }
        )
        users = self.target.validate_policy(config, app_origin, backend_origin)
        if (
            self.reader.secret("APP_FRONTEND_ORIGIN") != app_origin
            or self.reader.secret("BACKEND_URL") != backend_origin
            or self.reader.secret("DB_USER") != self.target.database
            or self.reader.secret("NEXT_PUBLIC_IOS_BUNDLE_ID")
            != "com.hushh.app.scopecommerce.sandbox"
            or self.reader.secret("NEXT_PUBLIC_ANDROID_APP_ID")
            != "com.hussh.app.scopecommerce.sandbox"
        ):
            raise PreviewError("preview_shared_runtime_binding")
        for name in set(TARGET["PRIVATE_SECRETS"] + TARGET["WEB_SECRETS"]):
            self.reader.secret(name)
        if self.reader.secret("MIGRATOR_DB_USER") != TARGET[
            "MIGRATOR_USER"
        ] or self.reader.secret("MIGRATOR_DB_PASSWORD") == self.reader.secret(
            "DB_PASSWORD"
        ):
            raise PreviewError("preview_migration_credential_unverified")
        stripe_key = self.reader.secret("SCOPE_COMMERCE_STRIPE_SECRET_KEY")
        if not stripe_key.startswith(("sk_test_", "rk_test_")):
            raise PreviewError("preview_stripe_test_key_required")
        if mounts:
            validate_oauth_process(backend)
            validate_mounts(
                backend,
                {
                    name: name
                    for name in TARGET["PRIVATE_SECRETS"]
                    if name != "BACKEND_RUNTIME_CONFIG_JSON"
                }
                | {
                    "BACKEND_RUNTIME_CONFIG_JSON": "BACKEND_RUNTIME_CONFIG_JSON",
                    "APP_FRONTEND_ORIGIN": "APP_FRONTEND_ORIGIN",
                },
            )
            validate_mounts(
                frontend,
                {
                    "BACKEND_URL": "BACKEND_URL",
                    "DEVELOPER_API_URL": "BACKEND_URL",
                    "APP_FRONTEND_ORIGIN": "APP_FRONTEND_ORIGIN",
                    "FIREBASE_ADMIN_CREDENTIALS_JSON": "FIREBASE_ADMIN_CREDENTIALS_JSON",
                },
            )
        return {
            "config": config,
            "users": users,
            "backend_origin": backend_origin,
            "app_origin": app_origin,
        }

    async def database(self, context: dict) -> None:
        import asyncpg

        if (
            os.environ.get("DB_NAME") != self.target.database
            or os.environ.get("DB_HOST") != "127.0.0.1"
            or os.environ.get("DB_PORT") != "6543"
        ):
            raise PreviewError("preview_database_mismatch")
        connection = await asyncpg.connect(
            host=os.environ.get("DB_HOST", ""),
            port=int(os.environ.get("DB_PORT", "5432")),
            database=self.target.database,
            user=self.reader.secret("DB_USER"),
            password=self.reader.secret("DB_PASSWORD"),
            timeout=15,
        )
        try:
            async with connection.transaction(readonly=True):
                if (
                    await connection.fetchval("SELECT current_database()")
                    != self.target.database
                ):
                    raise PreviewError("preview_database_mismatch")
                role = await connection.fetchrow(
                    """SELECT r.rolname, r.rolsuper,
                    r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls,
                    EXISTS(SELECT 1 FROM pg_roles a WHERE (
                        a.rolsuper OR a.rolcreaterole OR a.rolcreatedb OR a.rolreplication
                        OR a.rolbypassrls OR a.rolname IN ('cloudsqlsuperuser',
                        'pg_read_all_data', 'pg_write_all_data', 'pg_read_server_files',
                        'pg_write_server_files', 'pg_execute_server_program'))
                        AND pg_has_role(r.oid, a.oid, 'MEMBER')) AS elevated_membership,
                    EXISTS(SELECT 1 FROM pg_database d WHERE d.datname <> $1
                        AND pg_has_role(r.oid, d.datdba, 'MEMBER')) AS other_database_ownership
                    FROM pg_roles r WHERE r.rolname=current_user""",
                    self.target.database,
                )
                validate_runtime_database_role(dict(role) if role else None)
                unowned = await connection.fetchval("""SELECT count(*) FROM pg_class c
                    JOIN pg_namespace n ON n.oid=c.relnamespace
                    WHERE n.nspname='public' AND c.relkind IN ('r','p')
                    AND c.relname <> 'schema_migrations'
                    AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname=current_user)""")
                if unowned:
                    raise PreviewError("preview_runtime_table_ownership_unverified")
                pin = await connection.fetchrow(
                    "SELECT * FROM scope_commerce_environment WHERE singleton"
                )
                account = context["config"]["scope_commerce_stripe_account_id"]
                if not pin or pin["platform_account_id"] != account or pin["livemode"]:
                    raise PreviewError("preview_provider_pin_unverified")
                # Schema-only bootstrap is an operator prerequisite. Never copy
                # UAT records or tolerate another subject's vault in this target.
                outsiders = await connection.fetchval(
                    "SELECT count(*) FROM vault_keys WHERE NOT(user_id=ANY($1::text[]))",
                    list(context["users"]),
                )
                if outsiders:
                    raise PreviewError("preview_fixture_isolation_unverified")
        finally:
            await connection.close()

    def app(self, context: dict) -> None:
        from firebase_admin import auth, credentials, delete_app, initialize_app

        self.stage = "firebase_configuration"
        credentials_json = json.loads(
            self.reader.secret("FIREBASE_ADMIN_CREDENTIALS_JSON")
        )
        firebase_project = self.reader.secret("NEXT_PUBLIC_FIREBASE_PROJECT_ID")
        if credentials_json.get("project_id") != firebase_project:
            raise PreviewError("preview_firebase_project_mismatch")
        firebase = initialize_app(
            credentials.Certificate(credentials_json), name="commerce-preview-readiness"
        )
        try:
            # Prove both subjects exist before either authentication call.
            # Custom-token sign-in would otherwise create a mistyped UID.
            self.stage = "reviewer_identity"
            for user in context["users"]:
                if auth.get_user(user, app=firebase).disabled:
                    raise PreviewError("preview_reviewer_unavailable")
            api_key = self.reader.secret("NEXT_PUBLIC_FIREBASE_API_KEY")
            for user in context["users"]:
                self.stage = "reviewer_authentication"
                custom_token = auth.create_custom_token(user, app=firebase).decode()
                login = json_http(
                    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?"
                    + urlencode({"key": api_key}),
                    body={"token": custom_token, "returnSecureToken": True},
                )
                self.stage = "application_readiness"
                proof = json_http(
                    context["app_origin"]
                    + "/api/scope-commerce/sandbox-readiness?"
                    + urlencode({"app_origin": context["app_origin"]}),
                    token=login["idToken"],
                )
                validate_app_proof(proof, context)
        finally:
            delete_app(firebase)


def json_http(url: str, *, token: str | None = None, body: dict | None = None) -> dict:
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.fragment
    ):
        raise PreviewError("preview_https_required")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = Request(  # noqa: S310 - HTTPS checked above; redirects explicitly refused below.
        url, data=json.dumps(body).encode() if body else None, headers=headers
    )
    # Redirects could carry bearer authority to a different host.
    from urllib.request import HTTPRedirectHandler, build_opener

    class RefuseRedirect(HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            raise PreviewError("preview_redirect_refused")

    with build_opener(RefuseRedirect()).open(request, timeout=30) as response:
        return json.load(response)


def validate_app_proof(proof: dict, context: dict) -> None:
    contract = json.loads(
        (ROOT / "consent-protocol/db/contracts/prod_core_schema.json").read_text()
    )
    head = contract.get("expected_migration_version")
    if head is None:
        # The canonical contract's current key must be present; never substitute
        # a guessed migration number for hosted ledger evidence.
        raise PreviewError("preview_schema_contract_unverified")
    expected = {
        "app_origin": context["app_origin"],
        "environment": "sandbox",
        "platform_account_id": context["config"]["scope_commerce_stripe_account_id"],
        "livemode": False,
        "persisted_pin_matches": True,
        "reviewer_funding_cap_cents": 2000,
        "operating_capital_cap_cents": 2500,
        "schema_head": int(head),
    }
    if any(proof.get(key) != value for key, value in expected.items()):
        raise PreviewError("preview_app_readiness_unverified")
    enabled = (
        context["config"].get("scope_commerce_enabled") is True
        and context["config"].get("scope_commerce_provider_enabled") is True
    )
    if (
        type(proof.get("new_activity_enabled")) is not bool
        or proof["new_activity_enabled"] != enabled
    ):
        raise PreviewError("preview_admission_state_unverified")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--phase", choices=("resources", "database", "mounts", "app"), required=True
    )
    parser.add_argument("--report-path", required=True)
    args = parser.parse_args()
    report = {
        "target": "scope-commerce-sandbox",
        "classifications": [],
        "required": {},
        "missing_secrets": [],
        "runtime_contract": {},
        "status": "failed",
    }
    try:
        verifier = PreviewVerifier()
        context = verifier.resources(
            mounts=args.phase in {"mounts", "app"}, serving=args.phase == "app"
        )
        if args.phase == "database":
            verifier.stage = "database"
            asyncio.run(verifier.database(context))
        if args.phase == "app":
            verifier.app(context)
        report["status"] = "passed"
    except Exception as error:
        # SDK/HTTP exceptions can contain token-bearing URLs and secret values.
        report["classifications"] = ["commerce_preview_unverified"]
        report["failure_stage"] = verifier.stage
        from urllib.error import HTTPError

        report["http_status"] = (
            error.code
            if isinstance(error, HTTPError)
            and type(error.code) is int
            and 100 <= error.code <= 599
            else None
        )
    Path(args.report_path).write_text(json.dumps(report, sort_keys=True) + "\n")
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
