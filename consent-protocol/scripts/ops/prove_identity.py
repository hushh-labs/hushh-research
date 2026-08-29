#!/usr/bin/env python3
"""Prove Identity is HELD: a pod keeps the SAME key across a real restart.

Three clauses, none sufficient alone:
  1. a genuinely NEW revision ran (a new process, not a cached one);
  2. podKeyId is identical before and after, and podKeyDurable is true on BOTH;
  3. the stored key object was READ, not rewritten (its generation is unchanged).

Plus a negative control: the same pod shape with durable identity OFF must report
podKeyDurable false, so the assertion is one that can fail.

Everything it creates is torn down in `finally`.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import time
from pathlib import Path

# Derived, never hardcoded: this file is tracked and is the reproduction path the
# completion ledger's identity receipt points at, so it has to run from any clone.
REPO = str(Path(__file__).resolve().parents[2])
sys.path.insert(0, REPO)

PROJECT = os.environ.get("HUSSH_POD_PROJECT", "hushh-pda-dev")
REGION = os.environ.get("HUSSH_POD_REGION", "us-central1")
BUCKET = os.environ.get("POD_STORAGE_GCS_BUCKET", "hushh-pda-dev-pod-state")

BASE_ENV = {
    "HUSHH_DEPLOY_ENV": "dev",
    "HUSSH_GCP_BACKEND_LIVE": "true",
    "HUSSH_HOSTED_POD_TIER_ENABLED": "true",
    "HUSSH_POD_PROJECT": PROJECT,
    "HUSSH_ONE_POD_IMAGE": os.environ.get(
        "HUSSH_ONE_POD_IMAGE",
        "gcr.io/hushh-pda-dev/consent-protocol-pod:dev-3debb78b68dcf5bc1675963f83ce97a60145d738",
    ),
    "HUSSH_ONE_POD_SERVICE_ACCOUNT": "hussh-one-pod@hushh-pda-dev.iam.gserviceaccount.com",
    "HUSSH_POD_SIGNING_KEY_SECRET": "HUSSH_POD_DEV_SIGNING_KEY",
    "HUSSH_HUB_BASE_URL": "https://consent-protocol-aqahj4iyha-uc.a.run.app",
    "HUSSH_POD_TURN_ENABLED": "true",
    "HUSSH_POD_INGRESS": "all",
    "POD_STORAGE_BACKEND": "commit_log",
    "POD_STORAGE_GCS_BUCKET": BUCKET,
    "PERSONAL_AGENT_ENABLED": "true",
}


def sh(args: list[str], check: bool = False) -> str:
    r = subprocess.run(args, capture_output=True, text=True)  # noqa: S603
    if check and r.returncode != 0:
        raise RuntimeError(f"{' '.join(args[:4])} -> {r.returncode}: {r.stderr[:300]}")
    return r.stdout.strip()


def secret(name: str, project: str = PROJECT) -> str:
    return sh(
        [
            "gcloud",
            "secrets",
            "versions",
            "access",
            "latest",
            f"--secret={name}",
            f"--project={project}",
        ],
        check=True,
    )


def id_token(audience: str) -> str:
    return sh(["gcloud", "auth", "print-identity-token", "--audiences", audience], check=True)


def pod_get(url: str, path: str, timeout: int = 60) -> tuple[int, dict]:
    import requests

    r = requests.get(
        f"{url.rstrip('/')}{path}",
        headers={"Authorization": f"Bearer {id_token(url)}"},
        timeout=timeout,
    )
    try:
        return r.status_code, dict(r.json() or {})
    except Exception:
        return r.status_code, {"_raw": r.text[:200]}


def obj_generation(hushh_id: str) -> str | None:
    # `gcloud storage ls -l --json` is invalid (the flags are mutually exclusive)
    # and returned nothing, which read as "the object is missing" for an object
    # that was there. `objects describe` is the shape that actually answers.
    out = sh(
        [
            "gcloud",
            "storage",
            "objects",
            "describe",
            f"gs://{BUCKET}/pods/{hushh_id}/keys/pod-identity.bin",
            f"--project={PROJECT}",
            "--format=value(generation)",
        ]
    )
    return out or None


async def provision(hushh_id: str, durable: bool) -> tuple[str, str]:
    from hushh_mcp.services.compute_backend import PodSpec
    from hushh_mcp.services.gcp_backend import GcpBackend
    from hushh_mcp.services.gcp_run_client import GcpRunClient
    from hushh_mcp.services.personal_agent_identity_service import mint_space_id

    os.environ.update(BASE_ENV)
    os.environ["HUSSH_POD_KEY_MASTER"] = secret("HUSSH_POD_KEY_MASTER")
    if durable:
        os.environ["POD_DURABLE_IDENTITY_ENABLED"] = "1"
    else:
        os.environ.pop("POD_DURABLE_IDENTITY_ENABLED", None)

    backend = GcpBackend(project=PROJECT, region=REGION, live=True)
    handle = await backend.provision(
        PodSpec(
            hushh_id=hushh_id,
            phone_e164_hash=f"idproof-{hushh_id}",
            pod_pubkey="",
            space_id=mint_space_id(hushh_id),
        )
    )
    name = str(handle.backend_metadata.get("service") or handle.external_agent_id)
    run = GcpRunClient(project=PROJECT, region=REGION)
    url = (handle.backend_metadata.get("url") or "").strip() or run.service_url(name)
    # Let this operator invoke it directly.
    op = sh(["gcloud", "config", "get-value", "account"])
    try:
        run.set_invoker_binding(
            name, f"serviceAccount:{op}" if op.endswith(".gserviceaccount.com") else f"user:{op}"
        )
    except Exception as exc:
        print(f"    invoker bind note: {exc}")
    return name, url


def wait_key(url: str, tries: int = 20) -> dict:
    for i in range(tries):
        code, body = pod_get(url, "/pod/public-key")
        if code == 200 and body.get("podKeyId"):
            return body
        print(f"    /pod/public-key attempt {i + 1}: {code} {str(body)[:90]}")
        time.sleep(8)
    return {}


async def main() -> int:
    from hushh_mcp.services.gcp_run_client import GcpRunClient

    stamp = time.strftime("%H%M%S")
    hid = f"HA1IDPROOF{stamp}"
    hid_neg = f"HA1IDNEG{stamp}"
    run = GcpRunClient(project=PROJECT, region=REGION)
    made: list[str] = []
    verdict = 1
    try:
        # ---------------- the positive case ----------------
        print(f"[1] provisioning durable-identity pod {hid}", flush=True)
        name, url = await provision(hid, durable=True)
        made.append(name)
        print(f"    service={name}\n    url={url}", flush=True)

        before = wait_key(url)
        rev_before = run.get_service(name).get("status", {}).get("latestReadyRevisionName", "")
        gen_before = obj_generation(hid)
        print(f"[2] BEFORE  durable={before.get('podKeyDurable')} keyId={before.get('podKeyId')}")
        print(f"    revision={rev_before} identityObjGeneration={gen_before}")

        if not before.get("podKeyId"):
            print("FAIL: the pod never published a key")
            return 1
        if before.get("podKeyDurable") is not True:
            print("FAIL: podKeyDurable is not true on first boot")
            return 1
        if gen_before is None:
            print("FAIL: no keys/pod-identity.bin was stored")
            return 1

        # ---------------- force a genuinely new process ----------------
        print("[3] forcing a NEW revision (cold process, not a cached one)", flush=True)
        sh(
            [
                "gcloud",
                "run",
                "services",
                "update",
                name,
                f"--project={PROJECT}",
                f"--region={REGION}",
                "--update-labels",
                f"identity-drill={stamp}",
                "--quiet",
            ]
        )
        time.sleep(10)
        after = wait_key(url)
        rev_after = run.get_service(name).get("status", {}).get("latestReadyRevisionName", "")
        gen_after = obj_generation(hid)
        print(f"[4] AFTER   durable={after.get('podKeyDurable')} keyId={after.get('podKeyId')}")
        print(f"    revision={rev_after} identityObjGeneration={gen_after}")

        # ---------------- the negative control ----------------
        print(f"[5] negative control: same pod shape, durable identity OFF ({hid_neg})", flush=True)
        name_n, url_n = await provision(hid_neg, durable=False)
        made.append(name_n)
        neg = wait_key(url_n)
        print(f"    NEG durable={neg.get('podKeyDurable')} keyId={neg.get('podKeyId')}")

        # ---------------- the verdict ----------------
        clauses = {
            "a NEW revision actually ran": bool(
                rev_before and rev_after and rev_before != rev_after
            ),
            "podKeyId identical across the restart": bool(
                before.get("podKeyId") and before.get("podKeyId") == after.get("podKeyId")
            ),
            "podKeyDurable true on BOTH reads": before.get("podKeyDurable") is True
            and after.get("podKeyDurable") is True,
            "stored key was READ, not rewritten": bool(gen_before and gen_before == gen_after),
            "negative control reports NOT durable": neg.get("podKeyDurable") is not True,
        }
        print("\n" + "=" * 64)
        print("IDENTITY PROOF")
        print("=" * 64)
        for k, v in clauses.items():
            print(f"  {'PASS' if v else 'FAIL'}  {k}")
        ok = all(clauses.values())
        print("=" * 64)
        print("VERDICT: Identity is HELD" if ok else "VERDICT: not proven")
        verdict = 0 if ok else 1
        return verdict
    finally:
        for n in made:
            try:
                run.delete_service(n)
                print(f"[teardown] deleted {n}")
            except Exception as exc:
                print(f"[teardown] {n}: {exc}")
        for h in (hid, hid_neg):
            sh(["gcloud", "storage", "rm", "-r", f"gs://{BUCKET}/pods/{h}", f"--project={PROJECT}"])
        print("[teardown] removed pod state")


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
