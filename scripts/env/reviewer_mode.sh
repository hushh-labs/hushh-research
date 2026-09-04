#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR/../.." rev-parse --show-toplevel)"
OVERLAY="$REPO_ROOT/consent-protocol/.env.local"

case "${1:-}" in
  enable)
    umask 077
    REVIEWER_PROJECT="${REVIEWER_SECRET_PROJECT:-hushh-pda-uat}"
    REVIEWER_IDENTITY_SOURCE="${2:-secret-manager}"
    python3 - "$OVERLAY" "$REVIEWER_PROJECT" "$REPO_ROOT" "$REVIEWER_IDENTITY_SOURCE" <<'PY'
import pathlib
import re
import subprocess
import sys

path = pathlib.Path(sys.argv[1])
project = sys.argv[2]
repo_root = pathlib.Path(sys.argv[3])
identity_source = sys.argv[4]
if identity_source == "canonical-doc":
    contract = (repo_root / "consent-protocol/docs/reference/env-vars.md").read_text(encoding="utf-8")
    match = re.search(r"current fixture resolves to `([^`]+)` from Firebase Auth email", contract)
    reviewer_uid = match.group(1).strip() if match else ""
elif identity_source == "secret-manager":
    reviewer_uid = subprocess.run(
        [
            "gcloud", "secrets", "versions", "access", "latest",
            "--secret=REVIEWER_UID", f"--project={project}",
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
else:
    raise SystemExit("Reviewer identity source must be secret-manager or canonical-doc.")
if not reviewer_uid:
    raise SystemExit("The selected reviewer identity source returned no reviewer UID.")
lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
if identity_source == "secret-manager":
    # Never let a prior local override pair with the Secret Manager UID.
    # The passphrase will be fetched into reviewer-process memory only.
    lines = [line for line in lines if not line.startswith("REVIEWER_VAULT_PASSPHRASE=")]
updates = {
    "APP_REVIEW_MODE": "true",
    # The backend needs only the stable reviewer subject to mint the local
    # session. The passphrase remains exclusively in the browser process.
    "REVIEWER_UID": reviewer_uid,
}
for key, value in updates.items():
    needle = f"{key}="
    for index, line in enumerate(lines):
        if line.startswith(needle):
            lines[index] = f"{key}={value}"
            break
    else:
        lines.append(f"{key}={value}")
path.write_text("\n".join(lines) + "\n", encoding="utf-8")
path.chmod(0o600)
PY
    echo "Reviewer mode and canonical reviewer subject enabled in ignored consent-protocol/.env.local. Passphrase remains memory-only. Restart the local backend before rehearsal."
    ;;
  disable)
    if [ -f "$OVERLAY" ]; then
      python3 - "$OVERLAY" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
lines = [
    line for line in path.read_text(encoding="utf-8").splitlines()
    if not line.startswith(("APP_REVIEW_MODE=", "REVIEWER_UID="))
]
if lines:
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    path.chmod(0o600)
else:
    path.unlink()
PY
    fi
    echo "Reviewer mode disabled. Restart the local backend to remove the test minter."
    ;;
  status)
    if [ -f "$OVERLAY" ] && grep -qx 'APP_REVIEW_MODE=true' "$OVERLAY"; then
      echo "Reviewer mode overlay: enabled (restart state may differ)."
    else
      echo "Reviewer mode overlay: disabled."
    fi
    ;;
  *)
    echo "Usage: bash scripts/env/reviewer_mode.sh <enable [secret-manager|canonical-doc]|disable|status>" >&2
    exit 1
    ;;
esac
