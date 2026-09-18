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

``--project`` is required with no default: a key mint must never touch uat or
production by omission. Usage:

    uv run python scripts/ops/mint_consent_ed25519_key.py --project hushh-pda-dev
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
    parser.add_argument("--kid", default=DEFAULT_KID, help=f"Key id (default {DEFAULT_KID}).")
    parser.add_argument(
        "--rotate",
        action="store_true",
        help="Merge the new kid into the existing public map instead of requiring a fresh start.",
    )
    args = parser.parse_args()

    from cryptography.hazmat.primitives import serialization  # noqa: PLC0415

    # noqa above: keep the heavyweight import out of --help.
    from cryptography.hazmat.primitives.asymmetric.ed25519 import (  # noqa: PLC0415
        Ed25519PrivateKey,
    )

    public_map: dict[str, str] = {}
    if args.rotate:
        try:
            public_map = dict(json.loads(_read_secret(PUBLIC_SECRET, args.project)))
        except subprocess.CalledProcessError:
            print(
                f"--rotate needs an existing {PUBLIC_SECRET} in {args.project}; "
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
    elif _secret_exists(PUBLIC_SECRET, args.project):
        print(
            f"{PUBLIC_SECRET} already exists in {args.project}. Re-minting the initial key "
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

    _write_secret(PRIVATE_SECRET, args.project, seed_b64)
    _write_secret(PUBLIC_SECRET, args.project, json.dumps(public_map))

    # The private seed is deliberately never printed.
    print(f"kid: {args.kid}")
    print(f"public: {public_b64}")
    print(f"map kids: {sorted(public_map)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
