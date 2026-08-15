"""The consent artifact must name every grant the applier actually makes.

`render_bootstrap_plan` is what a person reads before authorizing their project.
`UserGcpBootstrap.plan_calls` is what then runs in it. They diverged in EIGHT roles,
and the direction that matters most is the one where the applier granted something the
plan never mentioned -- including `roles/aiplatform.user`, the ONLY project-level grant
in the whole design.

This is `test_byoc_authorization_script_matches_the_applier`'s doctrine applied to the
other pair. The script/applier parity was already guarded; the plan/applier parity was
not, and it is the pair a human actually reads.
"""

from __future__ import annotations

from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.user_gcp_backend import UserGcpBackend
from hushh_mcp.services.user_gcp_bootstrap import UserGcpBootstrap

_PROJECT = "their-own-project"
_INVOKER = "consent-protocol-runtime@hushh.iam.gserviceaccount.com"

#: Roles the plan declares that the BOOTSTRAP does not bind, with the reason each is
#: legitimate. Anything not listed here must appear on both sides.
_APPLIED_ELSEWHERE = {
    # The binding needs a service to bind to, so it is made when the Cloud Run service
    # is created (`UserGcpBackend._execute_live` -> `set_invoker_binding`), not during
    # bootstrap. The plan marks it `applied_at: provision` for the same reason.
    "roles/run.invoker",
}

#: Roles the plan declares that NOTHING binds, anywhere. Each is a feature that is
#: advertised to a person and cannot work. Kept as an explicit, named list rather than a
#: silent omission so that shrinking it is a deliberate act.
_ADVERTISED_BUT_UNWIRED = {
    # The BYOC mail doorbell. `render_bootstrap_plan` creates the topic, the
    # subscription and the daily watch-renewal job; no applier binds either role, so
    # Gmail cannot publish into the topic and the pod cannot pull from the
    # subscription. The resources exist and the feature is dead.
    "roles/pubsub.publisher",
    "roles/pubsub.subscriber",
}


def _plan():
    spec = PodSpec(hushh_id="ha1_abc", phone_e164_hash="p", pod_pubkey="k")
    backend = UserGcpBackend(user_project=_PROJECT, hushh_invoker_sa=_INVOKER)
    return spec, backend.render_bootstrap_plan(spec)


def _plan_roles() -> set[str]:
    _, plan = _plan()
    return {str(b["role"]) for b in plan.get("iam", [])}


def _applier_roles() -> set[str]:
    _, plan = _plan()
    boot = UserGcpBootstrap(
        project=_PROJECT, bootstrap_sa=f"one-bootstrap@{_PROJECT}.iam.gserviceaccount.com"
    )
    roles: set[str] = set()
    for call in boot.plan_calls(plan):
        for binding in call.get("bindings") or []:
            roles.add(str(binding["role"]))
    return roles


def test_the_plan_advertises_every_role_the_applier_grants() -> None:
    """The load-bearing direction: no silent grant.

    A person cannot consent to authority the artifact never showed them, and no failure
    will ever reveal it -- the bootstrap simply succeeds with more access than was
    disclosed. That is why this direction is asserted separately and named first.

    Broken on purpose: delete `roles/aiplatform.user` from render_bootstrap_plan's iam
    list and this fails naming exactly it.
    """
    undisclosed = _applier_roles() - _plan_roles()
    assert not undisclosed, (
        f"the applier grants {sorted(undisclosed)} and the consent artifact never says so"
    )


def test_the_project_level_grant_is_declared_as_project_level() -> None:
    """Naming the role is not enough; its SCOPE is the thing a person is agreeing to.

    Every other grant in this plan is scoped to one resource. This one is not, because
    Vertex has no per-resource binding, and a reader must be able to see that difference
    without knowing Vertex's IAM model.
    """
    _, plan = _plan()
    vertex = [b for b in plan["iam"] if b["role"] == "roles/aiplatform.user"]
    assert vertex, "the only project-wide grant is missing from the consent artifact"
    assert vertex[0].get("project_level") is True
    assert "project:" in str(vertex[0].get("on", ""))


def test_every_plan_role_is_either_applied_or_explicitly_accounted_for() -> None:
    """The reverse direction, with the honest exceptions written down.

    A plan entry that nothing ever applies is a promise to a person that no code keeps.
    Two such promises exist today (the mail doorbell), and this test's job is to stop
    the list growing silently rather than to pretend it is empty.
    """
    unapplied = _plan_roles() - _applier_roles()
    unexplained = unapplied - _APPLIED_ELSEWHERE - _ADVERTISED_BUT_UNWIRED
    assert not unexplained, (
        f"the plan promises {sorted(unexplained)} and nothing binds them. Either wire it "
        "in the applier or stop advertising it."
    )


def test_the_federation_names_the_account_the_script_actually_creates() -> None:
    """The artifact must name an identity that will exist.

    It rendered `one-bootstrap-<slug>@`, which no script anywhere creates;
    deploy/iam/authorize_byoc_project.sh defaults BOOTSTRAP_SA_ID to `one-bootstrap`.
    A person reading the plan would have looked for an account that never existed, and
    hushh would have impersonated one that was never granted.
    """
    _, plan = _plan()
    named = plan["federation"]["impersonation"]["bootstrap_service_account"]
    assert named == f"one-bootstrap@{_PROJECT}.iam.gserviceaccount.com"


def test_every_resource_the_applier_creates_is_named_in_the_plan() -> None:
    """The teardown receipt is built from `resource_ids(plan)`.

    A resource the plan does not declare can never appear in the receipt, so nothing
    could ever account for it in a project hushh has no standing credential in. The
    signing secret was exactly that until now.
    """
    from hushh_mcp.services.byoc_substrate import resource_ids

    _, plan = _plan()
    ids = set(resource_ids(plan))
    assert any(i.endswith("-signing-key") for i in ids), (
        "the applier creates a signing secret the plan never declares, so teardown cannot name it"
    )
