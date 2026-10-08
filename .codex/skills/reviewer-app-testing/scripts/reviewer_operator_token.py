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
    if lane != "uat" or len(reviewer_ids) != 2 or requested_uid not in reviewer_ids:
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

    def secret(name: str) -> str:
        return client.access_secret_version(
            request={
                "name": "projects/hushh-pda-dev/secrets/SCOPE_COMMERCE_SANDBOX_"
                + name
                + "/versions/latest"
            }
        ).payload.data.decode()

    policy = json.loads(secret("BACKEND_RUNTIME_CONFIG_JSON"))
    target = runpy.run_path(
        str(
            Path(__file__).resolve().parents[4]
            / "scripts/deploy/commerce-preview-target.py"
        )
    )["PreviewTarget"]()
    if secret("APP_FRONTEND_ORIGIN") != config["app_origin"]:
        raise ValueError("isolated_reviewer_runtime_required")
    configured_ids = target.validate_policy(
        policy, config["app_origin"], secret("BACKEND_URL")
    )
    if set(configured_ids) != reviewer_ids:
        raise ValueError("isolated_reviewer_runtime_required")
    firebase = initialize_app(
        credentials.Certificate(json.loads(secret("FIREBASE_ADMIN_CREDENTIALS_JSON"))),
        name="scope-commerce-operator-reviewer",
    )
    try:
        token = mint_reviewer_token(
            auth, firebase, config["requested_uid"], reviewer_ids, policy["environment"]
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
