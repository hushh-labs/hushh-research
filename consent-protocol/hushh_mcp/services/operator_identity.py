"""Audience-bound Google ID tokens for OPERATOR tooling, in any environment.

A per-user pod carries no ``allUsers`` binding, so reaching one requires an ID
token whose audience is the pod's own URL. The hub mints that from its attached
identity and never thinks about it again. Operator tooling is the hard case: the
same drill or probe has to work in CI, on a workstation, and inside GCP, where
the operator's credential is a different thing each time.

WHY THIS EXISTS RATHER THAN A COPY IN EACH SCRIPT
-------------------------------------------------
Two ops scripts needed this and each grew its own copy, both reading
``load_operator_credentials()._service_account_info`` -- an attribute the loaded
credential does not carry. Both therefore worked only where an explicit operator
key was in the environment and raised ``MalformedError`` everywhere else, which
is the ordinary posture on a workstation. One shared, tested minter is the fix;
two copies would drift again the moment one was corrected.

It lives in the package (not beside the scripts) because every ops script already
puts the protocol root on ``sys.path``, so this needs no new import convention.
The hub does not import it: the hub's own path is ``fetch_id_token`` against the
metadata server, which is source 2 here.
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

_SA_KEY_ENV = "GCP_DEPLOY_SA_KEY_B64"
_GCLOUD_TIMEOUT_SECONDS = 30


def mint_operator_id_token(audience: str) -> str:
    """A Google-signed ID token bound to ``audience``, from the operator identity.

    Three sources are tried in order and the FIRST that yields a token wins, so a
    caller never has to know which environment it is in:

      1. ``GCP_DEPLOY_SA_KEY_B64`` -- an explicit operator key (CI, some shells).
      2. the attached identity or a ``GOOGLE_APPLICATION_CREDENTIALS`` key file,
         via ``fetch_id_token`` -- inside GCP, or a key-file operator.
      3. ``gcloud auth print-identity-token`` -- a workstation where the operator
         service account is gcloud's ACTIVE account but no key is exported and
         ADC is a USER credential, which cannot mint an audience-bound ID token
         at all.

    Raises ``RuntimeError`` naming every source it tried. A failure that names
    only one source sends an operator looking in the wrong place.
    """
    errors: list[str] = []

    raw = os.getenv(_SA_KEY_ENV, "")
    if raw:
        try:
            import base64  # noqa: PLC0415
            import json  # noqa: PLC0415

            from google.auth.transport.requests import Request  # noqa: PLC0415
            from google.oauth2 import service_account  # noqa: PLC0415

            info = json.loads(base64.b64decode(raw))
            creds = service_account.IDTokenCredentials.from_service_account_info(
                info, target_audience=audience
            )
            creds.refresh(Request())
            if creds.token:
                logger.info("operator_identity.minted source=env_key")
                return str(creds.token)
        except Exception as exc:  # noqa: BLE001 - try the next source, name this one
            errors.append(f"env-key: {type(exc).__name__}")

    try:
        import google.auth.transport.requests  # noqa: PLC0415
        import google.oauth2.id_token  # noqa: PLC0415

        token = google.oauth2.id_token.fetch_id_token(
            google.auth.transport.requests.Request(), audience
        )
        if token:
            logger.info("operator_identity.minted source=attached")
            return str(token)
    except Exception as exc:  # noqa: BLE001 - a user ADC cannot do this; fall through
        errors.append(f"attached: {type(exc).__name__}")

    try:
        import subprocess  # noqa: PLC0415

        completed = subprocess.run(  # noqa: S603
            ["gcloud", "auth", "print-identity-token", "--audiences", audience],  # noqa: S607
            capture_output=True,
            text=True,
            timeout=_GCLOUD_TIMEOUT_SECONDS,
        )
        token = (completed.stdout or "").strip()
        if token:
            logger.info("operator_identity.minted source=gcloud")
            return token
        errors.append(f"gcloud: rc={completed.returncode} {(completed.stderr or '').strip()[:80]}")
    except Exception as exc:  # noqa: BLE001
        errors.append(f"gcloud: {type(exc).__name__}")

    raise RuntimeError("could not mint an operator ID token from any source: " + "; ".join(errors))


__all__ = ["mint_operator_id_token"]
