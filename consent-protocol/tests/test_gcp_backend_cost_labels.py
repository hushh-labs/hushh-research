"""Cost-attribution labels on a per-user pod (DEV-LIVE-EXECUTION-PLAN.md B5).

Two things are being protected here, and they pull in opposite directions.

**Attribution.** A per-user pod is a separate billable Cloud Run service, so the
bill is unreadable unless every service says which lane and which purpose it
belongs to. ``hussh-env`` must follow the DEPLOY lane, not the runtime
``ENVIRONMENT`` — the dev lane deliberately runs with ``ENVIRONMENT=uat`` for
behaviour parity, so reading the wrong one bills every dev pod to uat.

**Privacy.** Labels are readable by anyone with project-level billing access, so
no label may ever carry PII. The label KEY SET is asserted exactly, which is what
makes a future "just add the email, it's easier" change fail a test instead of
shipping.

Plus the mechanical constraint the API enforces: label values accept only
lowercase letters, digits, dashes and underscores, at most 63 characters.
"""

from __future__ import annotations

import re

import pytest

from hushh_mcp.services.compute_backend import TIER_DEDICATED, TIER_LOGICAL, PodSpec
from hushh_mcp.services.gcp_backend import GcpBackend, _label_value

# The charset the Cloud Run Admin API accepts for a label value.
_GCP_LABEL_VALUE = re.compile(r"^[a-z0-9_-]{0,63}$")

_EXPECTED_LABEL_KEYS = {"app", "hussh-space-id", "hussh-tier", "hussh-env", "hussh-purpose"}

_PHONE_HASH = "9f8e7d6c5b4a39281706"
_POD_PUBKEY = "c29tZS1wdWJsaWMta2V5LWJhc2U2NA=="


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for name in ("HUSHH_DEPLOY_ENV", "ENVIRONMENT", "HUSSH_POD_PURPOSE"):
        monkeypatch.delenv(name, raising=False)
    yield


def _spec(*, tier: str = TIER_LOGICAL, space_id: str | None = "sp_1") -> PodSpec:
    return PodSpec(
        hushh_id="HA1ABC234DEF",
        phone_e164_hash=_PHONE_HASH,
        pod_pubkey=_POD_PUBKEY,
        region="us-central1",
        tier=tier,
        space_id=space_id,
    )


def _labels(spec: PodSpec | None = None) -> dict[str, str]:
    backend = GcpBackend(project="proj-x", image="img:1", live=False)
    return backend.render_deploy_config(spec or _spec())["metadata"]["labels"]


# ---------------------------------------------------------------------------
# The label set itself
# ---------------------------------------------------------------------------


def test_the_label_set_is_exactly_the_five_non_pii_labels():
    # Asserted as an exact set on purpose: adding a sixth label — an email, a
    # phone, a raw user id — must fail here rather than reach a cloud resource.
    assert set(_labels()) == _EXPECTED_LABEL_KEYS


def test_existing_labels_are_unchanged():
    labels = _labels()
    assert labels["app"] == "hussh-one-pod"
    assert labels["hussh-space-id"] == "sp_1"
    assert labels["hussh-tier"] == TIER_LOGICAL
    assert _labels(_spec(tier=TIER_DEDICATED))["hussh-tier"] == TIER_DEDICATED


def test_no_label_value_carries_the_specs_sensitive_fields():
    labels = _labels()
    blob = " ".join(f"{k}={v}" for k, v in labels.items())
    # The phone hash and the pod public key are the only near-identifying values
    # a PodSpec carries; neither belongs on a billing-readable resource.
    assert _PHONE_HASH not in blob
    assert _POD_PUBKEY not in blob
    assert "@" not in blob  # no email could survive the charset anyway


def test_every_label_value_is_gcp_legal():
    for key, value in _labels().items():
        assert _GCP_LABEL_VALUE.match(value), f"{key}={value!r} is not a legal GCP label value"


# ---------------------------------------------------------------------------
# hussh-env follows the DEPLOY lane
# ---------------------------------------------------------------------------


def test_env_label_comes_from_the_deploy_lane(monkeypatch):
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    assert _labels()["hussh-env"] == "dev"


def test_env_label_prefers_deploy_env_over_runtime_environment(monkeypatch):
    # The dev lane deploys with _DEPLOY_ENV=dev but runs with ENVIRONMENT=uat so
    # behaviour gates replicate UAT. Reading ENVIRONMENT would bill dev to uat.
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv("ENVIRONMENT", "uat")
    assert _labels()["hussh-env"] == "dev"


def test_env_label_falls_back_to_environment(monkeypatch):
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "production")
    assert _labels()["hussh-env"] == "production"


def test_env_label_is_honest_when_nothing_is_set():
    # "unknown" rather than "dev": a label that guesses is worse than one that
    # admits it does not know, because the guess is what a cost report repeats.
    assert _labels()["hussh-env"] == "unknown"


# ---------------------------------------------------------------------------
# hussh-purpose
# ---------------------------------------------------------------------------


def test_purpose_label_defaults_to_personal_agent():
    assert _labels()["hussh-purpose"] == "personal-agent"


def test_purpose_label_is_overridable_per_lane(monkeypatch):
    monkeypatch.setenv("HUSSH_POD_PURPOSE", "dev-validation")
    assert _labels()["hussh-purpose"] == "dev-validation"


def test_purpose_label_is_sanitised_and_falls_back_when_blank(monkeypatch):
    monkeypatch.setenv("HUSSH_POD_PURPOSE", "Dev Validation!")
    assert _labels()["hussh-purpose"] == "dev-validation"
    monkeypatch.setenv("HUSSH_POD_PURPOSE", "   ")
    assert _labels()["hussh-purpose"] == "personal-agent"


# ---------------------------------------------------------------------------
# Sanitisation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("dev", "dev"),
        ("UAT", "uat"),
        ("  Production  ", "production"),
        ("dev/validation", "dev-validation"),
        ("space id 42", "space-id-42"),
        ("keep_underscores", "keep_underscores"),
        ("---trimmed---", "trimmed"),
        ("someone@example.com", "someone-example-com"),
        ("+1 425 555 0144", "1-425-555-0144"),
        ("", ""),
        (None, ""),
    ],
)
def test_label_value_sanitisation(raw, expected):
    assert _label_value(raw) == expected


def test_label_value_is_truncated_to_the_api_limit():
    value = _label_value("x" * 200)
    assert len(value) == 63
    assert _GCP_LABEL_VALUE.match(value)


def test_label_value_never_ends_on_a_separator_after_truncation():
    # 62 legal chars then separators: truncation must not leave a trailing dash.
    assert _label_value("a" * 62 + "-!-!-!").endswith("a")


def test_label_value_default_applies_only_to_empty_input():
    assert _label_value("", "fallback") == "fallback"
    assert _label_value("!!!", "fallback") == "fallback"
    assert _label_value("real", "fallback") == "real"


def test_a_space_id_with_illegal_characters_is_sanitised_not_passed_through():
    labels = _labels(_spec(space_id="SP/42 alpha"))
    assert labels["hussh-space-id"] == "sp-42-alpha"
    assert _GCP_LABEL_VALUE.match(labels["hussh-space-id"])


def test_a_missing_space_id_renders_as_an_empty_label():
    # Unchanged from before B5: an empty value is legal, and a logical-tier stamp
    # may genuinely have no spaceID yet.
    assert _labels(_spec(space_id=None))["hussh-space-id"] == ""
