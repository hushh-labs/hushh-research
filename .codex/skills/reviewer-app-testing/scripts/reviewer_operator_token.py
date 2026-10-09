"""Private harness pipe only: real, lane-contained Firebase reviewer admission."""

from __future__ import annotations

import json
import os
import runpy
import stat
import sys
from pathlib import Path


def mint_reviewer_token(
    firebase_auth, app, requested_uid: str, reviewer_ids: set[str], lane: str
):
    """Never mint another owner or a disabled subject; preserve reviewer containment."""
    if (
        lane not in {"uat", "dev"}
        or len(reviewer_ids) != 2
        or requested_uid not in reviewer_ids
    ):
        raise ValueError("operator_reviewer_authority_refused")
    for reviewer_uid in sorted(reviewer_ids):
        user = firebase_auth.get_user(reviewer_uid, app=app)
        if user.uid != reviewer_uid or user.disabled:
            raise ValueError("operator_reviewer_identity_refused")
    return firebase_auth.create_custom_token(
        requested_uid, {"hushh_review_mint": lane}, app=app
    )


def read_reviewer_binding(config: dict) -> set[str]:
    binding_file = Path(config["reviewer_binding_file"])
    info = binding_file.lstat()
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_mode & 0o077
        or info.st_uid != os.getuid()
        or info.st_size > 50_000
    ):
        raise ValueError("private_reviewer_binding_required")
    binding = json.loads(binding_file.read_text())
    if binding.get("schema_version") != 1 or set(binding.get("reviewers", {})) != {
        "primary",
        "counterpart",
    }:
        raise ValueError("canonical_reviewer_pair_required")
    reviewer_ids = {record["user_id"] for record in binding["reviewers"].values()}
    if len(reviewer_ids) != 2 or config["requested_uid"] not in reviewer_ids:
        raise ValueError("canonical_reviewer_pair_required")
    return reviewer_ids


def shared_dev_reviewer_ids(policy: dict, origin: str, backend: str) -> set[str]:
    """The explicit Dev lane never inherits a preview or production identity."""
    import re

    from hushh_mcp.services.scope_commerce.provider_sandbox import SandboxPolicy

    sandbox = SandboxPolicy.parse(policy.get("scope_commerce_sandbox_policy_json"))
    if (
        origin != "https://dev.one.hushh.ai"
        or not re.fullmatch(
            r"https://consent-protocol-[a-z0-9]+-uc\.a\.run\.app", backend
        )
        and backend != "https://consent-protocol-621416509462.us-central1.run.app"
        # The hosted secret synchronizer still emits the UAT compatibility
        # value; the verified serving revision owns shared Dev's auth lane.
        or policy.get("environment") not in {"dev", "uat"}
        or policy.get("scope_commerce_frontend_origin") != origin
        or policy.get("scope_commerce_sandbox_policy_required") is not True
        or policy.get("scope_commerce_stripe_livemode") is not False
        or policy.get("scope_commerce_stripe_account_id") != "acct_1UNyyyLsJU9ZDBZX"
    ):
        raise ValueError("shared_dev_reviewer_binding_refused")
    sandbox.validate(
        account_id=policy["scope_commerce_stripe_account_id"],
        livemode=False,
        runtime_environments={"dev"},
    )
    return set(sandbox.reviewer_user_ids)


def verify_shared_dev_runtime(read, backend: str) -> dict[str, str]:
    """Read only the fixed Dev service and its actual serving revision."""
    service = read("services/consent-protocol")
    traffic = [
        item
        for item in service.get("status", {}).get("traffic", [])
        if item.get("percent", 0) > 0
    ]
    if (
        backend
        not in {
            service.get("status", {}).get("url"),
            "https://consent-protocol-621416509462.us-central1.run.app",
        }
        or len(traffic) != 1
        or traffic[0].get("percent") != 100
    ):
        raise ValueError("shared_dev_runtime_unverified")
    revision = read("revisions/" + traffic[0]["revisionName"])
    entries = {
        item["name"]: item for item in revision["spec"]["containers"][0].get("env", [])
    }
    env = {name: entry.get("value") for name, entry in entries.items()}
    if (
        env.get("ENVIRONMENT") != "dev"
        or env.get("HUSHH_DEPLOY_ENV") != "dev"
        or env.get("APP_REVIEW_MODE") != "true"
        or str(env.get("APP_RUNTIME_PROFILE") or "").strip().lower() == "production"
        or not any(
            item.get("type") == "Ready" and item.get("status") == "True"
            for item in revision.get("status", {}).get("conditions", [])
        )
    ):
        raise ValueError("shared_dev_runtime_unverified")
    versions = {}
    for name in ("BACKEND_RUNTIME_CONFIG_JSON", "FIREBASE_ADMIN_CREDENTIALS_JSON"):
        ref = entries.get(name, {}).get("valueFrom", {}).get("secretKeyRef", {})
        if ref.get("name") != name or not isinstance(ref.get("key"), str):
            raise ValueError("shared_dev_secret_binding_unverified")
        if ref["key"] != "latest" and not ref["key"].isdigit():
            raise ValueError("shared_dev_secret_binding_unverified")
        versions[name] = ref["key"]
    return versions


def runtime_reviewer_binding(secret, config: dict, read) -> tuple[set[str], str, dict]:
    if secret("APP_FRONTEND_ORIGIN") != config["app_origin"]:
        raise ValueError("isolated_reviewer_runtime_required")
    backend = secret("BACKEND_URL")
    versions = {}
    shared_dev = config["app_origin"] == "https://dev.one.hushh.ai"
    if shared_dev:
        versions = verify_shared_dev_runtime(read, backend)
        policy = json.loads(
            secret(
                "BACKEND_RUNTIME_CONFIG_JSON", versions["BACKEND_RUNTIME_CONFIG_JSON"]
            )
        )
        root = Path(__file__).resolve().parents[4]
        sys.path.insert(0, str(root / "consent-protocol"))
        configured_ids = shared_dev_reviewer_ids(policy, config["app_origin"], backend)
    else:
        policy = json.loads(secret("BACKEND_RUNTIME_CONFIG_JSON"))
        target = runpy.run_path(
            str(
                Path(__file__).resolve().parents[4]
                / "scripts/deploy/commerce-preview-target.py"
            )
        )["PreviewTarget"]()
        configured_ids = target.validate_policy(policy, config["app_origin"], backend)
    return set(configured_ids), "dev" if shared_dev else policy["environment"], versions


def firebase_certificate(secret, versions: dict) -> dict:
    certificate = json.loads(
        secret(
            "FIREBASE_ADMIN_CREDENTIALS_JSON",
            versions.get("FIREBASE_ADMIN_CREDENTIALS_JSON", "latest"),
        )
    )
    if certificate.get("project_id") != "hushh-pda":
        raise ValueError("reviewer_firebase_authority_refused")
    return certificate


def main() -> None:
    import certifi
    import google.auth
    import requests
    from firebase_admin import auth, credentials, delete_app, initialize_app
    from google.auth.transport.requests import Request
    from google.cloud import secretmanager

    # Refuse terminal/file output; the Node adapter owns this private IPC channel.
    for descriptor in (0, 1):
        mode = os.fstat(descriptor).st_mode
        if not (stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode)):
            raise ValueError("operator_reviewer_pipe_required")
    config = json.loads(sys.stdin.read(16_000))
    if set(config) != {"app_origin", "reviewer_binding_file", "requested_uid"}:
        raise ValueError("operator_reviewer_configuration_refused")
    reviewer_ids = read_reviewer_binding(config)
    os.environ["SSL_CERT_FILE"] = certifi.where()
    adc, _ = google.auth.default(
        scopes=[
            "https://www.googleapis.com/auth/cloud-platform",
            "openid",
            "https://www.googleapis.com/auth/userinfo.email",
        ]
    )
    adc.refresh(Request())
    response = requests.get(
        "https://openidconnect.googleapis.com/v1/userinfo",
        headers={"Authorization": "Bearer " + adc.token},
        timeout=20,
    )
    if response.status_code != 200 or response.json().get("email") != "kushal@hushh.ai":
        raise ValueError("approved_operator_identity_required")
    client = secretmanager.SecretManagerServiceClient(credentials=adc)
    shared_dev = config["app_origin"] == "https://dev.one.hushh.ai"
    prefix = "" if shared_dev else "SCOPE_COMMERCE_SANDBOX_"

    def secret(name: str, version: str = "latest") -> str:
        return client.access_secret_version(
            request={
                "name": "projects/hushh-pda-dev/secrets/"
                + prefix
                + name
                + "/versions/"
                + version
            }
        ).payload.data.decode()

    def read(path: str) -> dict:
        base = "https://us-central1-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/hushh-pda-dev/"
        response = requests.get(
            base + path, headers={"Authorization": "Bearer " + adc.token}, timeout=20
        )
        if response.status_code != 200:
            raise ValueError("shared_dev_runtime_unverified")
        return response.json()

    configured_ids, lane, versions = runtime_reviewer_binding(secret, config, read)
    if set(configured_ids) != reviewer_ids:
        raise ValueError("isolated_reviewer_runtime_required")
    firebase = initialize_app(
        credentials.Certificate(firebase_certificate(secret, versions)),
        name="scope-commerce-operator-reviewer",
    )
    try:
        token = mint_reviewer_token(
            auth, firebase, config["requested_uid"], reviewer_ids, lane
        )
        sys.stdout.buffer.write(token if isinstance(token, bytes) else token.encode())
        sys.stdout.flush()
    finally:
        delete_app(firebase)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.stderr.write("operator_reviewer_admission_unavailable\n")
        raise SystemExit(1) from None
