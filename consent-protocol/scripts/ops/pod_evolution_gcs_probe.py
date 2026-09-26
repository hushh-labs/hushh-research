#!/usr/bin/env python3
"""Prove the pod's durable memory evolves across restarts, against REAL GCS.

``tests/test_pod_agent_evolution_simulation.py`` proves the evolution mechanism
in-process against a local filesystem store. This ops probe runs the identical
assertion against a real Google Cloud Storage bucket, so it also exercises
``GcsObjectStore`` and the ``ifGenerationMatch`` compare-and-swap the commit log's
atomicity rides on, the parts the hermetic test necessarily stubs.

It is NOT a CI test (it needs live GCS credentials); it is an operator check for
the north star's "keep the pod alive, prove it evolves" claim, on real infrastructure.

Usage (from ``consent-protocol/``, with an authenticated gcloud):
    uv run python scripts/ops/pod_evolution_gcs_probe.py --project hushh-pda-dev

It creates a throwaway bucket, runs a 12-fact / 2-restart evolution soak recalling
through the real ADK ``load_memory`` tool, prints the recall rate, and tears the
bucket down again unless ``--keep-bucket`` is passed. Nothing is left behind on a
clean run, and the bucket only ever holds ciphertext.
"""

from __future__ import annotations

import argparse
import asyncio
import subprocess
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from hushh_mcp.services.pod_commit_log import GcsObjectStore, PodCommitLog  # noqa: E402
from hushh_mcp.services.pod_memory_service import build_pod_memory_service  # noqa: E402

OWNER = "HA1EVOLVEGCS01"
KEY = b"\x51" * 32

# Each fact carries one keyword found in no other fact, so a hit is recall, not luck.
HORIZON: list[tuple[str, str]] = [
    ("radiator", "the guest room radiator leaks when it rains"),
    ("almond", "she is allergic to almond but tolerates other nuts"),
    ("meridian", "the meridian brokerage account number ends in 4269"),
    ("dachshund", "the dachshund is named Pushkin"),
    ("kintsugi", "his kintsugi bowl sits on the third shelf"),
    ("zephyr", "the sailboat is called Zephyr and berths at slip twelve"),
    ("saffron", "the saffron is kept in the blue tin, never the red one"),
    ("obsidian", "the obsidian ring belonged to his grandfather"),
    ("tessellate", "the bathroom tiles tessellate in a Penrose pattern"),
    ("quokka", "the quokka photo was taken on Rottnest Island"),
    ("larch", "the larch by the back fence was planted in 2019"),
    ("velvet", "the velvet chair must never stand in direct sun"),
]


class _Part:
    def __init__(self, text: str) -> None:
        self.text = text


class _Content:
    def __init__(self, text: str) -> None:
        self.parts = [_Part(text)]


class _Event:
    def __init__(self, text: str, author: str = "user") -> None:
        self.author = author
        self.content = _Content(text)


class _Session:
    def __init__(self, *texts: str) -> None:
        self.events = [_Event(t) for t in texts]


class _SaSession:
    """Feed a gcloud access token where GcsObjectStore expects the pod's metadata
    endpoint, and pass every real GCS call through to ``requests``.

    Inside a pod the token comes from the GCE metadata server; run from an operator
    workstation it comes from gcloud. The store's HTTP session is injectable for
    exactly this reason.
    """

    def __init__(self, token: str) -> None:
        import requests  # noqa: PLC0415

        self._token = token
        self._requests = requests

    def _metadata_response(self) -> Any:
        token = self._token

        class _Resp:
            def json(self) -> dict[str, str]:
                return {"access_token": token}

        return _Resp()

    def get(self, url: str, **kw: Any) -> Any:
        if url == GcsObjectStore._METADATA_ACCESS_ENDPOINT:
            return self._metadata_response()
        return self._requests.get(url, **kw)

    def post(self, url: str, **kw: Any) -> Any:
        return self._requests.post(url, **kw)

    def put(self, url: str, **kw: Any) -> Any:
        return self._requests.put(url, **kw)

    def patch(self, url: str, **kw: Any) -> Any:
        return self._requests.patch(url, **kw)

    def delete(self, url: str, **kw: Any) -> Any:
        return self._requests.delete(url, **kw)


def _access_token() -> str:
    return subprocess.run(  # noqa: S603
        ["gcloud", "auth", "print-access-token"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def _log(bucket: str, token: str) -> PodCommitLog:
    return PodCommitLog(GcsObjectStore(bucket, "evo-probe", session=_SaSession(token)), KEY)


async def _store(service: object, fact: str) -> None:
    await service.add_session_to_memory(_Session(fact))  # type: ignore[attr-defined]


async def _recall_via_tool(service: object, keyword: str) -> list[str]:
    from google.adk.tools import load_memory  # noqa: PLC0415

    calls: list[str] = []

    class _Ctx:
        async def search_memory(self, query: str) -> Any:
            calls.append(query)
            return await service.search_memory(  # type: ignore[attr-defined]
                app_name="one", user_id=OWNER, query=query
            )

    response = await load_memory.func(keyword, _Ctx())  # the real ADK tool
    assert calls == [keyword], "load_memory did not invoke the recall path"
    return [m.content.parts[0].text for m in response.memories]


async def _run(bucket: str, token: str) -> bool:
    third = len(HORIZON) // 3

    gen = build_pod_memory_service(hushh_id=OWNER, pod_key=KEY, log=_log(bucket, token))
    for _kw, fact in HORIZON[:third]:
        await _store(gen, fact)
    del gen  # restart 1: nothing in-process survives; only the GCS log

    gen = build_pod_memory_service(hushh_id=OWNER, pod_key=KEY, log=_log(bucket, token))
    if HORIZON[0][1] not in await _recall_via_tool(gen, HORIZON[0][0]):
        print("FAIL: an early fact did not survive the first GCS restart")
        return False
    for _kw, fact in HORIZON[third : 2 * third]:
        await _store(gen, fact)
    del gen  # restart 2

    gen = build_pod_memory_service(hushh_id=OWNER, pod_key=KEY, log=_log(bucket, token))
    for _kw, fact in HORIZON[2 * third :]:
        await _store(gen, fact)

    recalled = 0
    for keyword, fact in HORIZON:
        if fact in await _recall_via_tool(gen, keyword):
            recalled += 1
    rate = recalled / len(HORIZON)
    negative = await _recall_via_tool(gen, "peridot")

    print(
        f"[gcs-evolution] bucket={bucket} horizon={len(HORIZON)} restarts=2 "
        f"recalled={recalled}/{len(HORIZON)} recall_rate={rate:.3f} "
        f"negative_control={'PASS' if negative == [] else 'FAIL'}"
    )
    ok = rate == 1.0 and negative == []
    print(
        "[gcs-evolution] "
        + (
            "PASS -- the load_memory tool recalled every fact from a real GCS "
            "commit log across two restarts"
            if ok
            else "FAIL -- durable evolution did not hold on real GCS"
        )
    )
    return ok


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--project", required=True, help="GCP project for the throwaway bucket")
    ap.add_argument("--location", default="us-central1")
    ap.add_argument(
        "--bucket",
        default="hushh-pod-evolution-probe",
        help="throwaway bucket name (created and, by default, deleted)",
    )
    ap.add_argument("--keep-bucket", action="store_true", help="do not delete the bucket after")
    args = ap.parse_args()

    token = _access_token()
    created = False
    try:
        r = subprocess.run(  # noqa: S603
            [
                "gcloud",
                "storage",
                "buckets",
                "create",
                f"gs://{args.bucket}",
                f"--project={args.project}",
                f"--location={args.location}",
            ],
            capture_output=True,
            text=True,
        )
        created = r.returncode == 0
        if not created and "already exists" not in (r.stderr + r.stdout).lower():
            print(
                f"could not create bucket: {r.stderr.strip() or r.stdout.strip()}", file=sys.stderr
            )
            return 2
        ok = asyncio.run(_run(args.bucket, token))
        return 0 if ok else 1
    finally:
        if created and not args.keep_bucket:
            subprocess.run(  # noqa: S603
                ["gcloud", "storage", "rm", "-r", f"gs://{args.bucket}"],
                capture_output=True,
                text=True,
            )
            print(f"[gcs-evolution] torn down gs://{args.bucket}")


if __name__ == "__main__":
    raise SystemExit(main())
