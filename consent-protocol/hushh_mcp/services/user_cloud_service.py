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
    #: The registry could not be read, so NOTHING below is known -- least of all that
    #: this person has no cloud. Kept as a field rather than signalled by returning
    #: ``None`` because ``None`` already means "no row", and collapsing "they have no
    #: cloud" into "we could not find out" is what let a BYOC person's pod be built on
    #: hushh's compute.
    lookup_failed: bool = False

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
        return self.lookup_failed or (self.is_user_owned and not self.is_ready_to_provision)

    @property
    def refusal_reason(self) -> str:
        """Why provisioning must stop, in the caller's words rather than a cloud's.

        The common layer may not name a provider, but it must still say something
        true: "not yet authorized" is the wrong sentence for a registry that would
        not answer, and it would send a person to re-run a grant they already made.
        """
        if self.lookup_failed:
            return (
                "this person's cloud could not be read, so where their agent belongs "
                "is unknown; refusing rather than defaulting to hushh's own cloud"
            )
        return (
            "this person's own cloud is recorded but not yet authorized; they need to "
            "authorize their project before their agent can be built there"
        )


#: One shared instance: it carries no per-person facts, only the absence of them.
_LOOKUP_FAILED = UserCloud(
    deployment_target=None,
    model_credential_mode=None,
    project=None,
    region=None,
    bootstrap_sa=None,
    authorized=False,
    lookup_failed=True,
)


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

    Still never raises -- a raise would turn a read-only lookup into an outage on the
    phone-verify seam -- but an unreachable registry is no longer answered with the same
    value as an empty one. It returns a cloud whose ``lookup_failed`` is set.

    The previous wording claimed the two could safely share an answer because "a row
    that DOES name a user_gcp target without authorization is reported truthfully and
    the caller declines". That reasoning holds for a MISSING row and not for a FAILED
    READ, and the code could not tell them apart: on any registry exception a BYOC
    person's pod was built on hushh's compute and hushh's bill, with applied=True at
    every layer. The distinction lives in the return type now, so no caller has to
    remember it.

    Read-only callers are unaffected -- each gates on ``is_user_owned`` or ``project``,
    both empty on a failed read, so they behave exactly as they did for ``None``. Only
    the caller that BUILDS something sees the difference, via ``blocks_provisioning``.
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
        if cloud is not None and cloud.deployment_target:
            # The row says where this person's agent lives -- their own cloud or
            # hushh's. Either way it is the answer, and a parked record must not
            # override a choice already recorded.
            return cloud
        # Either there is no row, or there is a row that does not name a cloud. Both
        # reach the parked record, and the second case is the one that used to be
        # missed: `user_cloud_from_row` returns None only for a MISSING row, so a row
        # present without cloud columns came back as a UserCloud full of Nones, which
        # is `not None`, and this fallback was skipped.
        #
        # That gap is a silent fallback to hushh's own cloud. The cloud step comes
        # before phone verification, so a proven cloud waits parked on the person's
        # setup record until `register_pending` writes the row and attaches it. That
        # attach is best-effort and documents itself as retryable -- "the parked record
        # stays, so a retry can still land it". When it did not land, the row existed
        # with no cloud, `is_user_owned` was False, `blocks_provisioning` was False,
        # and provisioning built their pod on hushh's compute and hushh's bill for
        # somebody who had already proved their own project.
        #
        # Answering from the parked record closes that for every caller at once rather
        # than at each call site: the AI gate takes the own-cloud rule (the pod's ADC)
        # instead of treating "your pod's AI" as hushh's managed model and refusing it
        # (founder-hit, 2026-09-02), and provisioning refuses rather than defaulting.
        try:
            parked = await _parked_user_cloud(user_id)
        except Exception:  # noqa: BLE001 - a failed PARKED read is not an unknown cloud
            # Deliberately not allowed to reach the handler below. That one answers
            # "unknown" and provisioning refuses, which is right when the REGISTRY
            # could not be read -- there is genuinely no answer then. Here the registry
            # answered: this row names no cloud. A parked lookup that fails on top of
            # that adds no doubt to a question already settled, and turning it into a
            # refusal would block every person who simply has not chosen a cloud yet.
            logger.warning("user_cloud.parked_lookup_failed", exc_info=True)
            parked = None
        return parked if parked is not None else cloud
    except Exception:  # noqa: BLE001 - still no raise; the answer is "unknown", not an outage
        logger.warning("user_cloud.lookup_failed", exc_info=True)
        # NOT None. None means "this person has no cloud", and the caller that builds
        # infrastructure acts on that by using the deployment default -- which for a
        # BYOC person is hushh's own project, on hushh's fleet identity, reporting
        # applied=True at every layer with nothing anywhere saying so. The comment
        # above the provisioning gate names this exact outcome as the thing to avoid;
        # returning None here was how it happened anyway.
        return _LOOKUP_FAILED


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
