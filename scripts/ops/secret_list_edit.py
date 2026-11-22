#!/usr/bin/env python3
"""Safely edit a list-valued secret in Secret Manager.

`gcloud secrets versions add` REPLACES the whole value. There is no append. So
editing a list stored in a secret means read-modify-write, and anyone who skips
the read silently destroys everyone else's entries with no warning.

That is exactly what happened to HUSHH_UAT_PHONE_TEST_NUMBERS on 2026-09-03:
version 8 held 59 UAT test phone numbers, version 9 held 1, written three
minutes later. Every other tester's number was gone and nothing said so. The
symptom surfaced days later as "phone verification is broken".

This tool makes that outcome impossible:

  * it always reads the current value first and unions into it;
  * it REFUSES to write a version with fewer entries than the current one;
  * it prints counts and last-4s, never the values;
  * it is a dry run unless you pass --apply.

Usage
-----
  # See what is there now. Read-only.
  scripts/ops/secret_list_edit.py --secret NAME --project P --show

  # Append entries (dry run, then apply).
  scripts/ops/secret_list_edit.py --secret NAME --project P --add +15551234567
  scripts/ops/secret_list_edit.py --secret NAME --project P --add +15551234567 --apply

  # Restore entries lost by an overwrite: union with an older version.
  scripts/ops/secret_list_edit.py --secret NAME --project P --restore-from 8
  scripts/ops/secret_list_edit.py --secret NAME --project P --restore-from 8 --apply
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

SPLIT = re.compile(r"[,;\s]+")
SYNTHETIC_PHONE_PATTERN = re.compile(r"^\+1[2-9]\d{2}55501\d{2}$")


def get_declared_phone_allowlist_secrets() -> set[str]:
    config_path = (
        Path(__file__).resolve().parents[2] / "config" / "protected-lists.json"
    )
    if not config_path.exists():
        return {"HUSHH_UAT_PHONE_TEST_NUMBERS", "HUSHH_PROD_PHONE_TEST_NUMBERS"}
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return {
            item["name"]
            for item in data.get("secrets", [])
            if "phone" in item.get("name", "").lower()
            or "phone" in item.get("purpose", "").lower()
        }
    except Exception:
        return {"HUSHH_UAT_PHONE_TEST_NUMBERS", "HUSHH_PROD_PHONE_TEST_NUMBERS"}


def run(args: list[str], stdin: str | None = None) -> str:
    proc = subprocess.run(
        args, capture_output=True, text=True, input=stdin, check=False
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        raise SystemExit(f"command failed: {' '.join(args[:4])} ...")
    return proc.stdout


def normalize(raw: str) -> list[str]:
    """Match the backend's own parser: split, strip, force a leading '+'."""
    out: list[str] = []
    for part in SPLIT.split(raw):
        part = part.strip()
        if not part:
            continue
        digits = re.sub(r"[^0-9+]", "", part)
        if digits and not digits.startswith("+"):
            digits = f"+{digits}"
        if digits:
            out.append(digits)
    return out


def read_version(secret: str, project: str, version: str) -> str:
    return run(
        [
            "gcloud",
            "secrets",
            "versions",
            "access",
            version,
            f"--secret={secret}",
            f"--project={project}",
        ]
    )


def summarize(label: str, entries: list[str]) -> None:
    tails = sorted({e[-4:] for e in entries})
    shown = ", ".join(tails[:12]) + (
        f" ... (+{len(tails) - 12} more)" if len(tails) > 12 else ""
    )
    print(f"  {label:22s} {len(entries):3d} entries   last-4: {shown}")


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--secret", required=True)
    ap.add_argument("--project", required=True)
    ap.add_argument("--add", nargs="*", default=[], metavar="ENTRY")
    ap.add_argument(
        "--restore-from",
        metavar="VERSION",
        help="union the current value with this older version",
    )
    ap.add_argument(
        "--replace-synthetic-allowlist",
        nargs="*",
        default=None,
        metavar="ENTRY",
        help="replace entire list with verified 555-01xx synthetic numbers (requires --apply)",
    )
    ap.add_argument("--show", action="store_true", help="read-only summary")
    ap.add_argument(
        "--apply",
        action="store_true",
        help="actually write a new version (default is a dry run)",
    )
    args = ap.parse_args()

    current_raw = read_version(args.secret, args.project, "latest")
    current = normalize(current_raw)
    print(f"{args.secret} in {args.project}")
    summarize("current (latest)", current)

    if args.show:
        return 0

    if args.replace_synthetic_allowlist is not None:
        declared_phone_secrets = get_declared_phone_allowlist_secrets()
        if args.secret not in declared_phone_secrets:
            raise SystemExit(
                "REFUSING: --replace-synthetic-allowlist is restricted to phone allowlist secrets "
                f"declared in config/protected-lists.json ({sorted(declared_phone_secrets)}); "
                f"'{args.secret}' is not a declared phone allowlist secret."
            )
        replacement_raw = args.replace_synthetic_allowlist or args.add
        replacements = normalize(" ".join(replacement_raw))
        if not replacements:
            raise SystemExit(
                "REFUSING: replacement synthetic allowlist cannot be empty."
            )
        invalid = [e for e in replacements if not SYNTHETIC_PHONE_PATTERN.match(e)]
        if invalid:
            raise SystemExit(
                "REFUSING: replacement entries must match ^\\+1[2-9]\\d{2}55501\\d{2}; "
                f"refused: {sorted(invalid)}"
            )
        if len(replacements) < 10:
            raise SystemExit(
                f"REFUSING: replacement synthetic allowlist must contain at least 10 entries (got {len(replacements)})."
            )
        merged = sorted(list(dict.fromkeys(replacements)))
        merged_raw = "\n".join(merged) + "\n"
        summarize("result (synthetic replacement)", merged)
        if not args.apply:
            print("\nDry run. Re-run with --apply to write a new version.")
            return 0
        out = run(
            [
                "gcloud",
                "secrets",
                "versions",
                "add",
                args.secret,
                f"--project={args.project}",
                "--data-file=-",
                "--format=value(name)",
            ],
            stdin=merged_raw,
        )
        print(f"\nwrote version: {out.strip().rsplit('/', 1)[-1]}")
        verify = normalize(read_version(args.secret, args.project, "latest"))
        summarize("verified latest", verify)
        if len(verify) != len(merged):
            raise SystemExit(
                "VERIFY FAILED: the new latest does not match what was written."
            )
        print("  verified: all synthetic replacement entries verified.")
        print(
            f"  Note: In Phase 2/3, after verifying the new version, disable (do not destroy) "
            f"the prior version with: gcloud secrets versions disable <prior_version> "
            f"--secret={args.secret} --project={args.project} to preserve rollback capability."
        )
        return 0

    if not args.add and not args.restore_from:
        print("\nNothing to do. Pass --add and/or --restore-from, or use --show.")
        return 2

    additions: list[str] = normalize(" ".join(args.add)) if args.add else []
    if args.restore_from:
        source = normalize(read_version(args.secret, args.project, args.restore_from))
        summarize(f"version {args.restore_from}", source)
        additions += source

    seen = set(current)
    new_entries = []
    for entry in additions:
        if entry not in seen:
            seen.add(entry)
            new_entries.append(entry)

    merged_raw = (
        current_raw.rstrip("\n") + "".join(f"\n{e}" for e in new_entries) + "\n"
    )
    merged = normalize(merged_raw)
    summarize("result", merged)

    # The invariant that makes the 2026-09-03 incident unrepeatable.
    if len(merged) < len(current):
        raise SystemExit(
            "REFUSING: the result has fewer entries than the current value."
        )
    dropped = [e for e in current if e not in set(merged)]
    if dropped:
        raise SystemExit(f"REFUSING: {len(dropped)} existing entries would be lost.")

    print(f"\n  adding {len(new_entries)} new, keeping all {len(current)} existing")
    if not new_entries:
        print("  nothing new to add; no version written.")
        return 0
    if not args.apply:
        print("\nDry run. Re-run with --apply to write a new version.")
        return 0

    out = run(
        [
            "gcloud",
            "secrets",
            "versions",
            "add",
            args.secret,
            f"--project={args.project}",
            "--data-file=-",
            "--format=value(name)",
        ],
        stdin=merged_raw,
    )
    print(f"\nwrote version: {out.strip().rsplit('/', 1)[-1]}")

    verify = normalize(read_version(args.secret, args.project, "latest"))
    summarize("verified latest", verify)
    if len(verify) != len(merged):
        raise SystemExit(
            "VERIFY FAILED: the new latest does not match what was written."
        )
    print("  verified: every previous entry is still present.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
