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
# Synthetic records use distinct retrieval queries. The oracle compares the
# returned record, never the query keyword already disclosed to the provider.
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

    async def identity(self, pod_url: str) -> dict[str, Any]:
        """What the pod says its identity is: at least ``podKeyId`` and
        ``podKeyDurable``. Missing identity remains unchecked and prevents a
        whole-drill pass."""
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
    # Identity across the death. None means the fleet does not report identity, so
    # the drill records it as unchecked rather than silently passing it.
    identity_before: str | None = None
    identity_after: str | None = None
    identity_durable: bool | None = None
    identity_durable_before: bool | None = None

    @property
    def identity_checked(self) -> bool:
        return self.identity_before is not None or self.identity_after is not None

    @property
    def identity_preserved(self) -> bool:
        """The pod came back as the SAME agent, and says so durably.

        Both halves are required. Equal key ids on a pod that reports
        ``podKeyDurable: false`` is not durability -- it is two ephemeral pods that
        happened to agree, which is the claim the whole check exists to reject.
        """
        return (
            self.identity_checked
            and self.identity_before is not None
            and self.identity_before == self.identity_after
            and self.identity_durable is True
            and self.identity_durable_before is True
        )

    @property
    def passed(self) -> bool:
        # Every fact recalled after the service died, the pod demonstrably knew
        # the facts BEFORE it died (so recall-after is survival, not a fresh
        # coincidence), and a never-taught keyword surfaced nothing.
        memory_ok = (
            self.learned_before_death
            and self.recalled == self.horizon_size
            and self.negative_control_clean
        )
        # Missing identity evidence is incomplete, never a whole-drill pass.
        return memory_ok and self.identity_preserved

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
    if not horizon:
        raise ValueError("Lifecycle drill requires at least one synthetic fact")
    stages: list[str] = []

    url = await fleet.provision(hushh_id)  # 0 -> 1
    stages.append(f"provisioned {url}")

    for keyword, fact in horizon:
        await fleet.teach(url, keyword, fact)
    stages.append(f"taught {len(horizon)} facts")

    # It must know a fact BEFORE the kill, or a failed recall afterwards is
    # ambiguous between "teaching failed" and "death lost it" -- and the drill
    # exists to catch the second, so it has to rule out the first.
    learned_before_death = True
    for keyword, fact in horizon:
        pre = await fleet.recall(url, keyword)
        learned_before_death = _hit(keyword, fact, pre) and learned_before_death
    stages.append(f"learned_before_death={learned_before_death}")

    identity_before, identity_durable_before = await _identity(fleet, url)
    if identity_before is not None:
        stages.append(f"identity before death={identity_before}")

    await fleet.kill(hushh_id)  # 1 -> 0: the compute is gone
    stages.append("killed the service")

    url = await fleet.provision(hushh_id)  # 0 -> 1 for the SAME owner
    stages.append(f"rebuilt {url}")

    # The identity half of "the same agent came back". Memory can survive on a pod
    # that re-minted its keys, and that pod is a different agent wearing the old
    # agent's memories -- which is why this is asserted separately from recall.
    identity_after, identity_durable = await _identity(fleet, url)
    if identity_after is not None:
        stages.append(f"identity after rebuild={identity_after} durable={identity_durable}")

    recalled = 0
    for keyword, fact in horizon:
        if _hit(keyword, fact, await fleet.recall(url, keyword)):
            recalled += 1
    stages.append(f"recalled {recalled}/{len(horizon)} across the death")

    absent = await fleet.recall(url, absent_keyword)
    negative_control_clean = absent == []
    stages.append(f"negative_control_clean={negative_control_clean}")

    return DrillResult(
        horizon_size=len(horizon),
        learned_before_death=learned_before_death,
        recalled=recalled,
        negative_control_clean=negative_control_clean,
        stages=stages,
        identity_before=identity_before,
        identity_after=identity_after,
        identity_durable=identity_durable,
        identity_durable_before=identity_durable_before,
    )


async def _identity(fleet: Any, pod_url: str) -> tuple[str | None, bool | None]:
    """Ask the pod who it is. A fleet that cannot answer leaves identity unchecked;
    a fleet that answers badly must not be read as an answer, so a failure here is
    recorded as unknown rather than swallowed into a pass."""
    reader = getattr(fleet, "identity", None)
    if reader is None:
        return None, None
    try:
        payload = await reader(pod_url)
    except Exception:  # noqa: BLE001
        print("[drill] identity read unavailable")
        return None, None
    if not isinstance(payload, dict):
        return None, None
    key_id = payload.get("podKeyId") or payload.get("podPublicKey")
    durable = payload.get("podKeyDurable")
    return (
        key_id.strip() if isinstance(key_id, str) and key_id.strip() else None,
        durable if isinstance(durable, bool) else None,
    )


def _hit(keyword: str, fact: str, recalled: list[str]) -> bool:
    """Conservative verbatim recovery oracle; query echo cannot prove recall.

    This measures recovery of the taught synthetic record, not paraphrase or
    semantic quality. An independent semantic evaluation remains required.
    """
    del keyword  # Compatibility with the existing fleet/orchestration seam.
    return (
        isinstance(recalled, list)
        and len(recalled) == 1
        and isinstance(recalled[0], str)
        and " ".join(fact.casefold().split()) == " ".join(recalled[0].casefold().split())
    )


def render_report(result: DrillResult) -> str:
    lines = [
        "=" * 64,
        "POD LIFECYCLE DRILL  ::  teach -> kill -> rebuild -> recall",
        "=" * 64,
        f"  horizon:               {result.horizon_size} facts",
        f"  learned before death:  {result.learned_before_death}",
        f"  recalled after death:  {result.recalled}/{result.horizon_size}",
        f"  negative control:      {'clean' if result.negative_control_clean else 'LEAKED'}",
        (
            f"  identity:              {'PRESERVED' if result.identity_preserved else 'CHANGED'}"
            f" (durable={result.identity_durable})"
            if result.identity_checked
            else "  identity:              not reported by this fleet"
        ),
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

    def __init__(
        self, *, loses_state_on_kill: bool = False, remints_identity_on_kill: bool = False
    ) -> None:
        self._loses_state_on_kill = loses_state_on_kill
        # A pod that re-mints its keys on rebuild keeps the memories and loses the
        # agent: the same records, now held by a identity nobody consented to. The
        # drill has to fail that, so the fake has to be able to do it.
        self._remints_identity_on_kill = remints_identity_on_kill
        # owner -> {keyword: fact}. This is the durable state, NOT the service.
        self._durable: dict[str, dict[str, str]] = {}
        # owner -> durable identity key, minted once and recovered on rebuild.
        self._identity: dict[str, str] = {}
        # pod_url -> owner, so a turn knows whose memory it reads.
        self._live_urls: dict[str, str] = {}
        self._counter = 0

    async def provision(self, hushh_id: str) -> str:
        self._durable.setdefault(hushh_id, {})  # reattach if it already exists
        self._counter += 1
        self._identity.setdefault(hushh_id, f"podk_{hushh_id.lower()}_{self._counter}")
        url = f"https://one-pod-{hushh_id.lower()}-{self._counter}.run.app"
        self._live_urls[url] = hushh_id
        return url

    async def identity(self, pod_url: str) -> dict[str, Any]:
        owner = self._live_urls[pod_url]
        return {"podKeyId": self._identity[owner], "podKeyDurable": True}

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
        if self._remints_identity_on_kill:
            self._identity.pop(hushh_id, None)  # the same memories, a new agent


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

    def __init__(
        self, *, project: str, region: str, consent_token: str = "", user_id: str = ""
    ) -> None:
        self._project = project
        self._region = region
        self._consent_token = consent_token
        self._user_id = user_id
        self._service_names: dict[str, str] = {}
        self._owner_bound = False

    # -- the owner binding a live turn cannot do without ---------------------- #
    #
    # A freshly provisioned pod REFUSES a turn until an owner is bound to it, and
    # this is the step that made the live drill unrunnable while looking finished.
    # The pod does not verify consent locally: it asks the hub, the hub resolves
    # the caller's HusshID from `personal_agent_registry`, and the pod then
    # requires that HusshID to equal its own. So a live turn needs BOTH a registry
    # row mapping this throwaway owner to the pod's HusshID AND a pkm.read grant
    # whose ledger row makes the token read as active. Neither is optional, and
    # neither is something the drill can skip and still be testing the real path.

    async def prepare_owner(self, hushh_id: str) -> None:
        """Bind the throwaway owner to this HusshID and mint its pkm.read grant."""
        if not self._user_id:
            raise RuntimeError("live drill needs --user-id to bind an owner to the pod")
        from hushh_mcp.services.personal_agent_grant_service import (  # noqa: PLC0415
            PersonalAgentGrantService,
        )
        from hushh_mcp.services.personal_agent_registry_repo import (  # noqa: PLC0415
            PersonalAgentRegistryRepo,
        )

        repo = PersonalAgentRegistryRepo()
        await repo.upsert(
            user_id=self._user_id,
            hushh_id=hushh_id,
            phone_e164_hash=f"drill-{hushh_id}",
            status="provisioned",
            backend="gcp",
            external_agent_id=self._service_names.get(hushh_id, ""),
        )
        self._owner_bound = True
        if not self._consent_token:
            grant = await PersonalAgentGrantService().issue_or_reuse_standing_pkm_read(
                self._user_id
            )
            token = grant.get("token") if isinstance(grant, dict) else getattr(grant, "token", "")
            if not token:
                raise RuntimeError("could not mint the pkm.read grant for the drill owner")
            self._consent_token = str(token)

    async def cleanup_owner(self) -> None:
        """Attempt grant revocation; registry and durable resources are retained.

        This is not complete cleanup evidence. Live disposal and ownership
        verification remain required before using this producer operationally.
        """
        if not self._owner_bound:
            return
        try:
            from hushh_mcp.services.personal_agent_grant_service import (  # noqa: PLC0415
                PersonalAgentGrantService,
            )

            await PersonalAgentGrantService().revoke_standing_pkm_read(self._user_id)
        except Exception as exc:  # noqa: BLE001
            print(f"[drill] consent revoke skipped: {type(exc).__name__}")

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
        from hushh_mcp.services.personal_agent_identity_service import (  # noqa: PLC0415
            mint_billing_space_id,
        )

        return PodSpec(
            hushh_id=hushh_id,
            phone_e164_hash=f"drill-{hushh_id}",
            pod_pubkey="",
            # A drill pod bills like any other pod. Leaving this unset would make
            # the drill's own spend the one slice of the fleet nobody can account
            # for, which is exactly what a cost-attribution guard exists to stop.
            billing_space_id=mint_billing_space_id(hushh_id),
        )

    async def provision(self, hushh_id: str) -> str:
        handle = await self._backend().provision(self._spec(hushh_id))
        name = str(handle.backend_metadata.get("service") or handle.external_agent_id)
        self._service_names[hushh_id] = name
        svc = self._run_client().get_service(name) or {}
        url = (((svc.get("status") or {}).get("url")) or "").strip()
        if not url:
            raise RuntimeError(f"provisioned pod {name} exposed no URL")
        # Re-bind on every provision, including the rebuild: the registry row has
        # to name the service that is serving NOW, or the hub answers the pod's
        # consent check for a host that no longer exists.
        if self._user_id:
            await self.prepare_owner(hushh_id)
        return url

    async def teach(self, pod_url: str, keyword: str, fact: str) -> None:
        await asyncio.to_thread(self._turn, pod_url, f"Please remember this: {fact}")

    async def recall(self, pod_url: str, keyword: str) -> list[str]:
        answer = await asyncio.to_thread(
            self._turn,
            pod_url,
            f"Recall the exact record I asked you to remember about {keyword}. "
            "Return only that record verbatim, without commentary. "
            "If no such record is available, return exactly NO_RECORDED_FACT.",
        )
        return [] if answer.strip() == "NO_RECORDED_FACT" else [answer]

    async def kill(self, hushh_id: str) -> None:
        name = self._service_names.get(hushh_id)
        if name:
            await asyncio.to_thread(self._run_client().delete_service, name)

    async def identity(self, pod_url: str) -> dict[str, Any]:
        """Read ``GET /pod/public-key``, the pod's own statement of who it is.

        ``podKeyDurable`` is served by the pod and, until this drill read it, was
        consumed by nothing -- reported but unverified, which is the same shape as
        the gap that made identity ephemeral in the first place.
        """
        import requests  # noqa: PLC0415

        from hushh_mcp.services.operator_identity import mint_operator_id_token  # noqa: PLC0415

        def _get() -> dict[str, Any]:
            resp = requests.get(
                f"{pod_url.rstrip('/')}/pod/public-key",
                headers={"Authorization": f"Bearer {mint_operator_id_token(pod_url)}"},
                timeout=45,
            )
            if resp.status_code != 200:
                raise RuntimeError(f"identity read HTTP {resp.status_code}")
            return dict(resp.json() or {})

        return await asyncio.to_thread(_get)

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
                print(f"[drill] service teardown incomplete: {type(exc).__name__}")
        return removed

    def _turn(self, pod_url: str, message: str) -> str:
        import requests  # noqa: PLC0415

        from hushh_mcp.services.operator_identity import mint_operator_id_token  # noqa: PLC0415

        resp = requests.post(
            f"{pod_url.rstrip('/')}/api/one/pod/turn",
            json={"message": message},
            headers={
                "Authorization": f"Bearer {mint_operator_id_token(pod_url)}",
                "X-Consent-Token": self._consent_token,
                "Content-Type": "application/json",
            },
            timeout=120,
        )
        if resp.status_code != 200:
            # Provider bodies can contain owner information; retain only status.
            raise RuntimeError(f"pod turn HTTP {resp.status_code}")
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

    # And the identity half: a pod that keeps the memories but re-mints its keys is
    # a different agent holding someone's records, which must not read as a pass.
    reminted = asyncio.run(
        run_drill(InMemoryFleet(remints_identity_on_kill=True), hushh_id="HA1DRILLREMINT")
    )
    if reminted.passed:
        print("SELF-TEST FAILED: a pod that re-minted its identity wrongly passed the drill")
        return 1

    print(
        "\nSELF-TEST PASSED: the drill passes a preserving lifecycle and fails both a "
        "state-losing one and an identity-re-minting one."
    )
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
    ap.add_argument(
        "--user-id",
        help="throwaway owner user_id to bind to the pod (the drill mints its own "
        "pkm.read grant unless --consent-token is supplied)",
    )
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

    if not args.project or not args.owner or not (args.user_id or args.consent_token):
        print("live drill needs --project, --owner, and one of --user-id / --consent-token")
        return 2

    fleet = GcpFleet(
        project=args.project,
        region=args.region,
        consent_token=args.consent_token or "",
        user_id=args.user_id or "",
    )
    try:
        result = asyncio.run(run_drill(fleet, hushh_id=args.owner))
        print(render_report(result))
        if args.report_path:
            Path(args.report_path).write_text(json.dumps(result.to_dict(), indent=2))
        return 0 if result.passed else 1
    finally:
        # Everything this run created comes down, in the order that cannot strand
        # a billed resource: the pod first, then the owner it was bound to.
        removed = asyncio.run(fleet.teardown())
        if removed:
            print(f"[drill] tore down {len(removed)} service(s): {', '.join(removed)}")
        asyncio.run(fleet.cleanup_owner())


if __name__ == "__main__":
    raise SystemExit(main())
