#!/usr/bin/env python3
"""Live lifecycle drill: kill a pod's compute, prove the SAME agent comes back.

The north star gives the dev environment one job -- "keep the pod alive, prove it
evolves" -- and the crown proof is the double cycle: teach a pod facts over real
turns, DELETE its Cloud Run service, provision the same HusshID again, and watch
it recall across its own death. That was run by hand once against the founder's
pod. By hand once is not a guarantee; a guarantee is a drill that runs the same
sequence on a schedule and goes red the day the lifecycle stops preserving the
agent.

WHAT MAKES THIS DIFFERENT FROM ``pod_evolution_gcs_probe.py``
------------------------------------------------------------
That probe proves the STORAGE layer evolves: it rebuilds the memory *service*
in-process against one real GCS bucket across two restarts. This drill proves the
FULL Cloud Run lifecycle preserves the agent: it provisions a real per-user pod,
teaches it over its HTTP turn surface, deletes the whole service, provisions the
SAME HusshID again, and recalls over a real turn. The durable state lives in the
owner's cloud keyed by HusshID, so a fresh service for the same owner reattaches
to the commit log the deleted service left behind -- that reattachment, across a
real service deletion, is the thing under test.

WHAT IS PROVABLE OFFLINE VS LIVE
--------------------------------
``--dry-run`` runs the whole orchestration -- provision, teach every fact, prove
it learned before death, kill, rebuild the same owner, recall each fact, and the
negative control -- against an in-memory fleet that models the one property that
matters (durable state is keyed by the owner and survives the service's death).
It asserts the sequence is sound AND that a fleet which LOSES state on kill fails
the drill, because an oracle that cannot fail proves nothing. No cloud, runnable
in CI. ``--live`` runs the identical sequence against real Cloud Run and real GCS
and costs real money for the minutes a pod is up, so it is the operator/scheduled
half.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Protocol

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


# --------------------------------------------------------------------------- #
# The horizon. Each fact carries one keyword found in no other fact, so a hit is
# recall, not luck -- the same discipline pod_evolution_gcs_probe.py uses.
# --------------------------------------------------------------------------- #

HORIZON: list[tuple[str, str]] = [
    ("radiator", "the guest room radiator leaks when it rains"),
    ("almond", "she is allergic to almond but tolerates other nuts"),
    ("meridian", "the meridian brokerage account number ends in 4269"),
    ("dachshund", "the dachshund is named Pushkin"),
    ("kintsugi", "his kintsugi bowl sits on the third shelf"),
    ("zephyr", "the sailboat is called Zephyr and berths at slip twelve"),
]
# A keyword taught to NO pod. A drill that "recalls" it is recalling nothing real.
ABSENT_KEYWORD = "peridot"


# --------------------------------------------------------------------------- #
# The fleet seam. The dry-run fake and the live GcpFleet both satisfy this, so
# the sequence under test is identical in CI and in production.
# --------------------------------------------------------------------------- #


class LifecycleFleet(Protocol):
    async def provision(self, hushh_id: str) -> str:
        """Stand up (0 -> 1) the owner's pod and return its URL. Provisioning an
        owner whose durable state already exists REATTACHES to it -- it does not
        mint a fresh agent."""
        ...

    async def teach(self, pod_url: str, keyword: str, fact: str) -> None:
        """Teach one fact over a real turn."""
        ...

    async def recall(self, pod_url: str, keyword: str) -> list[str]:
        """Ask the pod about a keyword; return the fact-strings it surfaced."""
        ...

    async def kill(self, hushh_id: str) -> None:
        """Delete the owner's Cloud Run service (1 -> 0). The durable state in the
        owner's cloud is NOT deleted -- that is what the rebuild reattaches to."""
        ...


# --------------------------------------------------------------------------- #
# The result, JSON-serialisable for the scheduled workflow's artifact.
# --------------------------------------------------------------------------- #


@dataclass
class DrillResult:
    horizon_size: int
    learned_before_death: bool
    recalled: int
    negative_control_clean: bool
    stages: list[str] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        # Every fact recalled after the service died, the pod demonstrably knew
        # the facts BEFORE it died (so recall-after is survival, not a fresh
        # coincidence), and a never-taught keyword surfaced nothing.
        return (
            self.learned_before_death
            and self.recalled == self.horizon_size
            and self.negative_control_clean
        )

    def to_dict(self) -> dict[str, Any]:
        return {**asdict(self), "passed": self.passed}


# --------------------------------------------------------------------------- #
# The core: the double cycle, expressed once, driven by whatever fleet.
# --------------------------------------------------------------------------- #


async def run_drill(
    fleet: LifecycleFleet,
    *,
    hushh_id: str,
    horizon: list[tuple[str, str]] = HORIZON,
    absent_keyword: str = ABSENT_KEYWORD,
) -> DrillResult:
    stages: list[str] = []

    url = await fleet.provision(hushh_id)  # 0 -> 1
    stages.append(f"provisioned {url}")

    for keyword, fact in horizon:
        await fleet.teach(url, keyword, fact)
    stages.append(f"taught {len(horizon)} facts")

    # It must know a fact BEFORE the kill, or a failed recall afterwards is
    # ambiguous between "teaching failed" and "death lost it" -- and the drill
    # exists to catch the second, so it has to rule out the first.
    first_kw, first_fact = horizon[0]
    pre = await fleet.recall(url, first_kw)
    learned_before_death = _hit(first_kw, first_fact, pre)
    stages.append(f"learned_before_death={learned_before_death}")

    await fleet.kill(hushh_id)  # 1 -> 0: the compute is gone
    stages.append("killed the service")

    url = await fleet.provision(hushh_id)  # 0 -> 1 for the SAME owner
    stages.append(f"rebuilt {url}")

    recalled = 0
    for keyword, fact in horizon:
        if _hit(keyword, fact, await fleet.recall(url, keyword)):
            recalled += 1
    stages.append(f"recalled {recalled}/{len(horizon)} across the death")

    absent = await fleet.recall(url, absent_keyword)
    negative_control_clean = not any(absent_keyword.lower() in r.lower() for r in absent)
    stages.append(f"negative_control_clean={negative_control_clean}")

    return DrillResult(
        horizon_size=len(horizon),
        learned_before_death=learned_before_death,
        recalled=recalled,
        negative_control_clean=negative_control_clean,
        stages=stages,
    )


def _hit(keyword: str, fact: str, recalled: list[str]) -> bool:
    """A fact is recalled when the pod surfaced text carrying its unique keyword.
    Keyword rather than exact-string so a live LLM may paraphrase the fact and
    still count, while a never-taught keyword still cannot match."""
    needle = keyword.lower()
    return any(needle in r.lower() for r in recalled)


def render_report(result: DrillResult) -> str:
    lines = [
        "=" * 64,
        "POD LIFECYCLE DRILL  ::  teach -> kill -> rebuild -> recall",
        "=" * 64,
        f"  horizon:               {result.horizon_size} facts",
        f"  learned before death:  {result.learned_before_death}",
        f"  recalled after death:  {result.recalled}/{result.horizon_size}",
        f"  negative control:      {'clean' if result.negative_control_clean else 'LEAKED'}",
        f"  verdict:               {'PASS' if result.passed else 'FAIL'}",
    ]
    for stage in result.stages:
        lines.append(f"    - {stage}")
    lines.append("=" * 64)
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# The in-memory fleet: models durable-state-survives-death and nothing else.
# Its whole job is to make the ORCHESTRATION testable without a cloud.
# --------------------------------------------------------------------------- #


class InMemoryFleet:
    """A fake fleet whose durable memory is keyed by owner and survives ``kill``.

    ``loses_state_on_kill=True`` makes a deliberately broken fleet -- the death
    wipes the owner's memory -- so a test can prove the drill FAILS on a
    lifecycle that does not preserve the agent.
    """

    def __init__(self, *, loses_state_on_kill: bool = False) -> None:
        self._loses_state_on_kill = loses_state_on_kill
        # owner -> {keyword: fact}. This is the durable state, NOT the service.
        self._durable: dict[str, dict[str, str]] = {}
        # pod_url -> owner, so a turn knows whose memory it reads.
        self._live_urls: dict[str, str] = {}
        self._counter = 0

    async def provision(self, hushh_id: str) -> str:
        self._durable.setdefault(hushh_id, {})  # reattach if it already exists
        self._counter += 1
        url = f"https://one-pod-{hushh_id.lower()}-{self._counter}.run.app"
        self._live_urls[url] = hushh_id
        return url

    async def teach(self, pod_url: str, keyword: str, fact: str) -> None:
        owner = self._live_urls[pod_url]
        self._durable[owner][keyword] = fact

    async def recall(self, pod_url: str, keyword: str) -> list[str]:
        owner = self._live_urls[pod_url]
        fact = self._durable[owner].get(keyword)
        return [fact] if fact is not None else []

    async def kill(self, hushh_id: str) -> None:
        # Every URL for this owner stops serving -- the compute is gone.
        self._live_urls = {u: o for u, o in self._live_urls.items() if o != hushh_id}
        if self._loses_state_on_kill:
            self._durable.pop(hushh_id, None)  # the broken lifecycle


# --------------------------------------------------------------------------- #
# The live fleet: real Cloud Run + real GCS. Operator/scheduled half.
# --------------------------------------------------------------------------- #


class GcpFleet:
    """Backs the same four operations with the real per-user pod backend.

    ``provision`` drives ``GcpBackend(live=True).provision`` for the owner and
    resolves the served URL from the run API; ``kill`` deletes the service by name
    via ``GcpRunClient``; ``teach``/``recall`` post real turns as an authorised
    invoker (an operator ID token audience-bound to the pod URL, the same identity
    the hub proxies with). The durable commit log lives in the owner's cloud, so a
    second ``provision`` of the same owner reattaches to it after the first was
    deleted.
    """

    def __init__(self, *, project: str, region: str, consent_token: str) -> None:
        self._project = project
        self._region = region
        self._consent_token = consent_token
        self._service_names: dict[str, str] = {}

    def _backend(self) -> Any:
        from hushh_mcp.services.gcp_backend import GcpBackend  # noqa: PLC0415

        return GcpBackend(project=self._project, region=self._region, live=True)

    def _run_client(self) -> Any:
        from hushh_mcp.services.gcp_run_client import GcpRunClient  # noqa: PLC0415

        return GcpRunClient(project=self._project, region=self._region)

    def _spec(self, hushh_id: str) -> Any:
        # A drill owner is a throwaway HusshID; a real drill run supplies the
        # derived identifiers the same way provisioning does. Kept behind the live
        # path so the dry-run never imports the backend.
        from hushh_mcp.services.compute_backend import PodSpec  # noqa: PLC0415

        return PodSpec(
            hushh_id=hushh_id,
            phone_e164_hash=f"drill-{hushh_id}",
            pod_pubkey="",
        )

    async def provision(self, hushh_id: str) -> str:
        handle = await self._backend().provision(self._spec(hushh_id))
        name = str(handle.backend_metadata.get("service") or handle.external_agent_id)
        self._service_names[hushh_id] = name
        svc = self._run_client().get_service(name) or {}
        url = (((svc.get("status") or {}).get("url")) or "").strip()
        if not url:
            raise RuntimeError(f"provisioned pod {name} exposed no URL")
        return url

    async def teach(self, pod_url: str, keyword: str, fact: str) -> None:
        await asyncio.to_thread(self._turn, pod_url, f"Please remember this: {fact}")

    async def recall(self, pod_url: str, keyword: str) -> list[str]:
        answer = await asyncio.to_thread(self._turn, pod_url, f"What do you know about {keyword}?")
        return [answer]

    async def kill(self, hushh_id: str) -> None:
        name = self._service_names.get(hushh_id)
        if name:
            await asyncio.to_thread(self._run_client().delete_service, name)

    async def teardown(self) -> list[str]:
        """Best-effort deletion of the last service provisioned for each owner --
        the rebuilt pod the drill leaves live. Dev is shared and costed, so a
        drill run must leave nothing serving, whether it passed, failed, or threw.
        An already-deleted service (the one the drill's own kill removed) is not
        an error here."""
        removed: list[str] = []
        for name in list(self._service_names.values()):
            try:
                await asyncio.to_thread(self._run_client().delete_service, name)
                removed.append(name)
            except Exception as exc:  # noqa: BLE001 -- teardown must never raise
                print(f"[drill] teardown of {name} skipped (may already be gone): {exc}")
        return removed

    def _turn(self, pod_url: str, message: str) -> str:
        import requests  # noqa: PLC0415
        from google.auth.transport.requests import Request  # noqa: PLC0415
        from google.oauth2 import service_account  # noqa: PLC0415
        from hushh_mcp.services.gcp_run_client import load_operator_credentials  # noqa: PLC0415

        creds = load_operator_credentials()
        info = getattr(creds, "_service_account_info", None) or {}
        id_creds = service_account.IDTokenCredentials.from_service_account_info(
            info, target_audience=pod_url
        )
        id_creds.refresh(Request())
        resp = requests.post(
            f"{pod_url.rstrip('/')}/api/one/pod/turn",
            json={"message": message},
            headers={
                "Authorization": f"Bearer {id_creds.token}",
                "X-Consent-Token": self._consent_token,
                "Content-Type": "application/json",
            },
            timeout=120,
        )
        body = resp.json() or {}
        return str(body.get("text") or "")


# --------------------------------------------------------------------------- #
# Self-test: the whole orchestration on the in-memory fleet, both directions.
# --------------------------------------------------------------------------- #


def _self_test() -> int:
    good = asyncio.run(run_drill(InMemoryFleet(), hushh_id="HA1DRILLSELFTEST"))
    print(render_report(good))
    if not good.passed:
        print("SELF-TEST FAILED: a state-preserving lifecycle did not pass the drill")
        return 1

    # The negative half: a lifecycle that loses the owner's memory on kill MUST
    # fail. Without this, a drill that always passes would look identical.
    leaky = asyncio.run(
        run_drill(InMemoryFleet(loses_state_on_kill=True), hushh_id="HA1DRILLLEAKY")
    )
    if leaky.passed:
        print("SELF-TEST FAILED: a state-LOSING lifecycle wrongly passed the drill")
        return 1

    print("\nSELF-TEST PASSED: the drill passes a preserving lifecycle and fails a losing one.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true", help="run the offline orchestration check")
    ap.add_argument(
        "--live", action="store_true", help="run against real Cloud Run + GCS (costs $)"
    )
    ap.add_argument("--project", help="GCP project for the live drill")
    ap.add_argument("--region", default="us-central1")
    ap.add_argument("--owner", help="throwaway HusshID for the live drill")
    ap.add_argument("--consent-token", help="pkm.read grant for the live pod turns")
    ap.add_argument("--report-path", help="write the drill result JSON here (for CI artifacts)")
    args = ap.parse_args()

    if not args.live:
        code = _self_test()
        if args.report_path:
            Path(args.report_path).write_text(
                json.dumps({"mode": "dry-run", "passed": code == 0}, indent=2)
            )
        return code

    if not args.project or not args.owner or not args.consent_token:
        print("live drill needs --project, --owner, and --consent-token")
        return 2

    fleet = GcpFleet(project=args.project, region=args.region, consent_token=args.consent_token)
    try:
        result = asyncio.run(run_drill(fleet, hushh_id=args.owner))
        print(render_report(result))
        if args.report_path:
            Path(args.report_path).write_text(json.dumps(result.to_dict(), indent=2))
        return 0 if result.passed else 1
    finally:
        removed = asyncio.run(fleet.teardown())
        if removed:
            print(f"[drill] tore down {len(removed)} service(s): {', '.join(removed)}")


if __name__ == "__main__":
    raise SystemExit(main())
