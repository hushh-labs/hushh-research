#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Bounded auth-domain repair of the already-restored production application.

This is not promotion authority. The existing emergency workflow still owns
exact-source CI, protected security checks, deployment, health and rollback.
"""
from __future__ import annotations

import argparse
import copy
import importlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, build_opener

SOURCE = "d8a5fa4858741e611d39fd4f1f28b1ab930d057c"
# The held production operational tag points at this staged backend revision.
# Its healthy baseline and sealed primary remain SOURCE; these are distinct
# source roles and must not be collapsed during auth-domain repair admission.
ACTIVE_ANCHOR_SOURCE = "4452c7121c80ef73e8e6d43cd7af19b20f679a83"
CANDIDATE = "00507b68ea293524f73ad42b1839984bcaa46c98"
IMAGES = {
    "frontend": "gcr.io/hushh-pda/hushh-webapp@sha256:88ac5b5b659f6c851e80f3926d553d4443fd4408f283df09a3974650eebecf98",
    "backend": "gcr.io/hushh-pda/consent-protocol@sha256:cce7d40168dfd8fc0958903f530242f754d346c3d8df6ae264e62fd11e889f60",
}
# Observed original image build 9df87145-3cac-4069-9f37-5a8e12e29ab8.
# All pages of version metadata were inspected; no version changed during build.
# Only AUTH_DOMAIN advances (1 -> 2). These identifiers contain no secret values.
VERSIONS = {
    "BACKEND_URL": "3", "APP_FRONTEND_ORIGIN": "124",
    "NEXT_PUBLIC_FIREBASE_API_KEY": "1", "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN": "2",
    "NEXT_PUBLIC_FIREBASE_PROJECT_ID": "1", "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET": "1",
    "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID": "1", "NEXT_PUBLIC_FIREBASE_APP_ID": "2",
    "NEXT_PUBLIC_FIREBASE_VAPID_KEY": "1", "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID": "124",
    "NEXT_PUBLIC_GTM_ID": "123", "NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY": "1",
    "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY": "1", "NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID": "1",
}
RUNTIME_VERSIONS = {
    "BACKEND_URL": "3", "FIREBASE_ADMIN_CREDENTIALS_JSON": "125",
    "APPLE_TEAM_ID": "1", "NEXT_PUBLIC_IOS_BUNDLE_ID": "1",
    "NEXT_PUBLIC_ANDROID_APP_ID": "2", "ANDROID_SHA256_CERT_FINGERPRINTS": "3",
    "MAIL_API_KEY": "1",
}
ALLOWED_DIFF = {".github/workflows/ci.yml"}


def require(condition: object, reason: str) -> None:
    if not condition:
        raise ValueError(reason)


def command(*args: str) -> str:
    result = subprocess.run(args, capture_output=True, text=True, timeout=45)
    require(result.returncode == 0, "Auth-domain repair evidence unavailable")
    require(len(result.stdout) <= 4 * 1024 * 1024, "Evidence exceeds bound")
    return result.stdout


def validate_inputs(inputs: dict) -> bool:
    selected = inputs.get("frontend_auth_domain_refresh", False)
    require(selected in (False, True, "false", "true", ""), "Invalid auth repair intent")
    if selected not in (True, "true"):
        return False
    require(inputs.get("scope") == "frontend", "Auth repair is frontend-only")
    require(bool(inputs.get("emergency_source_ref")) and bool(inputs.get("emergency_reason")),
            "Auth repair requires explicit incident authority")
    require(inputs.get("run_predeploy_backup_job", "false") in (False, "false")
            and inputs.get("nearby_check_in_cohort", "all") == "all",
            "Auth repair cannot change additional settings")
    return True


def validate_source(receipt: dict, *, run=command) -> None:
    authority = receipt.get("authority", {})
    require(receipt.get("kind") == "manual-production-predecessor-exception"
            and receipt.get("scope") == "frontend"
            and authority.get("frontend_auth_domain_refresh") is True,
            "Missing exact auth-domain repair admission")
    target = authority.get("application_sha", "")
    require(target == CANDIDATE, "Unreviewed repair source")
    for kind in IMAGES:
        baseline = receipt.get("baseline", {}).get(kind, {})
        require(baseline.get("source") == SOURCE and baseline.get("image") == IMAGES[kind],
                "Production no longer matches the reviewed restored application")
    changed = set(run("git", "diff", "--name-only", "--no-renames", SOURCE, target).splitlines())
    require(changed and changed <= ALLOWED_DIFF, "Repair changes application content")


def qualify_backend_acceptance_origin(
    receipt: dict, profile: dict, revision: dict
) -> dict:
    """Bind the one accepted restoration run to the physical serving backend."""
    authority = receipt.get("authority", {})
    baseline = receipt.get("baseline", {}).get("backend", {})
    identity = profile.get("backend", {})
    backend = {
        "run_id": str(identity.get("run_id", "")),
        "source": identity.get("source"),
        "revision": identity.get("revision"),
        "uid": identity.get("uid"),
        "service_uid": identity.get("service_uid"),
    }
    metadata = revision.get("metadata", {})
    labels = metadata.get("labels", {})
    operational = profile.get("operational_reference")
    import production_backend_successor as tag_reference
    require(
        isinstance(operational, dict)
        and set(operational)
        == {"ref", "tag_oid", "commit", "healthy_message", "anchor_record", "tag_object"}
        and operational.get("ref") == tag_reference.REF
        and bool(re.fullmatch(r"[0-9a-f]{40}", str(operational.get("tag_oid", ""))))
        and operational.get("commit") == SOURCE
        and isinstance(operational.get("healthy_message"), str)
        and len(operational["healthy_message"].encode()) <= 65536
        and isinstance(operational.get("tag_object"), str)
        and len(operational["tag_object"].encode()) <= 131072,
        "Operational reference is not bound to the reviewed restored source",
    )
    tag = tag_reference.tag_identity(operational["tag_object"])
    tag_healthy, tagged_anchor = tag_reference.split(tag["message"], tag["commit"])
    require(
        tag["tag_oid"] == operational["tag_oid"]
        and tag["commit"] == SOURCE
        and tag_healthy == operational["healthy_message"]
        and tagged_anchor == operational.get("anchor_record"),
        "Operational annotated tag differs from its serialized reference",
    )
    anchor_record = operational.get("anchor_record")
    if anchor_record is not None:
        tag_reference.validate(anchor_record, operational["healthy_message"], SOURCE)
        require(
            anchor_record.get("source") == ACTIVE_ANCHOR_SOURCE
            and anchor_record.get("healthy_commit") == SOURCE,
            "Operational anchor does not match the reviewed staged/healthy source pair",
        )
    else:
        tag_reference.healthy_fields(operational["healthy_message"], SOURCE)
    require(
        receipt.get("kind") == "manual-production-predecessor-exception"
        and receipt.get("scope") == "frontend"
        and authority.get("frontend_auth_domain_refresh") is True
        and authority.get("application_sha") == CANDIDATE
        and baseline.get("source") == SOURCE
        and baseline.get("image") == IMAGES["backend"]
        and type(profile.get("run_id")) is int
        and profile["run_id"] > 0
        and profile["run_id"] != int(backend["run_id"])
        and type(profile.get("run_attempt")) is int
        and profile["run_attempt"] > 0
        and bool(re.fullmatch(r"[0-9a-f]{40}", str(profile.get("workflow_sha", ""))))
        and profile.get("source") == SOURCE
        and identity.get("sha") == SOURCE
        and identity.get("source") == SOURCE
        and identity.get("image") == baseline.get("image")
        and bool(re.fullmatch(r"[1-9][0-9]*", backend["run_id"]))
        and backend["source"] == SOURCE
        and bool(re.fullmatch(r"consent-protocol-[a-z0-9-]+", str(backend["revision"])))
        and all(isinstance(backend[key], str) and 0 < len(backend[key]) <= 256
                for key in ("uid", "service_uid"))
        and baseline.get("revision") == backend["revision"]
        and baseline.get("revision_uid") == backend["uid"]
        and baseline.get("service_uid") == backend["service_uid"]
        and metadata.get("name") == backend["revision"]
        and metadata.get("uid") == backend["uid"]
        and revision.get("status", {}).get("imageDigest") == baseline.get("image")
        and labels.get("serving.knative.dev/service") == "consent-protocol"
        and labels.get("deploy-env") == "production"
        and labels.get("deploy-source") == "deploy-production"
        and labels.get("deploy-sha") == SOURCE
        and labels.get("github-run-id") == backend["run_id"],
        "Current restoration acceptance does not identify the serving backend",
    )
    return {
        "schema_version": 1,
        "kind": "production-auth-domain-backend-acceptance",
        "run_id": profile["run_id"],
        "run_attempt": profile["run_attempt"],
        "workflow_sha": profile["workflow_sha"],
        "source": profile["source"],
        "backend": backend,
        "backend_image": identity["image"],
        "operational_reference": operational,
    }


def pin_config(text: str) -> str:
    names = set(re.findall(r"projects/\$PROJECT_ID/secrets/([A-Z0-9_]+)/versions/latest", text))
    require(names == set(VERSIONS) - {"NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID"},
            "Frontend build secret inventory changed")
    for name in names:
        text = text.replace(f"/secrets/{name}/versions/latest", f"/secrets/{name}/versions/{VERSIONS[name]}")
    pattern = r"gcloud secrets versions access latest (\\\n\s+--secret=NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID)"
    text, count = re.subn(pattern, r"gcloud secrets versions access 1 \1", text)
    require(count == 1, "Google OAuth build input changed")
    for name, version in RUNTIME_VERSIONS.items():
        text = text.replace(f"={name}:latest", f"={name}:{version}")
    # The original serving frontend has no shared rate-limit secret binding.
    text = text.replace('secrets="${secrets},RATE_LIMIT_STORAGE_URI=${_RATE_LIMIT_STORAGE_URI_SECRET}:latest"',
                        'echo "Auth repair cannot add a rate-limit binding" >&2; exit 1')
    return text


def runtime_config(revision: dict, *, original: bool) -> dict:
    spec = copy.deepcopy(revision["spec"])
    containers = spec["containers"]
    require(len(containers) == 1, "Unexpected frontend container inventory")
    container = containers[0]
    container.pop("image", None)
    env = []
    for item in container.get("env", []):
        if item["name"] in {"HUSHH_DEPLOY_SHA", "HUSHH_DEPLOY_RUN_ID"}:
            continue
        reference = item.get("valueFrom", {}).get("secretKeyRef")
        if reference:
            require(reference["name"] in RUNTIME_VERSIONS, "Unreviewed frontend runtime secret")
            expected = RUNTIME_VERSIONS[reference["name"]]
            require(reference["key"] in ({"latest", expected} if original else {expected}),
                    "Unpinned frontend runtime secret")
            reference["key"] = expected
        env.append(item)
    container["env"] = sorted(env, key=lambda item: item["name"])
    annotations = revision.get("metadata", {}).get("annotations", {})
    return {"spec": spec, "runtime_annotations": {
        key: value for key, value in annotations.items()
        if key.startswith("autoscaling.knative.dev/") or key in {
            "run.googleapis.com/vpc-access-connector", "run.googleapis.com/vpc-access-egress",
            "run.googleapis.com/cpu-throttling", "run.googleapis.com/startup-cpu-boost",
            "run.googleapis.com/execution-environment", "run.googleapis.com/encryption-key",
        }
    }}


def verify_frontend_config(receipt: dict, candidate: str) -> None:
    require(re.fullmatch(r"hushh-webapp-[a-z0-9-]+", candidate), "Missing frontend candidate")
    emergency = importlib.import_module("production_emergency")
    previous = emergency.provider("revisions", receipt["baseline"]["frontend"]["revision"])
    proposed = emergency.provider("revisions", candidate)
    require(proposed["metadata"].get("labels", {}).get("deploy-sha") == CANDIDATE,
            "Foreign frontend candidate")
    require(runtime_config(previous, original=True) == runtime_config(proposed, original=False),
            "Frontend runtime configuration changed")


def pin(receipt: dict, root: Path) -> None:
    validate_source(receipt)
    value = command("gcloud", "secrets", "versions", "access", "2",
                    "--secret=NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", "--project=hushh-pda")
    require(value.strip() == "id.hussh.ai", "Branded auth domain version mismatch")
    for name, version in VERSIONS.items():
        state = command("gcloud", "secrets", "versions", "describe", version,
                        f"--secret={name}", "--project=hushh-pda", "--format=value(state)")
        require(state.strip() == "ENABLED", "A pinned build input is unavailable")
    # Compare secret payloads only in process memory; never emit or persist them.
    # This preserves the values used by the serving revision and current cold starts.
    for name, version in RUNTIME_VERSIONS.items():
        current = command("gcloud", "secrets", "versions", "access", "latest",
                          f"--secret={name}", "--project=hushh-pda")
        pinned = command("gcloud", "secrets", "versions", "access", version,
                         f"--secret={name}", "--project=hushh-pda")
        require(current == pinned, "Runtime secret changed since the reviewed baseline")
    optional = command("gcloud", "secrets", "list", "--project=hushh-pda",
                       "--filter=name:NEXT_PUBLIC_GOOGLE_SIGN_IN_CLIENT_ID", "--format=value(name)")
    require(not optional.strip(), "Optional Google sign-in configuration changed")
    resolver = root / "scripts/deploy/resolve-google-sign-in-client.sh"
    require(resolver.read_text() == command("git", "show", f"{SOURCE}:scripts/deploy/resolve-google-sign-in-client.sh"),
            "Sign-in resolver changed")
    resolver.write_text('#!/usr/bin/env bash\nset -euo pipefail\n[ "$#" -eq 2 ]\n: > "$2"\nchmod 600 "$2"\n')
    for filename in ("frontend-image.cloudbuild.yaml", "frontend.cloudbuild.yaml"):
        path = root / "deploy" / filename
        original = command("git", "show", f"{SOURCE}:deploy/{filename}")
        require(path.read_text() == original, "Frontend recipe changed before pinning")
        path.write_text(pin_config(original))


def unchanged_backend(receipt: dict, *, before_promotion: bool = False) -> None:
    validate_source(receipt)
    require(receipt["authority"].get("run_id") == os.environ.get("GITHUB_RUN_ID")
            and receipt["authority"].get("run_attempt") == os.environ.get("GITHUB_RUN_ATTEMPT"),
            "Foreign repair operation")
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    emergency = importlib.import_module("production_emergency")
    current = emergency.capture()
    require(current["backend"] == receipt["baseline"]["backend"], "Backend changed during frontend repair")
    if before_promotion:
        require_frontend_baseline(current["frontend"], receipt["baseline"]["frontend"])


def require_frontend_baseline(current: dict, baseline: dict) -> None:
    # Staging a zero-traffic revision advances the service generation only.
    require({key: value for key, value in current.items() if key != "generation"}
            == {key: value for key, value in baseline.items() if key != "generation"},
            "Frontend traffic or identity changed before promotion")


def qualify_document_mode(args, mode: dict) -> dict:
    require(args.project == "hushh-pda" and args.environment == "production"
            and not any((args.production_restoration, args.verify_previous,
                         args.staged_worker_run_id, args.activation_run_id, args.cold_release_mode,
                         args.rollback_report, args.manual_rollback, args.rebind_backend_report)), "Auth-domain repair cannot change document custody")
    receipt = json.loads(args.frontend_auth_domain_receipt.read_text())
    require(receipt["authority"]["application_sha"] == args.target_sha, "Auth-domain source mismatch")
    unchanged_backend(receipt)
    backend = importlib.import_module("production_emergency").provider(
        "revisions", receipt["baseline"]["backend"]["revision"])
    return effective_document_mode(mode, backend)


def effective_document_mode(mode: dict, backend: dict) -> dict:
    # Stored future policy is not the immutable restored revision's admission.
    # The original restoration pinned literal OFF, which wins runtime hydration.
    flags = [entry for container in backend.get("spec", {}).get("containers", [])
             for entry in container.get("env", [])
             if entry.get("name") == "PROTECTED_DOCUMENT_DELIVERY_ENABLED"]
    require(len(flags) == 1 and flags[0].get("value") == "false"
            and "valueFrom" not in flags[0], "Serving document intake is not explicitly disabled")
    return {**mode, "stored_enabled": mode["enabled"], "enabled": False}


class SameOriginRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        require(urlsplit(newurl).scheme == "https" and urlsplit(newurl).netloc == "one.hussh.ai",
                "Unexpected login redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def verify_bundle() -> None:
    class Scripts(HTMLParser):
        urls: list[str]
        def __init__(self):
            super().__init__()
            self.urls = []
        def handle_starttag(self, tag, attrs):
            src = dict(attrs).get("src")
            if tag == "script" and src:
                self.urls.append(src)
    opener = build_opener(SameOriginRedirect())
    def read(path: str) -> str:
        url = urljoin("https://one.hussh.ai", path)
        parsed = urlsplit(url)
        require(parsed.scheme == "https" and parsed.netloc == "one.hussh.ai", "Foreign asset")
        with opener.open(url, timeout=20) as response:
            value = response.read(5_000_001)
            require(response.status == 200 and len(value) <= 5_000_000, "Invalid asset response")
        return value.decode("utf-8")
    parser = Scripts()
    parser.feed(read("/login"))
    require(0 < len(parser.urls) <= 100, "Unexpected login assets")
    domains = set()
    for path in sorted(set(parser.urls)):
        # External analytics scripts are not Firebase application bundles.
        if urlsplit(urljoin("https://one.hussh.ai", path)).netloc != "one.hussh.ai":
            continue
        domains.update(re.findall(r"authDomain\s*:\s*[\"']([^\"']+)[\"']", read(path)))
    require("id.hussh.ai" in domains and "hushh-pda.firebaseapp.com" not in domains,
            "Published application does not use the branded auth domain")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("pin", "backend", "candidate", "verify"))
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--candidate", default="")
    args = parser.parse_args()
    try:
        receipt = json.loads(args.receipt.read_text())
        require(receipt["authority"]["run_id"] == os.environ.get("GITHUB_RUN_ID")
                and receipt["authority"]["run_attempt"] == os.environ.get("GITHUB_RUN_ATTEMPT"),
                "Foreign repair operation")
        if args.mode == "pin":
            pin(receipt, Path.cwd())
        else:
            unchanged_backend(receipt, before_promotion=args.mode == "candidate")
            if args.mode in {"candidate", "verify"}:
                verify_frontend_config(receipt, args.candidate)
            if args.mode == "verify":
                verify_bundle()
    except (ValueError, KeyError, OSError, subprocess.TimeoutExpired):
        parser.exit(1, "Production auth-domain repair could not be qualified\n")
    print("Production auth-domain repair boundary verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
