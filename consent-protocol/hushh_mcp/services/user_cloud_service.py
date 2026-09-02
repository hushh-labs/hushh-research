"""One reader for "where does this person's agent belong?".

Three subsystems need the same answer about the same person: the AI-connection gate
(may this connection earn a pod, and served by whose credential?), the provisioning
brain (which backend builds it, in which project?), and the substrate ensurer (whose
infrastructure am I applying?). Before this, each derived it independently -- and two of
the three derived it from process-wide environment variables, which is how a per-person
target ended up pointing every pod at one deployment-wide project.

Deriving the same fact in three places is the defect, not the duplication. Three
derivations can disagree, and the disagreement is silent: a pod built on one target,
judged against another, and torn down against a third all look locally correct.

This module has no policy in it. It reads the row and reports what is there. The
decision about what a missing or unauthorized cloud MEANS belongs to the caller, because
the answer genuinely differs: the gate refuses, provisioning raises, and a status read
simply shows an incomplete step.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Optional

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class UserCloud:
    """What the registry knows about one person's chosen cloud."""

    deployment_target: Optional[str]
    model_credential_mode: Optional[str]
    project: Optional[str]
    region: Optional[str]
    bootstrap_sa: Optional[str]
    #: Proven, never asserted. True only when hushh minted a token against the person's
    #: bootstrap account and it worked. A form cannot set this.
    authorized: bool

    @property
    def is_user_owned(self) -> bool:
        return (self.deployment_target or "").strip() == "user_gcp"

    @property
    def is_hosted(self) -> bool:
        """This person chose to have hussh host their pod.

        A third answer, and the reason it needs its own property rather than
        `not is_user_owned`: an unset `deployment_target` means the person has not
        chosen at all, which is a different state from having chosen hussh. The
        first still has a decision pending in onboarding; the second is finished.
        Collapsing them would make "I chose hussh" indistinguishable from "I have
        not been asked yet", which is exactly the ambiguity the choice exists to end.
        """
        return (self.deployment_target or "").strip() == "gcp"

    @property
    def is_ready_to_provision(self) -> bool:
        """A named cloud is not a reachable one.

        Both halves are required and they fail differently: no project means nothing was
        ever chosen, while a project without authorization means the person named their
        cloud and has not yet run the grant. Provisioning must refuse the second rather
        than fall back to hussh's own cloud, which would put their agent and their bill
        somewhere they did not choose, with nothing saying so.
        """
        return self.is_user_owned and bool((self.project or "").strip()) and self.authorized

    @property
    def blocks_provisioning(self) -> bool:
        """This person chose a cloud hushh cannot yet reach, so nothing may be built.

        Exists so the ORCHESTRATOR can ask the question without naming a provider.
        `personal_agent_provisioning_service` is the common layer, which
        `tests/test_deployment_boundary_holds.py` refuses to let name a cloud -- and it
        is right to: a `== "user_gcp"` branch there is how a pluggable seam becomes a
        switch statement with three arms and then five. The knowledge belongs here,
        beside the other facts about a person's cloud.
        """
        return self.is_user_owned and not self.is_ready_to_provision


def user_cloud_from_row(row: Optional[dict[str, Any]]) -> Optional[UserCloud]:
    """Project a registry row onto the cloud facts. ``None`` when there is no row."""
    if not row:
        return None
    return UserCloud(
        deployment_target=(row.get("deployment_target") or None),
        model_credential_mode=(row.get("model_credential_mode") or None),
        project=(row.get("user_cloud_project") or None),
        region=(row.get("user_cloud_region") or None),
        bootstrap_sa=(row.get("user_cloud_bootstrap_sa") or None),
        authorized=bool(row.get("user_cloud_authorized_at")),
    )


async def resolve_user_cloud(user_id: str, *, repo: Any = None) -> Optional[UserCloud]:
    """The person's cloud, or ``None`` when they have no registry row yet.

    Never raises for a missing row or an unreachable registry: every caller here is on a
    path where "I could not find out" and "they have no cloud" must lead to the same
    conservative behaviour -- the deployment default -- and a raise would turn a
    read-only lookup into an outage on the phone-verify seam.

    That conservatism is only safe because it is paired with a refusal upstream: a row
    that DOES name a user_gcp target without authorization is not treated as absent, it
    is reported truthfully and the caller declines. Silence here means "no cloud", never
    "an unverified one".
    """
    if not str(user_id or "").strip():
        return None
    try:
        if repo is None:
            from hushh_mcp.services.personal_agent_registry_repo import (
                PersonalAgentRegistryRepo,
            )

            repo = PersonalAgentRegistryRepo()
        cloud = user_cloud_from_row(await repo.get(user_id))
        if cloud is not None:
            return cloud
        # No row yet. The cloud step comes before phone verification (which mints
        # the row), so a person can hold a PROVEN cloud that is parked on their
        # setup record. Answer with it: the AI gate then takes the own-cloud rule
        # (the pod's ADC) instead of treating "your pod's AI" as hushh's managed
        # model and refusing it (founder-hit, 2026-09-02).
        return await _parked_user_cloud(user_id)
    except Exception:  # noqa: BLE001 - a read-only lookup must not break provisioning
        logger.warning("user_cloud.lookup_failed", exc_info=True)
        return None


async def _parked_user_cloud(user_id: str) -> Optional[UserCloud]:
    """A proven cloud waiting for its registry row, as the gate needs to see it."""
    from hushh_mcp.services.byoc_setup_job_service import ByocSetupJobRepo

    parked = await ByocSetupJobRepo().parked_cloud(user_id)
    if not parked:
        return None
    return UserCloud(
        deployment_target="user_gcp",
        model_credential_mode="user_adc",
        project=parked["project_id"],
        region=parked["region"],
        bootstrap_sa=parked["bootstrap_sa"],
        authorized=bool(parked["authorized"]),
    )
