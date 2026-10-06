"""Mint (or rotate) the Ed25519 consent-token signing keypair for ONE project.

The wiring rule this repo lives by: a remedy that depends on memory is a defect, so
the mint is a checked-in script rather than a runbook paragraph. It generates both
halves of the keypair in ONE process (a mismatched pair verifies at the hub and
fail-closes in every pod -- silent 403s at the a2a door), pipes the private seed
straight into ``gcloud secrets`` via stdin so it never touches a terminal, shell
history, or file, and prints only the kid and the PUBLIC half.

Shapes match ``hushh_mcp/consent/token_signing.py`` exactly:

* ``CONSENT_ED25519_PRIVATE_KEY``  -- base64 of the raw 32-byte seed
* ``CONSENT_ED25519_PUBLIC_KEYS`` -- JSON ``{kid: b64_raw_32_public}`` map

``--rotate`` READS the current public map first and adds the new kid alongside the
old ones -- never replaces -- so outstanding tokens issued under the previous kid
keep verifying until they expire and the old kid is dropped deliberately.
Rotation is two steps, not one: the deploy pins the SIGNING kid as a literal in
``scripts/deploy/backend-deploy.sh`` (``consent_ed25519_kid`` /
``consent_audit_ed25519_kid``), so a rotated ``--kid`` signs nothing until that
literal moves to it too. For the audit namespace a uat/production hub with the
chain on refuses to start while its signing kid is absent from the published map.

``--namespace audit`` mints the consent-AUDIT chain's key instead
(``CONSENT_AUDIT_ED25519_PRIVATE_KEY`` / ``CONSENT_AUDIT_ED25519_PUBLIC_KEYS``,
default kid ``hushh-audit-dev-1``). A separate keypair by design: the key that
mints a permission must not also sign the record of having minted it.

``--project`` is required with no default: a key mint must never touch uat or
production by omission. Usage:

    uv run python scripts/ops/mint_consent_ed25519_key.py --project hushh-pda-dev
    uv run python scripts/ops/mint_consent_ed25519_key.py --project hushh-pda-dev \
        --namespace audit
    uv run python scripts/ops/mint_consent_ed25519_key.py --project hushh-pda-dev \
        --kid hushh-consent-dev-2 --rotate
"""

from __future__ import annotations

import argparse
import base64
import json
import subprocess
import sys

DEFAULT_KID = "hushh-consent-dev-1"
PRIVATE_SECRET = "CONSENT_ED25519_PRIVATE_KEY"  # noqa: S105 - a Secret Manager NAME, not a credential
PUBLIC_SECRET = "CONSENT_ED25519_PUBLIC_KEYS"  # noqa: S105 - a Secret Manager NAME, not a credential
AUDIT_DEFAULT_KID = "hushh-audit-dev-1"
AUDIT_PRIVATE_SECRET = "CONSENT_AUDIT_ED25519_PRIVATE_KEY"  # noqa: S105 - a secret NAME
AUDIT_PUBLIC_SECRET = "CONSENT_AUDIT_ED25519_PUBLIC_KEYS"  # noqa: S105 - a secret NAME

#: namespace -> (private secret, public secret, default kid). Names must match
#: ``token_signing.CONSENT_TOKENS`` / ``CONSENT_AUDIT``; a test pins both.
NAMESPACES: dict[str, tuple[str, str, str]] = {
    "consent": (PRIVATE_SECRET, PUBLIC_SECRET, DEFAULT_KID),
    "audit": (AUDIT_PRIVATE_SECRET, AUDIT_PUBLIC_SECRET, AUDIT_DEFAULT_KID),
}


def _secret_exists(name: str, project: str) -> bool:
    return (
        subprocess.run(  # noqa: S603 - fixed argv, no shell, operator-supplied project
            ["gcloud", "secrets", "describe", name, f"--project={project}"],  # noqa: S607
            capture_output=True,
            check=False,
        ).returncode
        == 0
    )


def _read_secret(name: str, project: str) -> str:
    result = subprocess.run(  # noqa: S603 - fixed argv, no shell
        [
            "gcloud",
            "secrets",
            "versions",
            "access",
            "latest",
            f"--secret={name}",
            f"--project={project}",
        ],
        capture_output=True,
        check=True,
    )
    return result.stdout.decode("utf-8")


def _write_secret(name: str, project: str, payload: str) -> None:
    """Create the secret or add a version, with the payload on stdin only."""
    if _secret_exists(name, project):
        cmd = [
            "gcloud",
            "secrets",
            "versions",
            "add",
            name,
            f"--project={project}",
            "--data-file=-",
        ]
    else:
        cmd = [
            "gcloud",
            "secrets",
            "create",
            name,
            f"--project={project}",
            "--replication-policy=automatic",
            "--data-file=-",
        ]
    subprocess.run(cmd, input=payload.encode("utf-8"), check=True)  # noqa: S603 - fixed argv


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--project",
        required=True,
        help="GCP project holding the secrets. Required, no default -- deliberately.",
    )
    parser.add_argument(
        "--namespace",
        choices=sorted(NAMESPACES),
        default="consent",
        help="Which keypair: consent tokens (default) or the consent-audit chain.",
    )
    parser.add_argument("--kid", default=None, help="Key id (default: the namespace's own).")
    parser.add_argument(
        "--rotate",
        action="store_true",
        help="Merge the new kid into the existing public map instead of requiring a fresh start.",
    )
    args = parser.parse_args()
    private_secret, public_secret, default_kid = NAMESPACES[args.namespace]
    args.kid = args.kid or default_kid

    from cryptography.hazmat.primitives import serialization  # noqa: PLC0415

    # noqa above: keep the heavyweight import out of --help.
    from cryptography.hazmat.primitives.asymmetric.ed25519 import (  # noqa: PLC0415
        Ed25519PrivateKey,
    )

    public_map: dict[str, str] = {}
    if args.rotate:
        try:
            public_map = dict(json.loads(_read_secret(public_secret, args.project)))
        except subprocess.CalledProcessError:
            print(
                f"--rotate needs an existing {public_secret} in {args.project}; "
                "run once without --rotate first.",
                file=sys.stderr,
            )
            return 1
        if args.kid in public_map:
            print(
                f"kid {args.kid!r} already exists in the public map; pick a new one.",
                file=sys.stderr,
            )
            return 1
    elif _secret_exists(public_secret, args.project):
        print(
            f"{public_secret} already exists in {args.project}. Re-minting the initial key "
            "would strand every outstanding token; use --rotate with a NEW --kid instead.",
            file=sys.stderr,
        )
        return 1

    key = Ed25519PrivateKey.generate()
    seed_b64 = base64.b64encode(
        key.private_bytes(
            serialization.Encoding.Raw,
            serialization.PrivateFormat.Raw,
            serialization.NoEncryption(),
        )
    ).decode("ascii")
    public_b64 = base64.b64encode(
        key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    ).decode("ascii")
    public_map[args.kid] = public_b64

    _write_secret(private_secret, args.project, seed_b64)
    _write_secret(public_secret, args.project, json.dumps(public_map))

    # The private seed is deliberately never printed.
    print(f"kid: {args.kid}")
    print(f"public: {public_b64}")
    print(f"map kids: {sorted(public_map)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
