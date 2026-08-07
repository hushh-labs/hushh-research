"""S8: one image, three platforms -- the rendered artifact must carry the same capabilities.

`test_compute_backend_contract.py` proves the backends are interchangeable at the
*interface*: same methods, same return types. That is necessary and not sufficient.
A backend can satisfy every signature and still render a deploy artifact that
cannot boot a pod -- no hub to read, no key to verify consent with, no model to
call. The interface would stay green while the platform silently diverged.

This is the capability guard. Each backend renders a different shape (Cloud Run's
knative Service vs Anypoint's AMC descriptor), so parity cannot be asserted by
comparing dicts. Instead each backend gets an **extractor** that reduces its own
shape to the same small set of facts, and the capabilities are asserted against
that reduction. Adding a fourth platform means writing one extractor, not
rewriting the assertions.

What parity means here, precisely:

* **Present** -- the artifact declares the slot, so the capability is configurable
  on that platform. A slot may render empty when unconfigured; that is how GCP
  already behaves, and it keeps a dark-shipped pod inert rather than mis-pointed.
* **Populated** -- identity pins and the feature flag must carry real values,
  because a pod cannot be anonymous and a pod whose flag is off has no surface.
* **Never inline** -- signing material arrives by reference on every platform, and
  no private key or vault key appears in any artifact.

The honest divergence, recorded rather than papered over: on Anypoint the model
slot exists but has no ambient-credential path the way Vertex does on GCP, and
live provisioning there is still gated. The slot's presence is what makes the
platform configurable; it is not a claim that the model call works today.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

import pytest

from hushh_mcp.services.anypoint_backend import AnypointBackend
from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.gcp_backend import GcpBackend
from hushh_mcp.services.user_gcp_backend import UserGcpBackend


@dataclass
class Capabilities:
    """One backend's artifact, reduced to the facts parity is asserted on."""

    properties: dict[str, str] = field(default_factory=dict)
    by_reference: set[str] = field(default_factory=set)
    internal_only: bool = False
    blob: str = ""

    def declares(self, name: str) -> bool:
        """The slot exists (value may be empty when unconfigured)."""
        return name in self.properties or name in self.by_reference


def _extract_knative(config: dict[str, Any]) -> Capabilities:
    """Cloud Run (GcpBackend, UserGcpBackend): env entries on the first container."""
    container = config["spec"]["template"]["spec"]["containers"][0]
    properties: dict[str, str] = {}
    by_reference: set[str] = set()
    for entry in container.get("env", []):
        name = entry["name"]
        if "valueFrom" in entry:
            by_reference.add(name)
        else:
            properties[name] = str(entry.get("value", ""))
    ingress = config["metadata"]["annotations"].get("run.googleapis.com/ingress")
    return Capabilities(
        properties=properties,
        by_reference=by_reference,
        internal_only=ingress == "internal",
        blob=str(config),
    )


def _extract_amc(config: dict[str, Any]) -> Capabilities:
    """Anypoint CloudHub 2.0: the Mule application properties service."""
    service = config["application"]["configuration"]["mule.agent.application.properties.service"]
    inbound = config["target"]["deploymentSettings"]["http"]["inbound"]
    return Capabilities(
        properties={k: str(v) for k, v in service.get("properties", {}).items()},
        by_reference=set(service.get("secureProperties", {})),
        internal_only=bool(inbound.get("internal")) and not inbound.get("publicUrl"),
        blob=str(config),
    )


_BACKENDS: list[tuple[str, Callable[[], Any], Callable[[dict], Capabilities]]] = [
    ("gcp", lambda: GcpBackend(project="p", image="i", live=False), _extract_knative),
    ("anypoint", lambda: AnypointBackend(env_id="e", live=False), _extract_amc),
    ("user_gcp", lambda: UserGcpBackend(user_project="up", image="i"), _extract_knative),
]
_IDS = [b[0] for b in _BACKENDS]


def _spec() -> PodSpec:
    return PodSpec(
        hushh_id="HA1PARITY",
        phone_e164_hash="h",
        pod_pubkey="pub",
        region="us-central1",
        space_id="space-1",
    )


@pytest.fixture(params=_BACKENDS, ids=_IDS)
def caps(request: pytest.FixtureRequest) -> Capabilities:
    _name, build, extract = request.param
    return extract(build().render_deploy_config(_spec()))


# --- capabilities every platform must declare ------------------------------------------

# The pod's only data-plane door (it holds no database credential) and the consent
# verifying keys it checks tokens against at its own door. A platform missing
# either renders a pod that cannot do its job, however well-formed the artifact is.
REQUIRED_SLOTS = (
    "HUSSH_HUB_BASE_URL",
    "CONSENT_ED25519_PUBLIC_KEYS",
)


@pytest.mark.parametrize("slot", REQUIRED_SLOTS)
def test_every_platform_declares_the_capability(caps: Capabilities, slot: str):
    assert caps.declares(slot), f"platform does not declare {slot}"


def test_every_platform_declares_how_the_pod_reaches_a_model(caps: Capabilities):
    """Model access is a CAPABILITY, not one vendor's env var.

    Two credential modes exist and they are orthogonal to the provider
    (`runtime_providers/factory.py`): **managed** Vertex workload ADC, which needs
    an ambient Google identity and therefore a project and location; and **BYOK**,
    the user's own key, which is turn-bounded, arrives with the request, and is
    isolated from backend ADC by construction.

    So the artifact must say *which mode this platform is in* -- and be consistent
    with it. Asserting a literal `GOOGLE_GENAI_USE_VERTEXAI == "true"` would encode
    the GCP answer as the universal one and force CloudHub, which has no Vertex, to
    render config that does nothing.
    """
    mode = caps.properties.get("GOOGLE_GENAI_USE_VERTEXAI")
    assert mode in {"true", "false"}, "the platform does not declare a model-access mode"

    if mode == "true":
        # Managed Vertex ADC: the ambient identity needs somewhere to point.
        assert caps.properties.get("GOOGLE_CLOUD_PROJECT"), "managed Vertex needs a project"
        assert caps.properties.get("GOOGLE_CLOUD_LOCATION"), "managed Vertex needs a location"
    else:
        # BYOK: the key is turn-bounded, so there is nothing to render -- and
        # rendering a project/location here would imply an identity that does not
        # exist on this platform.
        assert not caps.properties.get("GOOGLE_CLOUD_PROJECT"), (
            "a BYOK platform must not render a managed Vertex project"
        )


def test_no_platform_renders_a_model_credential(caps: Capabilities):
    """A BYOK key is turn-bounded and never belongs in a deploy artifact."""
    lowered = caps.blob.lower()
    for forbidden in ("api_key", "apikey", "gemini_key", "anthropic_api"):
        assert forbidden not in lowered, f"{forbidden} was rendered into the deploy artifact"


def test_every_platform_pins_the_pod_identity(caps: Capabilities):
    assert caps.properties.get("HUSSH_ID") == "HA1PARITY"
    assert caps.properties.get("HUSSH_SPACE_ID") == "space-1"


def test_every_platform_turns_the_personal_agent_surface_on(caps: Capabilities):
    """A pod exists only because the feature was enabled to provision it; without
    this its only real surface 404s."""
    assert caps.properties.get("PERSONAL_AGENT_ENABLED") == "1"


def test_no_platform_exposes_the_pod_publicly(caps: Capabilities):
    assert caps.internal_only, "the pod must not be reachable from the public internet"


# --- what no platform may ever render ---------------------------------------------------


def test_no_platform_renders_secret_material(caps: Capabilities):
    """BYOK keys and consent tokens arrive per-turn at runtime, never in an artifact."""
    lowered = caps.blob.lower()
    for forbidden in ("private_key", "vault_data_key", "service_account.json", "-----begin"):
        assert forbidden not in lowered, f"{forbidden} was rendered into the deploy artifact"


def test_the_signing_key_is_never_rendered_inline(caps: Capabilities):
    """With HMAC, the power to verify is the power to forge. If a platform carries
    APP_SIGNING_KEY at all it must be a reference the host resolves, never a value."""
    assert "APP_SIGNING_KEY" not in caps.properties, "APP_SIGNING_KEY was rendered as a value"


def test_the_vault_key_is_on_no_platform(caps: Capabilities):
    """A pod performs no vault crypto -- every consumer of that key is hub-only."""
    assert not caps.declares("VAULT_DATA_KEY")


# --- sizing must be chosen, never inherited ---------------------------------------------


def test_the_pod_size_is_declared_not_inherited():
    """A rendered pod must state its own CPU and memory.

    With no ``resources`` block Cloud Run applies its own default of 1 vCPU / 512 MiB
    -- which is how a per-user pod came to cost ~$65/user/month against a measured
    211.9 MB idle footprint. An unstated size is not a neutral choice; it is the
    platform choosing for us, and it changes when the platform changes.

    Asserted on the GCP shape specifically because that is where the block lives;
    CloudHub sizes through vCores in its own descriptor, which the AMC extractor
    already covers.
    """
    container = GcpBackend(project="p", image="i", live=False).render_deploy_config(_spec())[
        "spec"
    ]["template"]["spec"]["containers"][0]
    limits = (container.get("resources") or {}).get("limits") or {}
    assert limits.get("cpu"), "no CPU limit rendered -- the pod inherits a platform default"
    assert limits.get("memory"), "no memory limit rendered -- the pod inherits a platform default"


def test_boot_gets_extra_cpu_so_steady_state_does_not_have_to():
    """Startup CPU boost is what makes a smaller steady-state CPU request honest.

    Boot is the one CPU-bound moment (3.94 s measured, 58% of it `google.adk`);
    everything after is spent waiting on model APIs. Without the boost, shrinking CPU
    would trade cost against the cold start a warm floor exists to avoid.
    """
    annotations = GcpBackend(project="p", image="i", live=False).render_deploy_config(_spec())[
        "spec"
    ]["template"]["metadata"]["annotations"]
    assert annotations.get("run.googleapis.com/startup-cpu-boost") == "true"


def test_a_pod_never_scales_past_one_writer():
    """maxScale is a correctness bound, not a cost knob.

    The pod's storage engine assumes a single writer per pod. A second instance would
    put two writers on one logical store, which no amount of retry logic makes safe.
    """
    annotations = GcpBackend(project="p", image="i", live=False).render_deploy_config(_spec())[
        "spec"
    ]["template"]["metadata"]["annotations"]
    assert annotations["autoscaling.knative.dev/maxScale"] == "1"


# --- the two backends must state the SAME size, not merely a size ------------------
#
# `test_the_pod_size_is_declared_not_inherited` above asserts each backend states
# something. It passed for months while GCP rendered 500m CPU and Anypoint rendered
# "0.1" vCores from an independent literal -- the SAME pod, sized FIVE TIMES
# differently depending on which backend happened to provision it.
#
# That is the structural limit of a presence check, and it is the same shape as the
# HUSSH_POD_TURN_ENABLED omission: a comparison cannot see what both sides get
# wrong, and a per-side check cannot see that the sides disagree. Both backends now
# derive from one profile, so the disagreement is unrepresentable rather than
# merely absent today.


def test_both_backends_size_the_pod_from_one_profile():
    """The profile is the source; a platform floor is a derivation from it, not a rival.

    Read on the ECONOMY tier, where the profile passes through untouched. The warm
    tier is asserted separately below because Cloud Run refuses cpu < 1 when CPU is
    always allocated -- so on that tier the profile is raised to the platform's
    minimum rather than emitted verbatim. Reading parity off the warm tier would
    mean asserting a config Cloud Run rejects with HTTP 400, which is what this
    test did until a real provision proved it (2026-08-07).
    """
    from hushh_mcp.services.compute_backend import POD_CPU, POD_MEMORY, pod_vcores

    gcp = GcpBackend(
        project="p", image="i", live=False, min_instances=0, max_instances=1
    ).render_deploy_config(_spec())
    limits = gcp["spec"]["template"]["spec"]["containers"][0]["resources"]["limits"]
    anypoint = AnypointBackend(live=False).render_deploy_config(_spec())

    assert limits["cpu"] == POD_CPU
    assert limits["memory"] == POD_MEMORY
    assert anypoint["application"]["vCores"] == pod_vcores()


def test_the_warm_tier_derives_its_cpu_from_the_same_profile():
    """Still one source: the warm render is the profile put through the platform floor."""
    from hushh_mcp.services.compute_backend import POD_CPU, POD_MEMORY
    from hushh_mcp.services.gcp_backend import _cpu_for_allocation

    gcp = GcpBackend(
        project="p", image="i", live=False, min_instances=1, max_instances=1
    ).render_deploy_config(_spec())
    limits = gcp["spec"]["template"]["spec"]["containers"][0]["resources"]["limits"]

    assert limits["cpu"] == _cpu_for_allocation(POD_CPU, always_allocated=True)
    assert limits["memory"] == POD_MEMORY


def test_the_vcore_conversion_is_a_unit_change_not_a_policy():
    """1 vCore is one vCPU on CloudHub 2.0, so this is arithmetic. Keeping it a
    function next to the constant is what stops it becoming a second literal that
    drifts -- which is exactly how the 5x gap appeared."""
    from hushh_mcp.services.compute_backend import pod_vcores

    assert pod_vcores(1000) == "1"
    assert pod_vcores(500) == "0.5"
    assert pod_vcores(250) == "0.25"


def test_changing_the_profile_moves_BOTH_backends(monkeypatch):
    """The property that makes this a single source of truth rather than two
    literals that happen to agree today."""
    from hushh_mcp.services import compute_backend

    monkeypatch.setattr(compute_backend, "POD_CPU", "250m")
    monkeypatch.setattr(compute_backend, "POD_CPU_MILLIS", 250)

    import importlib

    from hushh_mcp.services import anypoint_backend, gcp_backend

    importlib.reload(gcp_backend)
    importlib.reload(anypoint_backend)
    try:
        # Economy tier: throttled, so the profile reaches the artifact verbatim and
        # the single-source property is visible without the platform floor in the way.
        limits = gcp_backend.GcpBackend(
            project="p", image="i", live=False, min_instances=0, max_instances=1
        ).render_deploy_config(_spec())["spec"]["template"]["spec"]["containers"][0]["resources"][
            "limits"
        ]
        vcores = anypoint_backend.AnypointBackend(live=False).render_deploy_config(_spec())[
            "application"
        ]["vCores"]
        assert limits["cpu"] == "250m"
        assert vcores == "0.25"
    finally:
        importlib.reload(gcp_backend)
        importlib.reload(anypoint_backend)
