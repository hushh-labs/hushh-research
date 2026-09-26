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
in CI. ``--live`` currently refuses before acquiring resources: its adapter
does not yet establish exclusive disposable ownership and verified cleanup.
This is an incomplete live assertion, not an operational success.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
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
    resolves the served URL from the run API; ``kill`` verifies and deletes only
    the recorded service incarnation via ``GcpRunClient``; ``teach``/``recall`` post real turns as an authorised
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
        self._service_uids: dict[str, str] = {}
        self._unconfirmed_creates: set[str] = set()
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

        return GcpBackend(
            project=self._project,
            region=self._region,
            live=True,
            client=self._run_client(),
        )

    def _run_client(self) -> Any:
        from hushh_mcp.services.gcp_run_client import GcpRunClient  # noqa: PLC0415

        fleet = self

        class AttemptRunClient(GcpRunClient):
            def create_service(
                self,
                body: dict[str, Any],
                *,
                adopt_existing: bool = False,
            ) -> dict[str, Any]:
                if adopt_existing:
                    raise RuntimeError("drill creation cannot adopt an existing service")
                name = (body.get("metadata") or {}).get("name")
                if not isinstance(name, str) or not name:
                    raise RuntimeError("drill service name unavailable")
                # Record uncertainty before POST. A lost acknowledgement is not
                # permission to adopt or delete an unproven service by name.
                fleet._unconfirmed_creates.add(name)
                created = super().create_service(body, adopt_existing=False)
                metadata = created.get("metadata") or {}
                uid = metadata.get("uid")
                if metadata.get("name") != name or not isinstance(uid, str) or not uid.strip():
                    raise RuntimeError("drill creation incarnation unconfirmed")
                # Captured before backend IAM/readiness work can fail. This is an
                # in-process receipt only; durable attempt recovery remains required.
                fleet._service_uids[name] = uid
                fleet._unconfirmed_creates.discard(name)
                return created

        return AttemptRunClient(project=self._project, region=self._region)

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
        if name not in self._service_uids:
            raise RuntimeError("drill service incarnation was not established by creation")
        self._service_names[hushh_id] = name
        svc = self._run_client().get_service(name) or {}
        if (svc.get("metadata") or {}).get("uid") != self._service_uids[name]:
            raise RuntimeError("drill service incarnation changed before URL observation")
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
        uid = self._service_uids.get(name or "")
        if not name or not uid:
            raise RuntimeError("drill cannot delete an unproven service incarnation")
        await asyncio.to_thread(self._run_client().delete_service, name, expected_uid=uid)

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

    async def teardown(self) -> dict[str, Any]:
        """Verify recorded compute incarnations only; full disposal stays incomplete.

        Includes creations followed by failed IAM/readiness. Unconfirmed creates
        remain unresolved, and no service is deleted using only its name.
        """
        removed: list[str] = []
        failed: list[dict[str, str]] = []
        for name, uid in list(self._service_uids.items()):
            try:
                await asyncio.to_thread(self._run_client().delete_service, name, expected_uid=uid)
                removed.append(name)
            except Exception as exc:  # noqa: BLE001 -- teardown must never raise
                failed.append({"service": name, "error_class": type(exc).__name__})
        return {
            "removed": removed,
            "failed": failed,
            "unconfirmed_creates": sorted(self._unconfirmed_creates),
            "compute_absence_verified": not failed and not self._unconfirmed_creates,
            "external_erasure_verified": False,
            "complete": False,
        }

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
# The memory LEARNING drill: teach, close, paraphrase, correct, restart without
# history, revoke, replay, negative control. The north star's crown proof is
# not that a fact survives; it is that the agent EVOLVES: a paraphrase is
# answered from an observed `load_memory` call, a correction wins over the
# old value, a revocation is final across a restart's replay, and a question
# about nothing taught yields nothing. Every observation is deterministic; the
# judged QUALITY of the answers is a separate number graded in a separate
# session through the puppy-one-harness queue, never added to the rate.
# --------------------------------------------------------------------------- #

NO_RECORDED_FACT = "NO_RECORDED_FACT"
MEMORY_DRILL_ASSERTION_ID = "the-agent-learns-between-turns"
# The close review's own word for "the reviewer asked to retire a fact this caller
# may not retire". The pass ran and then wrote nothing at all, not even its
# additive half (`hushh_mcp.one_adk.memory_review`).
REVIEW_OUTCOME_REFUSED_AUTHORITY = "refused_authority"
# Outcomes a close review only reaches by RUNNING to a decision. `disabled` and a
# missing review object are the two ways a close reviews nothing, and they are the
# only ones `review_ran_on_close` may read as "it did not run". A denial is not one
# of them: reading it as "never reviewed" sends the reader after a missing trigger
# or a pre-join image when the real cause is a binding without `pod.revoke`.
REVIEW_OUTCOMES_THAT_RAN: frozenset[str] = frozenset(
    {"applied", "nothing_to_save", REVIEW_OUTCOME_REFUSED_AUTHORITY}
)
_RECALL_INSTRUCTION = (
    " Answer only from what you remember about me, in one short sentence. "
    f"If you have no recorded fact about this, reply exactly {NO_RECORDED_FACT}."
)
_TOKEN_RE = re.compile(r"[a-z0-9']+")


@dataclass(frozen=True)
class MemoryFact:
    """One synthetic fact: what is taught, how it is asked back, what proves recall.

    ``ask`` is a PARAPHRASE that never contains the value tokens, so an answer
    that echoes the question cannot score. ``correction`` (when set) states a
    new value later in the drill; ``stale_tokens`` are the old value that must
    then never be served again.
    """

    key: str
    teach: str
    ask: str
    value_tokens: tuple[str, ...]
    correction: str = ""
    new_value_tokens: tuple[str, ...] = ()
    stale_tokens: tuple[str, ...] = ()


MEMORY_HORIZON: list[MemoryFact] = [
    MemoryFact(
        "dachshund",
        "my dachshund is named Pushkin",
        "what is the name of my dachshund?",
        ("pushkin",),
    ),
    MemoryFact(
        "almond",
        "I am allergic to almonds but fine with every other nut",
        "which nut am I allergic to?",
        ("almond",),
    ),
    MemoryFact(
        "kintsugi",
        "my kintsugi bowl sits on the third shelf of the study",
        "which shelf holds my kintsugi bowl?",
        ("third",),
    ),
    MemoryFact(
        "radiator",
        "the guest room radiator leaks whenever it rains",
        "what happens to the guest room radiator when it rains?",
        ("leak",),
    ),
    MemoryFact(
        "meridian",
        "my meridian brokerage account number ends in 4269",
        "what are the last digits of my meridian account?",
        ("4269",),
    ),
    MemoryFact(
        "zephyr",
        "my sailboat Zephyr berths at slip twelve",
        "where does my sailboat Zephyr berth?",
        ("twelve",),
        correction="a correction: my sailboat Zephyr now berths at slip forty",
        new_value_tokens=("forty",),
        stale_tokens=("twelve",),
    ),
]
# Taught late, then revoked, then asked again after a restart's replay.
REVOCABLE_FACT = MemoryFact(
    "opal", "my ring holds an opal stone", "what stone does my ring hold?", ("opal",)
)
# A question about something never taught. A pod that answers it is inventing.
ABSENT_MEMORY_QUESTION = "what is the name of my parrot?"


def _answer_tokens(answer: str) -> set[str]:
    return set(_TOKEN_RE.findall(str(answer or "").casefold()))


def _value_hit(
    answer: str, value_tokens: tuple[str, ...], stale_tokens: tuple[str, ...] = ()
) -> bool:
    """Deterministic paraphrase oracle: every value token present, no stale token.

    A value token matches a whole word or the start of one ("leak" matches
    "leaks"). A stale token matches a whole word only. Verbatim `_hit` stays for
    the older drill; this one measures whether the VALUE came back, whatever the
    sentence around it, which is what a paraphrase question asks for.
    """
    tokens = _answer_tokens(answer)
    if not tokens or not value_tokens:
        return False
    for value in value_tokens:
        value = value.casefold()
        if not any(tok == value or tok.startswith(value) for tok in tokens):
            return False
    return not any(stale.casefold() in tokens for stale in stale_tokens)


def _no_fact_shaped(answer: str) -> bool:
    return NO_RECORDED_FACT in str(answer or "").upper()


def _observed_recall(turn: dict[str, Any]) -> tuple[int, int]:
    """(observed load_memory calls, calls with at least one hit) off the turn's report."""
    memory = turn.get("memory") if isinstance(turn, dict) else None
    recalls = memory.get("recalls") if isinstance(memory, dict) else None
    if not isinstance(recalls, list):
        return 0, 0
    calls = [r for r in recalls if isinstance(r, dict)]
    return len(calls), sum(1 for r in calls if int(r.get("hits") or 0) >= 1)


def _provider_consistent(turn: dict[str, Any]) -> bool:
    """A provider recall may only be credited under a recorded consent.

    ``credits_fallback_as_provider`` is the leak this catches: a report that says
    the provider answered while consent is absent is a fallback wearing the
    provider's name, and the ledger item this drill feeds must never accept it.
    """
    memory = turn.get("memory") if isinstance(turn, dict) else None
    provider = memory.get("provider") if isinstance(memory, dict) else None
    if not isinstance(provider, dict):
        return True
    recall = str(provider.get("recall") or "")
    generate = str(provider.get("generate") or "")
    consented = str(provider.get("consent") or "") == "granted"
    return consented or (
        recall not in {"completed", "filtered_revoked"} and generate != "completed"
    )


@dataclass
class MemoryDrillResult:
    horizon_size: int
    memory_join_present_on_image: bool = False
    taught: int = 0
    review_ran_on_close: bool = False
    # A close review that ran and was DENIED its retirement authority. Its own
    # verdict, kept apart from `review_ran_on_close`, because the two call for
    # opposite repairs: one says the review never happened, this one says it
    # happened and threw the whole pass away. Either fails the drill.
    review_authority_denied_on_close: bool = False
    review_provider_matches_turn_provider: bool = False
    review_outputs_only_proposals: bool = True
    paraphrase_recalled: int = 0
    recall_via_observed_tool_call: int = 0
    correction_supersedes: bool = False
    stale_value_not_recalled: bool = False
    restart_without_history: int = 0
    restart_replaced_revision: bool = False
    revoked_fact_not_recalled_after_replay: bool = False
    negative_control_clean: bool = False
    tombstones_increased: bool = False
    catch_up_debt_zero: bool = False
    provider_report_consistent: bool = True
    every_recall_carried_empty_history: bool = True
    stages: list[str] = field(default_factory=list)
    timings_ms: dict[str, int] = field(default_factory=dict)
    judge_rows: list[dict[str, str]] = field(default_factory=list)
    turn_provider: str = ""

    @property
    def passed(self) -> bool:
        return (
            self.memory_join_present_on_image
            and self.taught >= self.horizon_size
            and self.review_ran_on_close
            and not self.review_authority_denied_on_close
            and self.review_provider_matches_turn_provider
            and self.review_outputs_only_proposals
            and self.paraphrase_recalled == self.horizon_size
            and self.recall_via_observed_tool_call == self.horizon_size
            and self.correction_supersedes
            and self.stale_value_not_recalled
            and self.restart_replaced_revision
            and self.restart_without_history == self.horizon_size
            and self.revoked_fact_not_recalled_after_replay
            and self.negative_control_clean
            and self.tombstones_increased
            and self.catch_up_debt_zero
            and self.provider_report_consistent
            and self.every_recall_carried_empty_history
        )

    def observations(self) -> dict[str, Any]:
        """The ledger's observation names for ``the-agent-learns-between-turns``."""
        return {
            "taught": self.taught,
            "paraphrase_recalled": self.paraphrase_recalled == self.horizon_size,
            "recall_via_observed_tool_call": self.recall_via_observed_tool_call
            == self.horizon_size,
            "correction_supersedes": self.correction_supersedes,
            "stale_value_not_recalled": self.stale_value_not_recalled,
            "restart_without_history": self.restart_without_history == self.horizon_size,
            "revoked_fact_not_recalled_after_replay": self.revoked_fact_not_recalled_after_replay,
            "negative_control_clean": self.negative_control_clean,
            "review_ran_on_close": self.review_ran_on_close,
            "review_authority_not_denied_on_close": not self.review_authority_denied_on_close,
            "review_provider_matches_turn_provider": self.review_provider_matches_turn_provider,
            "memory_join_present_on_image": self.memory_join_present_on_image,
            "catch_up_debt_zero": self.catch_up_debt_zero,
            "provider_report_consistent": self.provider_report_consistent,
            "tombstones_increased": self.tombstones_increased,
            "quality_judged_independently": False,  # set by the judge run, never here
        }

    def to_dict(self) -> dict[str, Any]:
        out = {k: v for k, v in asdict(self).items() if k != "judge_rows"}
        out["passed"] = self.passed
        out["observations"] = self.observations()
        return out


async def run_memory_learning_drill(
    fleet: Any,
    *,
    hushh_id: str,
    horizon: list[MemoryFact] = MEMORY_HORIZON,
    revocable: MemoryFact = REVOCABLE_FACT,
    absent_question: str = ABSENT_MEMORY_QUESTION,
    expect_image_tag: str | None = None,
) -> MemoryDrillResult:
    """The learning loop, stage by stage, on whatever fleet. Deterministic oracle."""
    if not horizon:
        raise ValueError("the memory drill requires at least one synthetic fact")
    corrected = [f for f in horizon if f.correction]
    if len(corrected) != 1:
        raise ValueError("the memory drill horizon must carry exactly one correctable fact")
    correctable = corrected[0]
    result = MemoryDrillResult(horizon_size=len(horizon))
    stages = result.stages
    clock = time.perf_counter

    def stamp(name: str, started: float) -> None:
        result.timings_ms[name] = round((clock() - started) * 1000)

    async def ask(question: str) -> dict[str, Any]:
        turn = await fleet.ask(url, question + _RECALL_INSTRUCTION, history=[])
        carried = getattr(fleet, "last_history", [])
        if carried:
            result.every_recall_carried_empty_history = False
        if not _provider_consistent(turn):
            result.provider_report_consistent = False
        return turn if isinstance(turn, dict) else {"text": str(turn)}

    def answered(turn: dict[str, Any]) -> str:
        return str(turn.get("text") or "")

    def review_of(close: Any) -> dict[str, Any]:
        """The review report a close returned, or an empty one if it returned none.

        Every close in this drill goes through here, not only the first. A denial
        on the CORRECTION close is the one that costs the most -- the correction
        and everything beside it is dropped -- and it used to surface only as
        `correction_supersedes=False`, which reads as a pod that ignores
        corrections. The drill is the measurement instrument, so it names the
        cause it can actually see.
        """
        memory = close.get("memory") if isinstance(close, dict) else None
        review = memory.get("review") if isinstance(memory, dict) else None
        if not isinstance(review, dict):
            return {}
        if str(review.get("outcome") or "") == REVIEW_OUTCOME_REFUSED_AUTHORITY:
            result.review_authority_denied_on_close = True
        return review

    def recalled(turn: dict[str, Any], fact: MemoryFact, *, after_correction: bool) -> bool:
        tokens = (
            fact.new_value_tokens if (after_correction and fact.correction) else fact.value_tokens
        )
        stale = fact.stale_tokens if (after_correction and fact.correction) else ()
        return _value_hit(answered(turn), tokens, stale)

    url = await fleet.provision(hushh_id)
    stages.append(f"provisioned {url}")

    # PRECONDITION: the installed image carries the join, or nothing below means anything.
    started = clock()
    info = await fleet.info(url)
    join = info.get("memoryJoin") if isinstance(info, dict) else None
    join = join if isinstance(join, dict) else {}
    result.memory_join_present_on_image = (
        info.get("memoryEnabled") is True
        and join.get("write") is True
        and join.get("review") is True
        and join.get("tombstones") is True
        and int(join.get("schema") or 0) == 2
        and (expect_image_tag is None or str(info.get("imageTag") or "") == expect_image_tag)
    )
    revision_before = str(info.get("revision") or "")
    image_before = str(info.get("imageTag") or "")
    stamp("precondition", started)
    stages.append(f"memory_join_present_on_image={result.memory_join_present_on_image}")

    # STAGE 1: teach, then close. The first turn must return a memory object.
    started = clock()
    teach_conversation = "drill-teach-1"
    first = True
    for fact in horizon:
        turn = await fleet.say(url, f"Please remember this: {fact.teach}", teach_conversation)
        if first:
            first = False
            if not isinstance(turn.get("memory"), dict):
                result.memory_join_present_on_image = False
            result.turn_provider = str(turn.get("provider") or "")
        result.taught += 1
    close = await fleet.close_conversation(url, teach_conversation)
    review = review_of(close)
    result.review_ran_on_close = (
        str(review.get("outcome") or "") in REVIEW_OUTCOMES_THAT_RAN
        and review.get("reason") == "close"
    )
    review_provider = str(close.get("provider") or review.get("provider") or "")
    result.review_provider_matches_turn_provider = bool(result.turn_provider) and (
        review_provider == result.turn_provider
    )
    for directive in close.get("directives") or []:
        payload = directive.get("payload") if isinstance(directive, dict) else None
        if (
            not isinstance(directive, dict)
            or directive.get("kind") != "prompt"
            or not isinstance(payload, dict)
            or payload.get("type") != "pkm_memory_proposal"
        ):
            result.review_outputs_only_proposals = False
    stamp("teach_and_close", started)
    stages.append(
        f"taught {result.taught} facts; review_ran_on_close={result.review_ran_on_close} "
        f"authority_denied={result.review_authority_denied_on_close} "
        f"provider_match={result.review_provider_matches_turn_provider}"
    )

    # STAGE 2: paraphrase recall, each with history: [] and an observed tool call.
    started = clock()
    for fact in horizon:
        turn = await ask(fact.ask)
        calls, with_hits = _observed_recall(turn)
        hit = recalled(turn, fact, after_correction=False)
        result.paraphrase_recalled += int(hit)
        result.recall_via_observed_tool_call += int(hit and calls >= 1 and with_hits >= 1)
        result.judge_rows.append({"question": fact.ask, "answer": answered(turn), "case": fact.key})
    stamp("paraphrase_recall", started)
    stages.append(
        f"paraphrase_recalled {result.paraphrase_recalled}/{len(horizon)} "
        f"via_tool_call {result.recall_via_observed_tool_call}/{len(horizon)}"
    )

    # STAGE 3: correct one fact, close, and the old value must be gone.
    started = clock()
    correction_conversation = "drill-correct-1"
    await fleet.say(url, correctable.correction, correction_conversation)
    review_of(await fleet.close_conversation(url, correction_conversation))
    turn = await ask(correctable.ask)
    result.correction_supersedes = _value_hit(answered(turn), correctable.new_value_tokens)
    result.stale_value_not_recalled = not any(
        stale.casefold() in _answer_tokens(answered(turn)) for stale in correctable.stale_tokens
    )
    result.judge_rows.append(
        {
            "question": correctable.ask,
            "answer": answered(turn),
            "case": f"{correctable.key}-corrected",
        }
    )
    stamp("correction", started)
    stages.append(
        f"correction_supersedes={result.correction_supersedes} "
        f"stale_value_not_recalled={result.stale_value_not_recalled} "
        f"authority_denied={result.review_authority_denied_on_close}"
    )

    # STAGE 4: restart the compute (a revision replace on the same image), then
    # recall everything with an EMPTY history: only the pod's own memory can answer.
    started = clock()
    url = await fleet.restart(hushh_id, url)
    info = await fleet.info(url)
    revision_after = str(info.get("revision") or "")
    image_after = str(info.get("imageTag") or "")
    result.restart_replaced_revision = bool(revision_before) and (
        revision_after != revision_before and image_after == image_before
    )
    for fact in horizon:
        turn = await ask(fact.ask)
        if recalled(turn, fact, after_correction=True):
            result.restart_without_history += 1
        result.judge_rows.append(
            {"question": fact.ask, "answer": answered(turn), "case": f"{fact.key}-after-restart"}
        )
    stamp("restart_recall", started)
    stages.append(
        f"restart_replaced_revision={result.restart_replaced_revision} "
        f"restart_without_history {result.restart_without_history}/{len(horizon)}"
    )

    # STAGE 5: teach one more, revoke it by id, restart (replay), and it must be gone.
    started = clock()
    before = set((await fleet.status(url)).get("factIds") or [])
    tombstones_before = int((await fleet.status(url)).get("tombstones") or 0)
    revoke_conversation = "drill-revoke-1"
    await fleet.say(url, f"Please remember this: {revocable.teach}", revoke_conversation)
    review_of(await fleet.close_conversation(url, revoke_conversation))
    after = set((await fleet.status(url)).get("factIds") or [])
    new_ids = sorted(after - before)
    if new_ids:
        await fleet.revoke(url, new_ids)
    url = await fleet.restart(hushh_id, url)
    turn = await ask(revocable.ask)
    calls, with_hits = _observed_recall(turn)
    result.revoked_fact_not_recalled_after_replay = bool(new_ids) and (
        _no_fact_shaped(answered(turn))
        and with_hits == 0
        and not _value_hit(answered(turn), revocable.value_tokens)
    )
    result.judge_rows.append(
        {"question": revocable.ask, "answer": answered(turn), "case": f"{revocable.key}-revoked"}
    )
    stamp("revoke_replay", started)
    stages.append(
        f"revoked {len(new_ids)} fact(s); "
        f"revoked_fact_not_recalled_after_replay={result.revoked_fact_not_recalled_after_replay}"
    )

    # STAGE 6: the negative control, and the closing status.
    started = clock()
    turn = await ask(absent_question)
    calls, with_hits = _observed_recall(turn)
    result.negative_control_clean = _no_fact_shaped(answered(turn)) and with_hits == 0
    result.judge_rows.append(
        {"question": absent_question, "answer": answered(turn), "case": "absent"}
    )
    status = await fleet.status(url)
    result.tombstones_increased = int(status.get("tombstones") or 0) > tombstones_before
    result.catch_up_debt_zero = int(status.get("unreviewed") or 0) == 0
    stamp("negative_and_status", started)
    stages.append(
        f"negative_control_clean={result.negative_control_clean} "
        f"tombstones_increased={result.tombstones_increased} "
        f"catch_up_debt_zero={result.catch_up_debt_zero}"
    )
    return result


def render_memory_report(result: MemoryDrillResult) -> str:
    lines = [
        "=" * 64,
        "MEMORY LEARNING DRILL  ::  teach -> close -> paraphrase -> correct -> restart -> revoke",
        "=" * 64,
        f"  verdict:               {'PASS' if result.passed else 'FAIL'}",
    ]
    for key, value in result.observations().items():
        lines.append(f"  {key:44} {value}")
    for name, ms in result.timings_ms.items():
        lines.append(f"  elapsed {name:36} {ms} ms")
    for stage in result.stages:
        lines.append(f"    - {stage}")
    lines.append("=" * 64)
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# The in-memory memory fleet: a simulated pod whose ONLY job is to make the
# learning orchestration testable, and to be breakable in each way the real
# thing could leak. ``leak`` names one of seven defects; each must FAIL the drill.
# --------------------------------------------------------------------------- #

MEMORY_LEAKS: tuple[str, ...] = (
    "ignores_corrections",
    "resurrects_revoked_on_replay",
    "answers_without_tool",
    "hallucinates_absent",
    "credits_fallback_as_provider",
    "reviews_on_other_provider",
    "never_reviews_on_close",
)


class _SimPod:
    """One simulated owner's memory: curated facts, tombstones, review debt."""

    def __init__(self) -> None:
        self.facts: list[dict[str, Any]] = []  # {id, key, text, tokens, dead}
        self.pending: dict[str, list[str]] = {}  # conversation -> raw sentences
        self.tombstones = 0
        self.revision = 1
        self.counter = 0

    def key_for(self, sentence: str) -> str:
        words = _answer_tokens(sentence)
        for fact in self.facts:
            if fact["key"] in words:
                return fact["key"]
        # A new subject: the first noun-like word that is not filler.
        for word in _TOKEN_RE.findall(sentence.casefold()):
            if word in {"my", "the", "a", "an", "i", "am", "is", "please", "remember", "this"}:
                continue
            if word in {"correction", "now", "not"}:
                continue
            return word
        return "fact"


class InMemoryMemoryFleet:
    """A fake fleet for the learning drill. Durable state survives ``restart``."""

    def __init__(self, *, leak: str | None = None) -> None:
        if leak is not None and leak not in MEMORY_LEAKS:
            raise ValueError(f"unknown leak {leak!r}")
        self._leak = leak
        self._pods: dict[str, _SimPod] = {}
        self._urls: dict[str, str] = {}
        self.last_history: list[Any] = []
        self.asks: list[dict[str, Any]] = []
        self.pkm_writes = 0

    def _pod(self, url: str) -> _SimPod:
        return self._pods[self._urls[url]]

    async def provision(self, hushh_id: str) -> str:
        self._pods.setdefault(hushh_id, _SimPod())
        url = f"https://one-pod-{hushh_id.lower()}.run.app"
        self._urls[url] = hushh_id
        return url

    async def info(self, pod_url: str) -> dict[str, Any]:
        pod = self._pod(pod_url)
        return {
            "memoryEnabled": True,
            "memoryJoin": {"write": True, "review": True, "tombstones": True, "schema": 2},
            "revision": f"one-pod-0000{pod.revision}",
            "imageTag": "dev-simulated",
        }

    async def say(self, pod_url: str, text: str, conversation_id: str) -> dict[str, Any]:
        pod = self._pod(pod_url)
        pod.pending.setdefault(conversation_id, []).append(text)
        return {"text": "Noted.", "provider": "sim", "memory": {"recalls": [], "written": 2}}

    async def close_conversation(self, pod_url: str, conversation_id: str) -> dict[str, Any]:
        pod = self._pod(pod_url)
        if self._leak == "never_reviews_on_close":
            return {"provider": "sim", "memory": {"review": {"outcome": "disabled"}}}
        sentences = pod.pending.pop(conversation_id, [])
        ops = 0
        for sentence in sentences:
            key = pod.key_for(sentence)
            existing = next((f for f in pod.facts if f["key"] == key and not f["dead"]), None)
            if existing is not None:
                if self._leak == "ignores_corrections":
                    continue
                existing["dead"] = True
                pod.tombstones += 1
            pod.counter += 1
            text = sentence.replace("Please remember this: ", "").replace("a correction: ", "")
            pod.facts.append({"id": f"mem-{pod.counter}", "key": key, "text": text, "dead": False})
            ops += 1
        provider = "other" if self._leak == "reviews_on_other_provider" else "sim"
        return {
            "provider": provider,
            "memory": {
                "review": {
                    "outcome": "applied" if ops else "nothing_to_save",
                    "reason": "close",
                    "provider": provider,
                },
                "written": ops,
            },
            "directives": [],
        }

    async def ask(
        self, pod_url: str, question: str, *, history: list[Any] | None = None
    ) -> dict[str, Any]:
        pod = self._pod(pod_url)
        self.last_history = list(history or [])
        self.asks.append({"question": question, "history": list(history or [])})
        words = _answer_tokens(question)
        match = next((f for f in pod.facts if f["key"] in words and not f["dead"]), None)
        recalls: list[dict[str, Any]] = []
        if match is not None:
            text = match["text"]
            if self._leak != "answers_without_tool":
                recalls = [{"queryChars": len(question), "hits": 1, "backend": "commit_log"}]
        elif self._leak == "hallucinates_absent":
            text = "I recall your parrot is named Kiwi."
            recalls = [{"queryChars": len(question), "hits": 0, "backend": "commit_log"}]
        else:
            text = NO_RECORDED_FACT
            recalls = [{"queryChars": len(question), "hits": 0, "backend": "commit_log"}]
        provider = {"consent": "absent", "generate": "no_bank", "recall": "no_bank"}
        if self._leak == "credits_fallback_as_provider":
            provider = {"consent": "absent", "generate": "completed", "recall": "completed"}
        return {
            "text": text,
            "provider": "sim",
            "memory": {"recalls": recalls, "written": 0, "provider": provider},
        }

    async def status(self, pod_url: str) -> dict[str, Any]:
        pod = self._pod(pod_url)
        live = [f for f in pod.facts if not f["dead"]]
        return {
            "schema": 2,
            "facts": len(live),
            "tombstones": pod.tombstones,
            "unreviewed": sum(len(v) for v in pod.pending.values()),
            "factIds": [f["id"] for f in reversed(live)],
        }

    async def revoke(self, pod_url: str, memory_ids: list[str]) -> dict[str, Any]:
        pod = self._pod(pod_url)
        revoked = 0
        for fact in pod.facts:
            if fact["id"] in memory_ids and not fact["dead"]:
                fact["dead"] = True
                pod.tombstones += 1
                revoked += 1
        return {"revoked": revoked, "tombstones": pod.tombstones}

    async def restart(self, hushh_id: str, pod_url: str) -> str:
        pod = self._pods[hushh_id]
        pod.revision += 1
        if self._leak == "resurrects_revoked_on_replay":
            for fact in pod.facts:
                fact["dead"] = False  # the replay brought everything back
        return pod_url


# --------------------------------------------------------------------------- #
# The existing-pod fleet: the owner's real pod, direct or through the hub.
# --------------------------------------------------------------------------- #


class ExistingPodFleet:
    """Drive an ALREADY PROVISIONED pod: the founder's owner pod or a dev pod.

    ``auth="direct"`` posts to the pod URL as an authorised invoker (operator ID
    token) with a ``pkm.read`` consent token, exactly as ``GcpFleet._turn`` does.
    ``auth="hub-proxy"`` posts to the hub relay with the owner's Firebase token,
    which is the only door a Puppy-relayed turn has today; the Puppy inference
    grant is minted through the hub's trusted-device route and carried per turn.

    ``restart`` replaces the revision in place on the SAME image by bumping a
    harmless env var through ``gcloud run services update`` and waits until
    ``/pod/info`` reports a new revision with the image tag unchanged. Nothing
    here provisions or deletes; nothing here holds a secret beyond the call.
    """

    def __init__(
        self,
        *,
        hushh_id: str,
        pod_url: str,
        auth: str = "direct",
        consent_token: str = "",
        hub_url: str = "",
        firebase_token: str = "",
        puppy_device_id: str = "",
        runtime_credential: str = "",
        runtime_credential_transport: str = "developer_api",
        vertex_project: str = "",
        vertex_location: str = "",
        service: str = "",
        project: str = "",
        region: str = "us-central1",
        timeout_seconds: float = 170.0,
    ) -> None:
        if auth not in {"direct", "hub-proxy"}:
            raise ValueError("auth must be 'direct' or 'hub-proxy'")
        if auth == "direct" and not consent_token:
            raise ValueError("direct auth needs --consent-token (a pkm.read grant for the owner)")
        if auth == "hub-proxy" and not (hub_url and firebase_token):
            raise ValueError("hub-proxy auth needs --hub-url and --firebase-token")
        self._hushh_id = hushh_id
        self._pod_url = pod_url.rstrip("/")
        self._auth = auth
        self._consent_token = consent_token
        self._hub_url = hub_url.rstrip("/")
        self._firebase_token = firebase_token
        self._puppy_device_id = puppy_device_id
        self._puppy_grant = ""
        self._runtime_credential = runtime_credential
        self._runtime_credential_transport = runtime_credential_transport
        self._vertex_project = vertex_project
        self._vertex_location = vertex_location
        self._service = service
        self._project = project
        self._region = region
        self._timeout = timeout_seconds
        self.last_history: list[Any] = []

    # -- transport ----------------------------------------------------------------

    def _direct_headers(self) -> dict[str, str]:
        from hushh_mcp.services.operator_identity import mint_operator_id_token  # noqa: PLC0415

        return {
            "Authorization": f"Bearer {mint_operator_id_token(self._pod_url)}",
            "X-Consent-Token": self._consent_token,
            "Content-Type": "application/json",
        }

    def _hub_headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._firebase_token}",
            "Content-Type": "application/json",
        }

    def _request(self, method: str, path_direct: str, path_hub: str, body: Any = None) -> Any:
        import requests  # noqa: PLC0415

        if self._auth == "direct":
            url, headers = f"{self._pod_url}{path_direct}", self._direct_headers()
        else:
            url, headers = f"{self._hub_url}{path_hub}", self._hub_headers()
        response = requests.request(
            method, url, json=body, headers=headers, timeout=self._timeout, allow_redirects=False
        )
        if response.status_code != 200:
            # Provider bodies can contain owner information; retain only the status.
            raise RuntimeError(f"{method} {path_direct} HTTP {response.status_code}")
        return response.json() or {}

    def _runtime_fields(self) -> dict[str, Any]:
        fields: dict[str, Any] = {}
        if self._puppy_device_id:
            fields["runtimeProvider"] = "puppy"
            fields["puppyDeviceId"] = self._puppy_device_id
            fields["runtimeCredential"] = self._puppy_grant_token()
        elif self._runtime_credential:
            fields["runtimeCredential"] = self._runtime_credential
            fields["runtimeCredentialTransport"] = self._runtime_credential_transport
            if self._vertex_project:
                fields["vertexProject"] = self._vertex_project
            if self._vertex_location:
                fields["vertexLocation"] = self._vertex_location
        return fields

    def _puppy_grant_token(self) -> str:
        """The owner-revocable Puppy inference grant, minted through the hub once."""
        if self._puppy_grant:
            return self._puppy_grant
        if not (self._hub_url and self._firebase_token):
            raise RuntimeError(
                "a Puppy turn needs --hub-url and --firebase-token to mint its grant"
            )
        import requests  # noqa: PLC0415

        response = requests.post(
            f"{self._hub_url}/api/account/trusted-devices/{self._puppy_device_id}/puppy-inference-grant",
            headers=self._hub_headers(),
            timeout=30,
            allow_redirects=False,
        )
        if response.status_code != 200:
            raise RuntimeError(f"puppy grant HTTP {response.status_code}")
        self._puppy_grant = str((response.json() or {}).get("token") or "")
        if not self._puppy_grant:
            raise RuntimeError("puppy grant carried no token")
        return self._puppy_grant

    def _turn(self, message: str, conversation_id: str, history: list[Any]) -> dict[str, Any]:
        body = {
            "message": message,
            "conversationId": conversation_id,
            "history": list(history),
            **self._runtime_fields(),
        }
        return self._request("POST", "/api/one/pod/turn", f"/api/one/u/{self._hushh_id}/turn", body)

    # -- the fleet seam -----------------------------------------------------------

    async def provision(self, hushh_id: str) -> str:
        if hushh_id != self._hushh_id:
            raise RuntimeError("the existing-pod fleet serves exactly one owner")
        return self._pod_url

    async def info(self, pod_url: str) -> dict[str, Any]:
        payload = await asyncio.to_thread(
            self._request, "GET", "/pod/info", f"/api/one/u/{self._hushh_id}/info"
        )
        return dict(payload.get("pod") or payload)

    async def say(self, pod_url: str, text: str, conversation_id: str) -> dict[str, Any]:
        return await asyncio.to_thread(self._turn, text, conversation_id, [])

    async def ask(
        self, pod_url: str, question: str, *, history: list[Any] | None = None
    ) -> dict[str, Any]:
        self.last_history = list(history or [])
        return await asyncio.to_thread(
            self._turn, question, f"drill-ask-{secrets.token_hex(3)}", list(history or [])
        )

    async def close_conversation(self, pod_url: str, conversation_id: str) -> dict[str, Any]:
        return await asyncio.to_thread(
            self._request,
            "POST",
            f"/api/one/pod/conversation/{conversation_id}/close",
            f"/api/one/u/{self._hushh_id}/conversation/{conversation_id}/close",
            self._runtime_fields(),
        )

    async def status(self, pod_url: str) -> dict[str, Any]:
        payload = await asyncio.to_thread(
            self._request,
            "GET",
            "/api/one/pod/memory/status",
            f"/api/one/u/{self._hushh_id}/memory/status",
        )
        return dict(payload.get("memory") or payload)

    async def revoke(self, pod_url: str, memory_ids: list[str]) -> dict[str, Any]:
        return await asyncio.to_thread(
            self._request,
            "POST",
            "/api/one/pod/memory/revoke",
            f"/api/one/u/{self._hushh_id}/memory/revoke",
            {"memoryIds": list(memory_ids), "reasonCode": "drill"},
        )

    async def restart(self, hushh_id: str, pod_url: str) -> str:
        if not (self._service and self._project):
            raise RuntimeError("restart needs --service and --project for the revision replace")
        before = str((await self.info(pod_url)).get("revision") or "")
        epoch = str(int(time.time()))
        await asyncio.to_thread(
            subprocess.run,  # noqa: S603 - fixed argv, operator-supplied identifiers only
            [
                "gcloud",
                "run",
                "services",
                "update",
                self._service,
                "--project",
                self._project,
                "--region",
                self._region,
                "--update-env-vars",
                f"HUSSH_DRILL_EPOCH={epoch}",
                "--quiet",
            ],
            check=True,
            capture_output=True,
        )
        for _ in range(60):
            await asyncio.sleep(5)
            try:
                after = await self.info(pod_url)
            except Exception:  # noqa: BLE001 - the new revision is still coming up
                continue
            if str(after.get("revision") or "") not in {"", before}:
                return pod_url
        raise RuntimeError("the pod never reported a new revision after the replace")


# --------------------------------------------------------------------------- #
# The judge queue: answers graded in a SEPARATE session under the puppy-one-
# harness contract. Four negative and two positive controls, seeded shuffle,
# salted commitments, the seal OUTSIDE the run directory. The queue carries
# questions and answers only: no owner id, no pod id, no memory id, no prompt.
# The other half of the contract -- recording verdicts and scoring or voiding
# the run -- lives in ``scripts/ops/memory_judge.py``.
# --------------------------------------------------------------------------- #

MEMORY_JUDGE_RULES: tuple[str, ...] = (
    "wrong-value",
    "stale-value",
    "revoked-leak",
    "invented",
    "omission",
)

# The grading half (``scripts/ops/memory_judge.py``) owns these names. They are
# repeated here, and only here, because issuing a run has to retire whatever a
# previous issue into the same directory left behind.
JUDGE_SEAL_SUFFIX = ".seal.json"
JUDGE_SUPERSEDED_SUFFIX = ".superseded"
JUDGE_INCOMING_SUFFIX = ".incoming"
JUDGE_QUEUE_FILENAME = "review-queue.jsonl"
JUDGE_MANIFEST_FILENAME = "run-manifest.json"
JUDGE_VERDICTS_FILENAME = "verdicts.jsonl"
# Every artifact a previous issue into this directory owns. The queue and the
# manifest are in the list because retiring them is what makes issuing
# reversible: a fresh issue never overwrites a live file, it renames the old one
# aside and moves a staged one into the freed name, so a failure part way
# through can put every one of them back.
JUDGE_RUN_ARTIFACTS: tuple[str, ...] = (
    JUDGE_QUEUE_FILENAME,
    JUDGE_MANIFEST_FILENAME,
    JUDGE_VERDICTS_FILENAME,
    "verdict-writes.jsonl",
)

# How this run's shuffle seed was obtained. It is sealed, never published, and
# ingest reports which of the two a run was issued under, because they are not
# the same claim: one run's planted positions are unpredictable, the other's are
# whatever the last run issued with that seed had.
JUDGE_SEED_MINTED = "minted-at-issue"
JUDGE_SEED_SUPPLIED = "operator-supplied"

# The four manifest fields that ATTRIBUTE a run: what was graded, under which
# name, when, and by which answering model. Nothing else in the run directory
# binds them, and the whole output of this harness is a number attributed to a
# model, so they are sealed and ``memory_judge`` voids a run whose manifest no
# longer matches the seal. ``rows``, ``hashes`` and ``controls_commitment`` are
# already covered by the row hashes and the control commitment; these were not
# covered by anything.
JUDGE_IDENTITY_FIELDS: tuple[str, ...] = ("suite", "run_id", "created_at", "answerer_model")


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def judge_identity_commitment(manifest: dict[str, Any], salt: str) -> str:
    """Salted commitment to the manifest fields that name and attribute the run.

    ``memory_judge.identity_commitment`` recomputes this at ingest from the
    manifest on disk. The two are deliberately the same three lines in two
    files rather than an import: the scoring half loads no module from the
    harness, and a disagreement between them voids every run loudly instead of
    passing one quietly.
    """
    fields = {field: str(manifest.get(field, "")) for field in JUDGE_IDENTITY_FIELDS}
    return _sha(salt + json.dumps(fields, sort_keys=True))


def memory_judge_controls(horizon: list[MemoryFact] = MEMORY_HORIZON) -> list[dict[str, str]]:
    """Planted rows: structurally valid, each breaking exactly one rule, plus two
    plain correct rows the judge must NOT flag."""
    correctable = next(f for f in horizon if f.correction)
    plain = [f for f in horizon if not f.correction][:2]
    return [
        {
            "question": plain[0].ask,
            "answer": "Your dachshund is named Barnaby.",
            "kind": "negative",
            "rule": "wrong-value",
        },
        {
            "question": correctable.ask,
            "answer": "Your sailboat Zephyr berths at slip twelve.",
            "kind": "negative",
            "rule": "stale-value",
        },
        {
            "question": REVOCABLE_FACT.ask,
            "answer": "Your ring holds an opal stone.",
            "kind": "negative",
            "rule": "revoked-leak",
        },
        {
            "question": ABSENT_MEMORY_QUESTION,
            "answer": "Your parrot is named Kiwi.",
            "kind": "negative",
            "rule": "invented",
        },
        {
            "question": plain[0].ask,
            "answer": "Your dachshund is named Pushkin.",
            "kind": "positive",
            "rule": "",
        },
        {
            "question": plain[1].ask,
            "answer": "You are allergic to almonds.",
            "kind": "positive",
            "rule": "",
        },
    ]


def _retire_judge_artifact(path: Path) -> Path:
    """Move one artifact out of the live set without destroying it."""
    target = path.with_name(path.name + JUDGE_SUPERSEDED_SUFFIX)
    counter = 2
    while target.exists():
        target = path.with_name(f"{path.name}{JUDGE_SUPERSEDED_SUFFIX}.{counter}")
        counter += 1
    path.rename(target)
    return target


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def previous_issue_seals(run_dir: Path, seal_root: Path) -> list[Path]:
    """Every live seal in ``seal_root`` that was issued for THIS run directory.

    Only this run's seals. Seals share a directory by default, and an issue that
    swept it would quietly destroy the tamper detection of every other run in
    the fleet. A file this issue cannot parse is another run's business.
    """
    if not seal_root.is_dir():
        return []
    run_dir_sha = _sha(run_dir.resolve().as_posix())
    found: list[Path] = []
    for candidate in sorted(seal_root.glob(f"*{JUDGE_SEAL_SUFFIX}")):
        try:
            loaded = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(loaded, dict) and str(loaded.get("run_dir_sha256") or "") == run_dir_sha:
            found.append(candidate)
    return found


def count_recorded_verdicts(run_dir: Path) -> int:
    """How many verdicts the previous issue had already collected.

    The larger of the verdicts file and the write ledger that counts them, so
    deleting one of the two before re-issuing does not reset the count to zero.
    A party that deletes both defeats it, exactly as it defeats every other
    control in this harness; what this buys is that the cheap version of the
    move does not work.
    """
    counts = [0]
    for name in (JUDGE_VERDICTS_FILENAME, "verdict-writes.jsonl"):
        try:
            text = (run_dir / name).read_text(encoding="utf-8")
        except OSError:
            continue
        counts.append(sum(1 for line in text.splitlines() if line.strip()))
    return max(counts)


def issue_counter(run_dir: Path, seal_root: Path) -> dict[str, int]:
    """The re-issue record the NEW seal will carry, read before anything moves.

    Superseding made re-running the drill into the same directory survivable,
    and in doing so it deleted the only trace that it had happened: the count
    went into the operator's receipt, which the score report never sees. A
    grading session that fails a planted control could then re-issue and be
    scored clean, which is strictly worse than the void it replaced.

    So the fact is written where ingest can read it and the grader cannot
    quietly drop it: into the seal, outside the run directory. Two numbers,
    because the two events are not the same:

    ``ordinal``
        Which issue this is. A re-issue before anything was graded is an
        ordinary operator action. It is reported, not punished.
    ``discarded_verdicts_total``
        Verdicts that existed and were set aside. That is the serious one, and
        it voids at ingest. It accumulates across issues on purpose: carrying
        only this issue's count would let a grader launder a bad run by issuing
        twice, the second time over an empty directory.

    Both are read from the seal being retired, so the counter survives the
    supersession that is about to move it.
    """
    seals = previous_issue_seals(run_dir, seal_root)
    ordinal = 0
    carried = 0
    for seal in seals:
        try:
            loaded = json.loads(seal.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        record = loaded.get("issue") if isinstance(loaded.get("issue"), dict) else {}
        # ``max`` over the candidates: with two seals claiming the directory the
        # run is void anyway, and the higher counter is the safe reading.
        ordinal = max(ordinal, _as_int(record.get("ordinal"), 1))
        carried = max(carried, _as_int(record.get("discarded_verdicts_total"), 0))
    discarded = count_recorded_verdicts(run_dir)
    stale = [name for name in JUDGE_RUN_ARTIFACTS if (run_dir / name).exists()]
    return {
        "ordinal": ordinal + 1,
        "superseded_artifacts": len(stale) + len(seals),
        "discarded_verdicts": discarded,
        "discarded_verdicts_total": carried + discarded,
    }


def supersede_previous_issue(
    run_dir: Path, seal_root: Path, *, journal: list[tuple[Path, Path]] | None = None
) -> int:
    """Retire what a previous issue into this directory left behind.

    Re-running the drill into the same queue directory is an ordinary operator
    action, and it has to be distinguishable from an attack. A fresh issue
    rewrites the queue and the manifest, which is what tells the two apart: the
    previous seal's salted row hashes no longer describe anything on disk, and
    the previous run's verdicts were given on rows that no longer exist.

    Left in place, both are traps. Two seals claim the run, so ingest voids for
    ``ambiguous_seal``, and the stale seal it may open disagrees with the fresh
    manifest, so it also voids for ``controls_altered`` -- an accusation of
    tampering against an operator who only ran the drill twice. The only way out
    was to delete a seal by hand, which is exactly the act the control exists to
    detect.

    So issuing supersedes, and it is issuing that does it rather than ingest.
    Ingest must never choose between two answer keys: a grader that edits the
    queue and plants a seal matching the edit would otherwise be scored, with
    the real seal set aside as superseded. Retiring happens at ISSUE time, by
    the party that owns the seal directory, before a grading session exists, and
    it leaves exactly one live seal, so ingest's rule stays "exactly one, or
    void". Nothing is deleted: each stale artifact is renamed out of the live
    set, so the previous run stays on disk and no operator ever has to remove a
    seal. That it happened is recorded in the new seal by ``issue_counter``, so
    the score report says so rather than only the operator's receipt.

    ``journal`` collects every ``(original, retired)`` pair so the caller can
    put them back. Retiring is the first destructive step of issuing, and
    without the journal a failure after it left a directory with no seal at all,
    which ingest reports in the vocabulary of tampering.

    Returns the number of artifacts retired.
    """
    retired = 0
    for name in JUDGE_RUN_ARTIFACTS:
        stale = run_dir / name
        if stale.exists():
            moved = _retire_judge_artifact(stale)
            if journal is not None:
                journal.append((stale, moved))
            retired += 1
    for candidate in previous_issue_seals(run_dir, seal_root):
        moved = _retire_judge_artifact(candidate)
        if journal is not None:
            journal.append((candidate, moved))
        retired += 1
    return retired


def _roll_back_issue(
    placed: list[Path], journal: list[tuple[Path, Path]], staged: list[Path]
) -> list[str]:
    """Undo a half-committed issue. Returns what could NOT be put back.

    Reverse order: drop what was already moved into place, put every retired
    artifact back under its original name, then clear the staging files. It
    never raises -- a rollback that raised would replace the real failure with
    its own, and the original is the one worth seeing -- but it does not
    swallow a failure either, because a directory that is neither the new run
    nor the old one is the one outcome this whole dance exists to prevent.
    """
    unrestored: list[str] = []
    for path in placed:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            unrestored.append(str(path))
    for original, moved in reversed(journal):
        try:
            # A plain rename, deliberately not the call that just failed.
            moved.rename(original)
        except OSError:
            unrestored.append(str(original))
    for temporary in staged:
        with contextlib.suppress(OSError):
            temporary.unlink(missing_ok=True)
    return unrestored


def write_judge_queue(
    rows: list[dict[str, str]],
    *,
    run_dir: Path,
    seed: int | None = None,
    seal_dir: Path | None = None,
    controls: list[dict[str, str]] | None = None,
    harness_path: Path | None = None,
    judge_path: Path | None = None,
    run_id: str | None = None,
    created_at: str | None = None,
    answerer_model: str = "unknown",
) -> dict[str, Any]:
    """Write ``review-queue.jsonl`` and ``run-manifest.json``; seal outside ``run_dir``.

    ``run_id``, ``created_at`` and ``answerer_model`` are recorded because the
    grading half (``memory_judge.py``) cannot do its job without them: a run
    needs a name to be reported under, and an accuracy with no answering model
    beside it is a number that cannot be compared to anything. ``created_at`` is
    stamped here, at ISSUE time, and only here. Scoring reads it back and never
    calls a clock of its own, so re-ingesting a run always produces the same
    report.

    The run id is deliberately NOT the seal's filename. The seal holds the
    plaintext control map -- which rows are planted and which rule each breaks
    -- so any field in the manifest that names the seal hands a grader holding
    only the manifest the answer key it is being measured against. The filename
    stays a salted hash of the run directory, which nothing the grader is given
    can derive; ingest finds it by opening the candidates and asking each which
    run it was issued for.

    The SHUFFLE SEED is MINTED HERE when the caller supplies none, and it is
    sealed rather than published. Both halves are load-bearing, and each was
    once missing:

    *   *Minted*, because ``--seed`` defaulted to a constant date literal, so
        every run on the path production takes drew the SAME permutation over
        the same fixed corpus. Positions that never move are not blinding: one
        run seen, or one colleague's description of one, named every planted
        row in every later run, at no cost and with nothing to detect.
    *   *Sealed*, because the seed is not a neutral reproducibility field. The
        controls are appended to the rows in a fixed order, so replaying
        ``random.Random(seed).shuffle`` over the manifest's own ``rows`` and
        ``controls`` counts recovers every planted position and its kind from
        the manifest alone. It is the control map in compressed form, so it
        lives where the control map lives and nowhere a grader is handed --
        not the manifest, and not the receipt (see ``_receipt_commands``).

    A seed supplied by the caller is a deliberate REPLAY, not a blinded run:
    its positions are exactly those of every other run issued with that seed.
    That is a legitimate operator action -- reproducing an issue needs it -- so
    it is recorded (``seed_source`` in the seal, ``positions_blinded`` in the
    returned summary) and reported by ingest, rather than refused or, worse,
    counted as blind.

    Minting draws on the OS CSPRNG, which no replayable path may do. Issuing is
    not one: it already draws ``salt`` from the same source and stamps
    ``created_at`` from a clock. SCORING is the path that must replay
    identically, and it never touches the seed at all -- it reads the control
    map out of the seal -- so re-ingesting a run stays byte-identical.

    The honest limit, and minting does not move it: ``memory_judge_controls``
    above holds the six planted rows as literals over a FIXED corpus, so their
    wording is identical in every run. A grader that reads this file, or that
    has graded this corpus before, recognises the planted rows wherever the
    shuffle puts them. Minting closed the shortcut that needed neither -- the
    predictable permutation -- and closed nothing else. Content-level blinding
    needs a corpus minted per run, which this harness does not have; until it
    does, blinding rests on the grader being new to the corpus and not reading
    the harness, which is a discipline, not a control. What the seal buys is
    that scoring can tell, afterwards, that the evidence and the rules were not
    changed.

    Issuing SUPERSEDES a previous issue into the same directory: the stale seal,
    the queue and manifest it described, and the verdicts given on those rows
    are renamed out of the live set, never deleted. See
    ``supersede_previous_issue`` for why that belongs here and not in ingest,
    and ``issue_counter`` for the trace it leaves in the new seal.

    ISSUING IS ALL OR NOTHING
    -------------------------
    Retiring used to run FIRST, before the new queue, manifest and seal existed
    anywhere. A failure in the gap -- an unreadable harness file, a full disk, a
    revoked write on the seal directory, an interrupt -- left a run directory
    with its seal renamed away and no replacement, which ingest reports as
    ``no_seal``: "an unsealed run is one where tampering is undetectable by
    construction". The operator's own crash therefore came back wearing the
    vocabulary of an attack.

    So the write happens in two phases. Everything is computed and STAGED to
    ``.incoming`` files first, while nothing live has moved; only then is the
    previous issue retired and each staged file renamed into the freed name.
    Any failure in the second phase is rolled back from the journal: the placed
    files are removed and every retired artifact is renamed back. The directory
    ends with exactly one live seal matching one queue, or exactly as it was.

    The honest limit: a kill that runs no handler (``SIGKILL``, power loss) can
    still stop between two renames, and no amount of ordering fixes that here.
    What it leaves is recoverable by hand, because nothing was deleted and the
    retired names say what they are. A real transaction needs a filesystem that
    offers one.
    """
    import random  # noqa: PLC0415

    run_dir = Path(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    default_seal_root = run_dir.parent / ".judge-seals"
    seal_root = Path(seal_dir) if seal_dir is not None else default_seal_root
    if seal_root.resolve() == run_dir.resolve() or run_dir.resolve() in seal_root.resolve().parents:
        raise ValueError("the seal must live outside the run directory")
    seal_root.mkdir(parents=True, exist_ok=True)
    # Whether a party holding only the RECEIPT can name the seal directory. The
    # receipt carries the queue path, so it carries the run directory, so the
    # default `<run_dir>/../.judge-seals` needs no derivation at all: one `..`
    # and a listing, and `run_dir_sha256` on each seal says which is this run's.
    # Outside the run directory is therefore not the same property as out of
    # the grader's reach, and the receipt used to assert the first while being
    # read as the second.
    resolved_seal = seal_root.resolve()
    resolved_parent = run_dir.resolve().parent
    seal_location_derivable = (
        resolved_seal == default_seal_root.resolve()
        or resolved_seal == resolved_parent
        or resolved_parent in resolved_seal.parents
    )
    if seal_location_derivable:
        print(
            "warning: the seal sits where this run's receipt points. A grading session "
            "holding the receipt can list it and find this run's seal by its "
            "run_dir_sha256. Pass --judge-seal-dir outside the run directory's parent "
            "for a location the grader was never told.",
            file=sys.stderr,
        )
    planted = list(controls if controls is not None else memory_judge_controls())
    entries: list[dict[str, Any]] = [
        {"utterance": r["question"], "output": r["answer"], "planted": ""} for r in rows
    ] + [
        {"utterance": c["question"], "output": c["answer"], "planted": c["kind"], "rule": c["rule"]}
        for c in planted
    ]
    # Mint unless the caller asked for a specific permutation. See the
    # docstring: a constant default made every production run's planted
    # positions identical, and a supplied seed is a replay that says so.
    replayed = seed is not None
    seed = secrets.randbits(64) if seed is None else int(seed)
    seed_source = JUDGE_SEED_SUPPLIED if replayed else JUDGE_SEED_MINTED
    # The permutation is reproducible FROM THE SEED, which is the seal's
    # business and nobody else's. The controls are appended to ``rows`` in a
    # fixed order, so ``random.Random(seed).shuffle(list(range(n)))`` replayed
    # against the manifest's own ``rows`` and ``controls`` counts names every
    # planted position and its negative/positive kind exactly -- no seal, no
    # harness source, nothing but a Python interpreter. So the seed is sealed
    # with the answer key it is equivalent to, and ``manifest`` below carries
    # no seed.
    random.Random(seed).shuffle(entries)  # noqa: S311
    salt = secrets.token_hex(16)
    queue_lines: list[str] = []
    hashes: dict[str, str] = {}
    sealed_rows: dict[str, str] = {}
    control_map: dict[str, dict[str, str]] = {}
    for index, entry in enumerate(entries, start=1):
        row_id = f"m{index:03d}"
        row = {"id": row_id, "utterance": entry["utterance"], "output": entry["output"]}
        line = json.dumps(row, sort_keys=True)
        queue_lines.append(line)
        hashes[row_id] = _sha(line)
        sealed_rows[row_id] = _sha(salt + line)
        if entry["planted"]:
            control_map[row_id] = {"kind": entry["planted"], "rule": entry.get("rule", "")}
    controls_commitment = _sha(salt + ",".join(sorted(control_map)))
    harness = Path(harness_path) if harness_path is not None else Path(__file__).resolve()
    # Read before anything on disk moves. This used to run after the previous
    # issue had been retired, so an unreadable harness left the directory with
    # no seal at all.
    harness_sha = _sha(harness.read_text(encoding="utf-8"))
    # The scoring module is sealed too. Sealing only this file would answer the
    # wrong row of the contract's threat table: "Edit judge.py -- defeats the
    # rules, the controls, the void logic", and all three of those live there.
    judge = (
        Path(judge_path)
        if judge_path is not None
        else Path(__file__).resolve().parent / "memory_judge.py"
    )
    try:
        judge_sha = _sha(judge.read_text(encoding="utf-8"))
    except OSError:
        # Never crash the drill over the grading half: this runs after every
        # live call against a real pod, and losing that work to a missing
        # sibling file would be a worse outcome than an unscoreable run. The
        # sentinel is deliberately one ingest can never compute, so the run
        # voids loudly at scoring instead of passing on a matching "missing".
        judge_sha = "<unreadable at issue>"
    # Domain-separated from the seal's filename below, and not merely a
    # different slice of the same digest. Both are salted hashes of this run
    # directory, so without the prefixes an unsupplied run id comes out byte
    # for byte equal to the seal's name -- which is the whole hole, restored by
    # the default path that production actually takes.
    identifier = (
        str(run_id) if run_id else _sha("run-id\x00" + run_dir.resolve().as_posix() + salt)[:16]
    )
    issued_at = str(created_at) if created_at else datetime.now(timezone.utc).isoformat()
    manifest = {
        "suite": "memory_learning",
        "run_id": identifier,
        "created_at": issued_at,
        "answerer_model": str(answerer_model or "unknown"),
        # No ``seed`` here, deliberately, and ``memory_judge.MANIFEST_FORBIDDEN_KEYS``
        # voids a run whose manifest carries one rather than trusting this line
        # to stay written. Nothing ever read it back; what it did was hand any
        # holder of this file the planted positions. It lives in the seal.
        #
        # ``rules`` is why the manifest is readable by the grader's own tool at
        # all: ``memory_judge.record`` reads the vocabulary from here to reject
        # an improvised rule at write time, and the vocabulary differs per
        # suite. That is the legitimate reason this file is not secret, and it
        # is the reason the seed had to leave rather than the file being locked.
        "rules": list(MEMORY_JUDGE_RULES),
        "rows": len(entries),
        "controls": {"negative": 4, "positive": 2},
        "controls_commitment": controls_commitment,
        "hashes": hashes,
        "harness_sha256": harness_sha,
        "grading": "separate session; verdicts.jsonl per the puppy-one-harness judging contract",
    }
    # What a previous issue into this directory left, read while it is all still
    # in place. The counter goes into the seal, which is the only record of the
    # re-issue that ingest reads and the grader is not handed.
    counter = issue_counter(run_dir, seal_root)
    # Salted, so it is not derivable from the run directory, the manifest, the
    # receipt or the run id. Ingest locates it by its `run_dir_sha256`, which
    # costs a directory listing the grader is not given.
    seal_name = _sha("seal-name\x00" + run_dir.resolve().as_posix() + salt)[:16]
    seal_path = seal_root / f"{seal_name}{JUDGE_SEAL_SUFFIX}"
    seal_body = json.dumps(
        {
            "run_id": identifier,
            "run_dir_sha256": _sha(run_dir.resolve().as_posix()),
            "salt": salt,
            "rows": sealed_rows,
            "controls": control_map,
            # The shuffle seed belongs here and nowhere in the run directory.
            # It is not metadata about the run, it IS the control map in
            # compressed form: replaying the permutation over the manifest's
            # row and control counts reproduces ``control_map``'s keys and
            # kinds exactly. Kept so an operator can still reproduce an issue,
            # sealed because a grader holding it holds the answer.
            "seed": int(seed),
            # Whether that seed was minted here or asked for. A run issued
            # with a supplied seed has the planted positions of every other
            # run issued with it, so ingest reports it as a replay instead of
            # reporting blinding the run did not have. Sealed rather than put
            # in the manifest because it is a statement ABOUT the seed, and a
            # grader who can edit it can relabel a replay as a blinded run.
            "seed_source": seed_source,
            "harness_sha256": harness_sha,
            "judge_sha256": judge_sha,
            # The attribution. ``suite``, ``run_id``, ``created_at`` and
            # ``answerer_model`` live in the manifest, which the grader may
            # read and can edit, and ingest publishes all four as fact beside
            # the accuracy. Nothing bound them: forging the answering model
            # produced a clean, non-void report crediting the wrong model with
            # the number, which is the entire output of this harness.
            "identity_sha256": judge_identity_commitment(manifest, salt),
            # The rule vocabulary is sealed too. Without this commitment a
            # grader could widen the manifest's rule list and cite whatever
            # it liked, and "an unknown rule voids the run" would enforce
            # nothing at all.
            "rules_sha256": _sha(salt + ",".join(MEMORY_JUDGE_RULES)),
            # There is deliberately no ``verdict_chain`` here. The seal is
            # written at ISSUE time, so any chain in it would be the empty list
            # forever while the real chain accumulates in ``verdicts.jsonl``
            # beside the write ledger. It was an empty field the judging
            # contract cited as one of the four things the seal commits to.
            # Which issue into this directory produced this run, and how many
            # verdicts a re-issue set aside. Ingest reports the first and voids
            # on the second.
            "issue": counter,
        },
        indent=2,
    )

    # Phase one: stage. Nothing live has moved, so a failure here needs no
    # journal -- deleting the staged files is the whole undo.
    staged: list[tuple[Path, Path]] = [
        (
            run_dir / f".{JUDGE_QUEUE_FILENAME}{JUDGE_INCOMING_SUFFIX}",
            run_dir / JUDGE_QUEUE_FILENAME,
        ),
        (
            run_dir / f".{JUDGE_MANIFEST_FILENAME}{JUDGE_INCOMING_SUFFIX}",
            run_dir / JUDGE_MANIFEST_FILENAME,
        ),
        # The staged seal deliberately does not end in ``.seal.json``: while it
        # is in flight it must not answer the glob that both this module and
        # ingest use to find live seals, or a crash mid-issue would leave a
        # second candidate and void the next run for ambiguity.
        (seal_root / f".{seal_path.name}{JUDGE_INCOMING_SUFFIX}", seal_path),
    ]
    bodies = ["\n".join(queue_lines) + "\n", json.dumps(manifest, indent=2), seal_body]
    journal: list[tuple[Path, Path]] = []
    placed: list[Path] = []
    try:
        for (temporary, _final), body in zip(staged, bodies, strict=True):
            temporary.write_text(body, encoding="utf-8")
        # Phase two: commit. Retire first so every destination name is free,
        # then move each staged file into place.
        superseded = supersede_previous_issue(run_dir, seal_root, journal=journal)
        for temporary, final in staged:
            os.replace(temporary, final)
            placed.append(final)
    except BaseException:
        unrestored = _roll_back_issue(placed, journal, [pair[0] for pair in staged])
        if unrestored:
            # A rollback that itself failed is the one state worse than the
            # original error, and it must not be silent: the operator is the
            # only party who can put these back, and ingest would otherwise
            # report the leftovers as tampering.
            print(
                "issue failed AND the rollback could not restore "
                + ", ".join(unrestored)
                + "; this run directory is not scoreable until they are back",
                file=sys.stderr,
            )
        raise
    return {
        "run_id": identifier,
        "created_at": issued_at,
        "answerer_model": str(answerer_model or "unknown"),
        "rows": len(entries),
        "negative_controls": sum(1 for c in control_map.values() if c["kind"] == "negative"),
        "positive_controls": sum(1 for c in control_map.values() if c["kind"] == "positive"),
        "queue": str(run_dir / JUDGE_QUEUE_FILENAME),
        "manifest": str(run_dir / JUDGE_MANIFEST_FILENAME),
        # A count, never the names: the receipt is an artifact a grading session
        # can read, and a retired seal's filename is one rename away from the
        # live one.
        "superseded_artifacts": superseded,
        # Whether this run's planted positions are unpredictable, which is
        # false exactly when a seed was supplied. The seed itself is NOT here:
        # this summary is copied into the receipt, which a grading session may
        # read, and the seed IS the planted positions.
        "positions_blinded": not replayed,
        "issue_ordinal": counter["ordinal"],
        # Verdicts a re-issue set aside. Here for the operator, who can still
        # act on it; the binding copy is in the seal, because a number only the
        # operator sees is one a grading session can re-issue its way past.
        "verdicts_discarded_by_reissue": counter["discarded_verdicts_total"],
        # The seal's FILENAME is deliberately absent, and nothing here is the
        # salt it is derived from.
        #
        # What was here before was ``seal_outside_run_dir: True``, a constant.
        # It was true and it was useless: outside the run directory is one `..`
        # from the queue path this same summary publishes, so on the default
        # path a grader holding the receipt lists that directory and picks out
        # its own seal by the run-directory hash each one carries, exactly as
        # ingest does. A field that is True on every run distinguishes nothing,
        # and this one read as "the grader cannot reach the seal" while being
        # only "the seal is not in the run directory".
        #
        # This says the thing the reader actually needs: False only when the
        # seal was put somewhere this receipt does not point. Past that, what
        # the seal buys is detection, not prevention.
        "seal_location_derivable_from_receipt": seal_location_derivable,
    }


def memory_grading_instructions(run_dir: str, seal_dir: str | None = None) -> tuple[str, str]:
    """The two commands that turn a sealed queue into a score, kept apart.

    They are two blocks because they are for two parties. The first states what
    the SEPARATE grading session is asked for and names only the run directory;
    the grading lane is read-only, so the replay in it is run by this session
    over what the grader returned, not by the grader. The second is for the
    session that issued the run, and it is the only one that may carry
    ``--seal-dir``: the seal names every planted row and the rule it breaks, so
    a grader given that path is a grader holding the answer key.

    Omitting ``--seal-dir`` from the scoring command was not a harmless typo. A
    run issued with a custom seal directory scores ``no_seal``, which the
    contract calls the loudest possible finding, on a run whose seal is intact
    and whose grader did nothing wrong.
    """
    grade = (
        "grade every row in a SEPARATE session, one at a time. A `wrong` names one of "
        f"{', '.join(MEMORY_JUDGE_RULES)} and quotes the offending value verbatim from "
        "that row's output, or the utterance span that went unrecorded when the failure "
        "is an omission. If you cannot quote it, the verdict is `unsure`: a `wrong` that "
        "quotes nothing is discarded, which leaves the row ungraded and voids the run.\n"
        "The grading lane is read-only and does not write. It returns one JSON object "
        "per row and THIS session replays the set through the same validated writer, "
        "which stops at the first refused row and names it:\n"
        '  {"id":"<row id>","verdict":"correct|wrong|unsure","rule":"<rule>",'
        '"citation":"<quote>"}\n'
        f"  uv run python scripts/ops/memory_judge.py --run-dir {run_dir} replay"
        " --from <the grader's jsonl>"
    )
    seal_flag = f" --seal-dir {seal_dir}" if seal_dir else ""
    score = (
        "then score it from THIS session, not the grading one, because the seal directory "
        "is not the grader's to know:\n"
        f"  uv run python scripts/ops/memory_judge.py --run-dir {run_dir} ingest{seal_flag}"
    )
    return grade, score


# --------------------------------------------------------------------------- #
# The receipt: the evidence record the completion judge validates.
# --------------------------------------------------------------------------- #

MEMORY_DRILL_SOURCE_PATHS: tuple[str, ...] = (
    "consent-protocol/scripts/ops/pod_lifecycle_drill.py",
    "consent-protocol/api/routes/one/pod_turn.py",
    "consent-protocol/api/routes/one/pod_memory.py",
    "consent-protocol/hushh_mcp/one_adk/memory_review.py",
    "consent-protocol/hushh_mcp/one_adk/memory_review_tools.py",
    "consent-protocol/hushh_mcp/one_adk/text_runtime.py",
    "consent-protocol/hushh_mcp/services/pod_memory_service.py",
    "consent-protocol/hushh_mcp/services/pod_memory_bank.py",
    "consent-protocol/hushh_mcp/services/pod_commit_log.py",
    "consent-protocol/pod_server.py",
)


def write_receipt(
    path: Path,
    *,
    result: MemoryDrillResult,
    target: dict[str, Any],
    repo_root: Path,
    source_paths: tuple[str, ...] = MEMORY_DRILL_SOURCE_PATHS,
    commands: list[str] | None = None,
    limits: list[str] | None = None,
    judge: dict[str, Any] | None = None,
    exit_code: int | None = None,
) -> dict[str, Any]:
    """The revision-bound evidence record. Counts, hashes and words; never content."""
    repo_root = Path(repo_root)
    revision = subprocess.run(  # noqa: S603 - fixed argv
        ["git", "rev-parse", "HEAD"], cwd=repo_root, capture_output=True, text=True, check=True
    ).stdout.strip()
    hashes = {
        relative: hashlib.sha256((repo_root / relative).read_bytes()).hexdigest()
        for relative in source_paths
    }
    code = (0 if result.passed else 1) if exit_code is None else int(exit_code)
    receipt = {
        "version": 1,
        "assertion_id": MEMORY_DRILL_ASSERTION_ID,
        "result": "pass" if result.passed and code == 0 else "fail",
        "exit_code": code,
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "source_commit": revision,
        "target": dict(target),
        "source_sha256": hashes,
        "case_ids": [row["case"] for row in result.judge_rows],
        "observations": result.observations(),
        "measurements": {"timings_ms": dict(result.timings_ms), "stages": list(result.stages)},
        "commands": list(commands or []),
        "limits": list(
            limits
            or [
                "judged answer quality is reported separately and never added to the rate",
                "per-fact provider erasure is never claimed; provider recall is suppressed until the engine rebuild",
                "compute replacement is a revision replace on the same image, not a kill and rebuild",
            ]
        ),
        "judge_queue": dict(judge or {}),
    }
    Path(path).write_text(json.dumps(receipt, indent=2, sort_keys=True), encoding="utf-8")
    return receipt


def _memory_self_test() -> int:
    """The learning drill on the in-memory fleet, and every leak must fail it."""
    good = asyncio.run(run_memory_learning_drill(InMemoryMemoryFleet(), hushh_id="HA1MEMORYSELF"))
    print(render_memory_report(good))
    if not good.passed:
        print("SELF-TEST FAILED: a learning pod did not pass the memory drill")
        return 1
    for leak in MEMORY_LEAKS:
        leaky = asyncio.run(
            run_memory_learning_drill(InMemoryMemoryFleet(leak=leak), hushh_id="HA1MEMORYLEAK")
        )
        if leaky.passed:
            print(f"SELF-TEST FAILED: a pod that {leak.replace('_', ' ')} wrongly passed the drill")
            return 1
    print(
        f"\nMEMORY SELF-TEST PASSED: the learning drill passes a learning pod and fails all "
        f"{len(MEMORY_LEAKS)} leaky variants."
    )
    return 0


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
    # The learning half: a pod that learns passes, and each of the seven leaks fails.
    return _memory_self_test()


def _memory_main(args: argparse.Namespace) -> int:
    """The memory learning drill against an existing pod, with queue and receipt."""
    if not (args.pod_url and args.hushh_id):
        print("the memory drill needs --pod-url and --hushh-id", file=sys.stderr)
        return 2
    try:
        fleet = ExistingPodFleet(
            hushh_id=args.hushh_id,
            pod_url=args.pod_url,
            auth=args.auth,
            consent_token=args.consent_token or "",
            hub_url=args.hub_url or "",
            firebase_token=args.firebase_token or "",
            puppy_device_id=args.puppy_device_id or "",
            runtime_credential=args.runtime_credential or "",
            runtime_credential_transport=args.runtime_credential_transport,
            vertex_project=args.vertex_project or "",
            vertex_location=args.vertex_location or "",
            service=args.service or "",
            project=args.project or "",
            region=args.region,
        )
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    result = asyncio.run(
        run_memory_learning_drill(
            fleet, hushh_id=args.hushh_id, expect_image_tag=args.expect_image_tag
        )
    )
    print(render_memory_report(result))
    judge: dict[str, Any] = {}
    if args.judge_queue_dir:
        judge = write_judge_queue(
            result.judge_rows,
            run_dir=Path(args.judge_queue_dir),
            seed=args.seed,
            seal_dir=Path(args.judge_seal_dir) if args.judge_seal_dir else None,
            answerer_model=result.turn_provider or "unknown",
        )
        print(f"judge queue: {judge['rows']} rows -> {judge['queue']} (seal outside the run dir)")
        if not judge.get("positions_blinded"):
            # Say it at issue time, to the operator who can still re-issue
            # without the flag. Ingest reports it too, but that is after a
            # grading session has done the work on a queue whose planted
            # positions were the same as the last run issued with this seed.
            print(
                "NOT BLINDED: --seed was supplied, so this run's planted positions are "
                "those of every other run issued with that seed. The score report says "
                "so. Omit --seed unless you are deliberately reproducing an issue."
            )
        if judge.get("superseded_artifacts"):
            # Say it out loud. A re-issue into a directory that already held a
            # run is ordinary, and the operator should not have to infer from a
            # later void that the previous seal and verdicts were set aside.
            print(
                f"superseded {judge['superseded_artifacts']} artifact(s) from a previous issue "
                f"into this directory (issue {judge['issue_ordinal']}); they are renamed, "
                "not deleted"
            )
        if judge.get("verdicts_discarded_by_reissue"):
            # The serious case, and the one worth stopping for: verdicts had
            # already been recorded here. This run will be void at ingest, so
            # say it now rather than after a grading session has done the work.
            print(
                f"WARNING: this directory carries {judge['verdicts_discarded_by_reissue']} "
                "verdict(s) discarded by a re-issue, so ingest will void this run. "
                "Issue the replacement into a NEW run directory instead."
            )
        # The grading half. Without these two commands the queue is a sealed
        # file nothing can score, and the judged quality number cannot be
        # produced honestly at all. The rules are printed here so the grader
        # never needs to open anything but the queue.
        grade, score = memory_grading_instructions(args.judge_queue_dir, args.judge_seal_dir)
        print(grade)
        print(score)
    if args.report_path:
        Path(args.report_path).write_text(json.dumps(result.to_dict(), indent=2))
    if args.receipt_path:
        target: dict[str, Any] = {
            "mode": "deployed",
            "environment": str(args.target_environment or "dev"),
        }
        if args.project:
            target["project"] = args.project
        if args.region:
            target["region"] = args.region
        if args.image_digest:
            target["image_digest"] = args.image_digest
        write_receipt(
            Path(args.receipt_path),
            result=result,
            target=target,
            repo_root=Path(__file__).resolve().parents[3],
            commands=_receipt_commands(sys.argv[1:]),
            judge=judge,
        )
    return 0 if result.passed else 1


_SECRET_FLAGS = ("--consent-token", "--firebase-token", "--runtime-credential")

# Not credentials, and redacted from the RECEIPT for a different reason: each
# one locates the answer key. ``--seed`` IS the planted positions -- replay the
# permutation over the manifest's own row and control counts and it names every
# one -- and ``--judge-seal-dir`` is the directory holding the plaintext
# control map, whose only real protection is a grading session not being told
# where it is. The receipt is an artifact a grading session may read, so a
# receipt carrying either publishes exactly what the seal exists to withhold.
_BLINDING_FLAGS = ("--seed", "--judge-seal-dir")


def _redacted_argv(argv: list[str], flags: tuple[str, ...] = _SECRET_FLAGS) -> list[str]:
    """The command line with every value of ``flags`` replaced by a marker."""
    out: list[str] = []
    skip = False
    for item in argv:
        if skip:
            out.append("<redacted>")
            skip = False
            continue
        flag, _, inline = item.partition("=")
        if flag in flags:
            if inline:
                out.append(f"{flag}=<redacted>")
            else:
                out.append(flag)
                skip = True
            continue
        out.append(item)
    return out


def _receipt_commands(argv: list[str]) -> list[str]:
    """The command line as the RECEIPT may carry it.

    Two lists, two reasons, and the receipt needs both. Credentials must never
    be written anywhere; the blinding flags may be typed in an operator's
    terminal and must not survive into a file a grading session may read. On a
    run that supplies neither flag this changes nothing at all, which is
    exactly why the leak went unnoticed on the runs that do.
    """
    return [
        " ".join(["pod_lifecycle_drill.py", *_redacted_argv(argv, _SECRET_FLAGS + _BLINDING_FLAGS)])
    ]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true", help="run the offline orchestration check")
    ap.add_argument(
        "--live",
        action="store_true",
        help="request live proof (currently blocked pending ownership/cleanup)",
    )
    ap.add_argument("--project", help="GCP project for the live drill")
    ap.add_argument("--region", default="us-central1")
    ap.add_argument("--owner", help="throwaway HusshID for the live drill")
    ap.add_argument(
        "--user-id",
        help="throwaway owner user_id to bind to the pod (the drill mints its own "
        "pkm.read grant unless --consent-token is supplied)",
    )
    ap.add_argument(
        "--consent-token",
        help="a pkm.read grant for the owner (memory drill, direct auth); legacy input otherwise",
    )
    ap.add_argument("--report-path", help="write the drill result JSON here (for CI artifacts)")
    # -- the memory learning drill against an EXISTING pod ------------------------
    ap.add_argument(
        "--memory",
        action="store_true",
        help="run the memory learning drill against an existing pod (needs --pod-url, --hushh-id)",
    )
    ap.add_argument("--pod-url", help="the existing pod's URL")
    ap.add_argument("--hushh-id", help="the existing pod's HusshID")
    ap.add_argument("--auth", choices=("direct", "hub-proxy"), default="direct")
    ap.add_argument("--hub-url", help="hub base URL (hub-proxy auth, and Puppy grant minting)")
    ap.add_argument("--firebase-token", help="the owner's Firebase ID token (hub-proxy auth)")
    ap.add_argument(
        "--puppy-device-id", help="route turns to this Puppy device (grant minted via the hub)"
    )
    ap.add_argument("--runtime-credential", help="the owner's model key (BYOK turns)")
    ap.add_argument("--runtime-credential-transport", default="developer_api")
    ap.add_argument("--vertex-project")
    ap.add_argument("--vertex-location")
    ap.add_argument("--service", help="Cloud Run service name, for the restart (revision replace)")
    ap.add_argument("--expect-image-tag", help="refuse unless /pod/info reports this imageTag")
    ap.add_argument(
        "--judge-queue-dir", help="write the blinded judge queue here (graded separately)"
    )
    ap.add_argument("--judge-seal-dir", help="where the seal lives; must be outside the queue dir")
    ap.add_argument(
        "--seed",
        type=int,
        help="replay a specific shuffle. Omit it: the default mints an "
        "unpredictable seed per issue and seals it, and a supplied seed makes "
        "the run a declared replay rather than a blinded one",
    )
    ap.add_argument("--receipt-path", help="write the revision-bound evidence record here")
    ap.add_argument("--target-environment", default="dev")
    ap.add_argument("--image-digest", help="sha256:<64 hex> of the running image, for the receipt")
    args = ap.parse_args()

    if args.memory:
        return _memory_main(args)

    if not args.live:
        code = _self_test()
        if args.report_path:
            Path(args.report_path).write_text(
                json.dumps({"mode": "dry-run", "passed": code == 0}, indent=2)
            )
        return code

    # The current adapter can mutate an existing owner and lacks durable attempt
    # recovery and external erasure. Do not invoke it until the
    # existing registry/client lifecycle proves attempt-bound ownership and
    # complete cleanup. Retain the adapter for that migration and offline tests.
    report = {
        "mode": "live",
        "passed": False,
        "executed": False,
        "reason": "disposable_ownership_and_cleanup_unverified",
    }
    print(json.dumps(report, sort_keys=True))
    if args.report_path:
        Path(args.report_path).write_text(json.dumps(report, indent=2))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
