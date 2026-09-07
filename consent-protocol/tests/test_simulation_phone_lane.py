"""The phone bypass gets a real dev lane instead of borrowing UAT's identity.

Before this, `_configured_phone_test_numbers` answered for exactly two runtime
names: `uat` and `production`. Dev never had a branch of its own — it reached the
bypass only because the dev hub deliberately runs with the **uat** runtime
identity for behaviour parity. So the lane meant for simulation was, structurally,
the same lane as real UAT, and no code inside this module could tell them apart.

`dev_simulation_guard` reads the DEPLOY LANE, which the deploy workflow writes per
lane and which is not skewed for parity. That is the signal that can separate them,
so the simulation branch is keyed on it and denies when unconfigured.

The reserved-range check is the second half: a simulation allowlist may contain
only the North American fictitious block, so a dev lane can never claim a routable
number belonging to a real person.
"""

from __future__ import annotations

import pytest

from api.routes import account as account_routes

_LANE_VARS = ("HUSHH_DEV_SIMULATION_ENABLED", "HUSHH_DEPLOY_ENV", "DEPLOY_ENV", "_DEPLOY_ENV")


@pytest.fixture
def clean_env(monkeypatch):
    for name in (
        *_LANE_VARS,
        "ENVIRONMENT",
        "APP_ENV",
        "HUSHH_DEV_PHONE_TEST_NUMBERS",
        "HUSHH_DEV_PHONE_TEST_CODE",
        "HUSHH_UAT_PHONE_TEST_NUMBERS",
        "UAT_PHONE_TEST_NUMBERS",
        "HUSHH_UAT_PHONE_TEST_CODE",
        "UAT_PHONE_TEST_CODE",
        "HUSHH_PROD_PHONE_TEST_ENABLED",
        "HUSHH_PROD_PHONE_TEST_NUMBERS",
        "HUSHH_PROD_PHONE_TEST_CODE",
    ):
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


def _configure_simulation(monkeypatch, *, numbers: str = "+15550100,+15550101") -> None:
    monkeypatch.setenv("HUSHH_DEV_SIMULATION_ENABLED", "1")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv("HUSHH_DEV_PHONE_TEST_NUMBERS", numbers)
    monkeypatch.setenv("HUSHH_DEV_PHONE_TEST_CODE", "424242")


def test_the_simulation_lane_enables_the_bypass_on_a_dev_deploy(clean_env):
    """The point of the change: dev gets the bypass without answering to `uat`."""
    _configure_simulation(clean_env)
    # The dev hub reports `uat` for behaviour parity — and it no longer matters.
    clean_env.setenv("ENVIRONMENT", "uat")

    assert account_routes._phone_test_enabled() is True
    assert account_routes._configured_phone_test_numbers() == {"+15550100", "+15550101"}
    assert account_routes._configured_phone_test_code() == "424242"


def test_the_simulation_lane_is_dead_without_the_deploy_lane(clean_env):
    """Configuration alone must not enable it. Absence of a lane DENIES."""
    clean_env.setenv("HUSHH_DEV_PHONE_TEST_NUMBERS", "+15550100")
    clean_env.setenv("HUSHH_DEV_PHONE_TEST_CODE", "424242")
    clean_env.setenv("ENVIRONMENT", "uat")

    assert account_routes._configured_dev_phone_test_numbers() == set()
    assert account_routes._configured_dev_phone_test_code() == ""
    # And with no UAT allowlist configured either, nothing is enabled at all.
    assert account_routes._phone_test_enabled() is False


def test_production_can_never_reach_the_simulation_lane(clean_env):
    """Even fully configured and opted in, production refuses.

    `production` is in the guard's forbidden set, so the dev resolvers return
    empty and production's own four-condition check is the only answer it can
    give — which, unconfigured, is False.
    """
    _configure_simulation(clean_env)
    clean_env.setenv("HUSHH_DEPLOY_ENV", "production")
    clean_env.setenv("ENVIRONMENT", "production")

    assert account_routes._configured_dev_phone_test_numbers() == set()
    assert account_routes._configured_dev_phone_test_code() == ""
    assert account_routes._phone_test_enabled() is False


def test_a_simulation_allowlist_refuses_a_routable_number(clean_env):
    """A real person's number in a simulation allowlist is an operator mistake.

    It fails loud rather than being silently dropped, because silently narrowing
    an allowlist looks identical to the allowlist having worked.
    """
    _configure_simulation(clean_env, numbers="+15550100,+14255551234")

    with pytest.raises(RuntimeError) as excinfo:
        account_routes._configured_dev_phone_test_numbers()

    assert "+14255551234" in str(excinfo.value)


def test_the_uat_lane_is_untouched(clean_env):
    """This change is additive. A configured UAT deployment behaves exactly as before."""
    clean_env.setenv("ENVIRONMENT", "uat")
    clean_env.setenv("HUSHH_UAT_PHONE_TEST_NUMBERS", "+16505550101")
    clean_env.setenv("HUSHH_UAT_PHONE_TEST_CODE", "121212")

    assert account_routes._phone_test_enabled() is True
    assert account_routes._configured_phone_test_numbers() == {"+16505550101"}
    assert account_routes._configured_phone_test_code() == "121212"


# --- the cross-file contract: the guard's demand and the deploy's supply must agree ---
#
# This is the class of defect no unit test catches. `require_simulation_permitted` was
# correct, its twelve tests passed, and the dev deploy set no opt-in — so wiring it into
# `GcpBackend` would have refused every live provision on the one lane that works. The
# guard and the deploy config are in different files and different languages, and only a
# test that reads both can see the disagreement.
#
# Each of these reads the constant from the GUARD, never a literal retyped here. A test
# that owns its own copy of the name passes for exactly as long as both copies are wrong
# together, which is the failure mode this whole workstream keeps finding.


def test_the_dev_deploy_sets_the_flag_the_guard_actually_reads():
    from hushh_mcp.services.dev_simulation_guard import _OPT_IN_FLAG
    from tests._deploy_contract import backend_deploy_script

    assert f'append_optional_env "{_OPT_IN_FLAG}"' in backend_deploy_script()


def test_the_env_the_dev_deploy_assembles_satisfies_the_guard(clean_env):
    """Reproduce the dev lane's env exactly, then ask the real guard.

    `HUSHH_DEPLOY_ENV=${_DEPLOY_ENV}` is set unconditionally by the script, and the
    dev branch turns the opt-in on. Both together are what the guard requires.
    """
    from hushh_mcp.services.dev_simulation_guard import _OPT_IN_FLAG, simulation_permitted

    clean_env.setenv("HUSHH_DEPLOY_ENV", "dev")
    clean_env.setenv(_OPT_IN_FLAG, "true")
    # The dev hub runs with the uat runtime identity; the guard must not be fooled.
    clean_env.setenv("ENVIRONMENT", "uat")

    assert simulation_permitted() is True


def test_the_allowlist_the_deploy_pins_survives_the_backends_own_rule(clean_env):
    """The numbers baked into the deploy script must pass the reserved-range check.

    Parsed out of the script rather than restated, so editing one and not the other
    turns this red instead of shipping a deploy the backend refuses at startup.
    """
    import re

    from tests._deploy_contract import backend_deploy_script

    match = re.search(r'dev_phone_test_numbers="([^"]+)"', backend_deploy_script())
    assert match, "the dev deploy no longer pins a simulation phone allowlist"

    _configure_simulation(clean_env, numbers=match.group(1))
    numbers = account_routes._configured_dev_phone_test_numbers()

    assert numbers, "the pinned allowlist parsed to nothing"
    assert all(n.startswith(account_routes._SIMULATION_PHONE_PREFIX) for n in numbers)


# --- dev-only scoping, executed rather than asserted ---------------------------------
#
# The founder constraint is that this is development configuration and touches no other
# environment. That is a claim about a bash script, so it is checked by RUNNING the
# script's own personal-agent block for every value the deploy lanes actually pass --
# the same technique `test_pod_image_build_contract.py` uses -- rather than by reading
# the `if` and trusting it.

# Every value the deploy lanes pass. `manual` is the template's own default, and the
# empty string is a container that lost its configuration.
_NON_DEV_ENVS = ["uat", "prod", "production", "staging", "manual", ""]


def _run_personal_agent_block(deploy_env: str) -> list[str]:
    """Execute the real block and return the env vars it would actually set."""
    import subprocess

    from tests._deploy_contract import backend_deploy_script

    script = backend_deploy_script()
    start = script.index('personal_agent_enabled=""')
    end = script.index('append_optional_env "HUSHH_DEV_PHONE_TEST_NUMBERS"')
    slice_ = script[start : script.index("\n", end) + 1]

    # Cloud Build expands ${_FOO} textually before bash sees it; reproduce that.
    slice_ = slice_.replace("${_DEPLOY_ENV}", deploy_env).replace(
        "${_RUNTIME_SERVICE_ACCOUNT}", "runtime@example.iam.gserviceaccount.com"
    )
    preamble = (
        "env_vars=()\n"
        "append_optional_env() {\n"
        '  local env_name="$1"\n'
        '  local env_value="$2"\n'
        '  if [[ -n "${env_value}" ]]; then\n'
        '    env_vars+=("${env_name}=${env_value}")\n'
        "  fi\n"
        "}\n"
    )
    result = subprocess.run(  # noqa: S603 - fixed argv, no shell=True, test-local input
        ["bash", "-c", preamble + slice_ + '\nprintf "%s\\n" "${env_vars[@]}"'],  # noqa: S607
        text=True,
        capture_output=True,
        check=True,
    )
    return [line for line in result.stdout.splitlines() if line]


@pytest.mark.parametrize("deploy_env", _NON_DEV_ENVS)
def test_no_other_environment_gains_a_simulation_variable(deploy_env: str):
    """uat, production, staging and an unconfigured container are byte-identical.

    `append_optional_env` skips an empty value, so an empty variable is never set at
    all — the runtime default applies and the lane behaves exactly as it did before
    this workstream existed.
    """
    names = {line.split("=", 1)[0] for line in _run_personal_agent_block(deploy_env)}

    assert "HUSHH_DEV_SIMULATION_ENABLED" not in names
    assert "HUSHH_DEV_PHONE_TEST_NUMBERS" not in names


def test_dev_is_the_one_environment_that_gains_them():
    """The other half. A guard that never permits is as broken as one that never denies."""
    emitted = dict(line.split("=", 1) for line in _run_personal_agent_block("dev"))

    assert emitted["HUSHH_DEV_SIMULATION_ENABLED"] == "true"
    assert emitted["HUSHH_DEV_PHONE_TEST_NUMBERS"].startswith(
        account_routes._SIMULATION_PHONE_PREFIX
    )


# --- the OTP is optional in the simulation lane, and nowhere else ---------------------
#
# The dev deployment must not block end-to-end testing behind a code somebody has to
# set by hand after every deploy. So no code configured means no code checked — but
# only where `simulation_permitted()` already said yes, and only for a number in the
# reserved fictitious block.


def test_the_lane_is_enabled_with_no_code_at_all(clean_env):
    """The whole point: a dev deploy needs no operator secret to be usable."""
    clean_env.setenv("HUSHH_DEV_SIMULATION_ENABLED", "1")
    clean_env.setenv("HUSHH_DEPLOY_ENV", "dev")
    clean_env.setenv("HUSHH_DEV_PHONE_TEST_NUMBERS", "+15550100")

    assert account_routes._dev_phone_code_is_optional() is True
    assert account_routes._phone_test_enabled() is True


def test_configuring_a_code_turns_the_check_back_on(clean_env):
    """The escape hatch, so dev can still rehearse the real OTP flow."""
    _configure_simulation(clean_env)

    assert account_routes._dev_phone_code_is_optional() is False
    assert account_routes._configured_phone_test_code() == "424242"


def test_the_optional_path_is_unreachable_outside_a_simulation_lane(clean_env):
    """No lane, no relaxation — including with the numbers present."""
    clean_env.setenv("HUSHH_DEV_PHONE_TEST_NUMBERS", "+15550100")
    clean_env.setenv("ENVIRONMENT", "uat")

    assert account_routes._dev_phone_code_is_optional() is False
    assert account_routes._phone_test_enabled() is False


def test_production_cannot_reach_the_optional_path(clean_env):
    """Fully configured and opted in, production still refuses."""
    clean_env.setenv("HUSHH_DEV_SIMULATION_ENABLED", "1")
    clean_env.setenv("HUSHH_DEPLOY_ENV", "production")
    clean_env.setenv("ENVIRONMENT", "production")
    clean_env.setenv("HUSHH_DEV_PHONE_TEST_NUMBERS", "+15550100")

    assert account_routes._dev_phone_code_is_optional() is False
    assert account_routes._phone_test_enabled() is False


def test_uat_still_requires_its_code(clean_env):
    """A UAT deployment with numbers but no code stays disabled, as before."""
    clean_env.setenv("ENVIRONMENT", "uat")
    clean_env.setenv("HUSHH_UAT_PHONE_TEST_NUMBERS", "+16505550101")

    assert account_routes._dev_phone_code_is_optional() is False
    assert account_routes._phone_test_enabled() is False


# --- dev reports its own name -------------------------------------------------------
#
# deploy-dev.yml passes _RUNTIME_ENVIRONMENT=uat, so dev used to report `uat` and was
# indistinguishable from real UAT to every runtime check. The deploy script now
# overrides that for the dev lane. These execute the real resolution rather than
# reading the `if`, and pin the two consequences that actually matter.


def _resolve_runtime_environment(deploy_env: str, runtime_env: str = "uat") -> str:
    """Run the script's own runtime-identity resolution for a given lane."""
    import subprocess

    from tests._deploy_contract import backend_deploy_script

    script = backend_deploy_script()
    start = script.index('runtime_environment="${_RUNTIME_ENVIRONMENT}"')
    end = script.index('if [[ "${_DEPLOY_ENV}" == "dev" ]]; then\n  runtime_environment="dev"\nfi')
    slice_ = script[
        start : end
        + len('if [[ "${_DEPLOY_ENV}" == "dev" ]]; then\n  runtime_environment="dev"\nfi')
    ]
    slice_ = slice_.replace("${_RUNTIME_ENVIRONMENT}", runtime_env).replace(
        "${_DEPLOY_ENV}", deploy_env
    )
    return subprocess.run(  # noqa: S603
        ["bash", "-c", slice_ + '\nprintf "%s" "${runtime_environment}"'],  # noqa: S607
        text=True,
        capture_output=True,
        check=True,
    ).stdout.strip()


def test_the_dev_lane_reports_dev_not_uat():
    assert _resolve_runtime_environment("dev") == "dev"


def test_dev_reports_dev_even_though_the_workflow_still_passes_uat():
    """deploy-dev.yml lives on `main` and still sends uat; the script overrides it."""
    assert _resolve_runtime_environment("dev", runtime_env="uat") == "dev"


def test_uat_and_production_keep_the_value_they_were_given():
    assert _resolve_runtime_environment("uat", runtime_env="uat") == "uat"
    assert _resolve_runtime_environment("production", runtime_env="production") == "production"
    # And the pre-existing fallback to the deploy lane is untouched.
    assert _resolve_runtime_environment("production", runtime_env="") == "production"


def test_dev_stays_inside_the_hosted_runtime_guards():
    """`dev` is in _HOSTED_ENVIRONMENTS; `development` is not.

    That set gates the assertions that a hosted runtime must use Vertex ADC and must
    have GOOGLE_CLOUD_PROJECT. Reporting `development` would silently relax both, so
    this pins the value against the callee's own set rather than a literal.
    """
    from hushh_mcp.runtime_providers.factory import _HOSTED_ENVIRONMENTS

    assert _resolve_runtime_environment("dev") in _HOSTED_ENVIRONMENTS
    assert "development" not in _HOSTED_ENVIRONMENTS


def test_dev_needs_its_own_lane_before_any_phone_allowlist_answers(clean_env):
    """UAT secrets alone enable nothing on dev; the simulation lane is the key.

    The dev revision mounts HUSHH_UAT_PHONE_TEST_* and, while it reported `uat`,
    resolved them as its own with no lane decision anywhere. Reporting `dev` ends
    that: with the simulation lane OFF, nothing resolves. With the lane ON, the
    dev-reserved range AND the operator-curated UAT allowlist both answer — the
    silent drop of the UAT numbers stranded the pair people actually use
    (founder-reported 2026-08-21), so consulting them again is deliberate, and
    the lane gate is what separates dev from an unconfigured box.
    """
    clean_env.setenv("ENVIRONMENT", "dev")
    clean_env.setenv("HUSHH_UAT_PHONE_TEST_NUMBERS", "+16505550101")
    clean_env.setenv("HUSHH_UAT_PHONE_TEST_CODE", "121212")

    assert account_routes._configured_phone_test_numbers() == set()
    assert account_routes._phone_test_enabled() is False

    # ...and the dev lane the deploy script configures unlocks BOTH allowlists.
    clean_env.setenv("HUSHH_DEV_SIMULATION_ENABLED", "1")
    clean_env.setenv("HUSHH_DEPLOY_ENV", "dev")
    clean_env.setenv("HUSHH_DEV_PHONE_TEST_NUMBERS", "+15550100")

    assert account_routes._configured_phone_test_numbers() == {"+15550100", "+16505550101"}
    assert account_routes._phone_test_enabled() is True


def test_the_simulation_lane_also_honours_the_uat_allowlist(clean_env):
    """Dev consults the operator-curated UAT numbers again (founder pair).

    Dev rode the UAT allowlist for as long as its runtime identified as `uat`;
    the dev-identity change silently dropped it and stranded the standing
    +1 989 898 9894 / 000000 pair. The merge brings the numbers back WITHOUT
    touching the reserved-range guard on HUSHH_DEV_PHONE_TEST_NUMBERS itself.
    """
    _configure_simulation(clean_env)
    clean_env.setenv("ENVIRONMENT", "dev")
    clean_env.setenv("HUSHH_UAT_PHONE_TEST_NUMBERS", "+19898989894")
    clean_env.setenv("HUSHH_UAT_PHONE_TEST_CODE", "000000")

    assert account_routes._configured_phone_test_numbers() == {
        "+15550100",
        "+15550101",
        "+19898989894",
    }


def test_a_uat_number_keeps_its_fixed_code_inside_the_simulation_lane(clean_env):
    """Merging widens WHICH numbers are claimable, never HOW they are claimed."""
    _configure_simulation(clean_env)
    # No dev code configured: the reserved range runs code-optional on dev.
    clean_env.delenv("HUSSH_DEV_PHONE_TEST_CODE", raising=False)
    clean_env.delenv("HUSHH_DEV_PHONE_TEST_CODE", raising=False)
    clean_env.setenv("ENVIRONMENT", "dev")
    clean_env.setenv("HUSHH_UAT_PHONE_TEST_NUMBERS", "+19898989894")
    clean_env.setenv("HUSHH_UAT_PHONE_TEST_CODE", "000000")

    reserved_code, reserved_optional = account_routes._phone_test_expected_code("+15550100")
    assert reserved_optional is True

    uat_code, uat_optional = account_routes._phone_test_expected_code("+19898989894")
    assert uat_optional is False
    assert uat_code == "000000"


def test_a_dev_code_never_replaces_the_uat_code_for_uat_numbers(clean_env):
    """With a dev code set, each range still answers to its own code."""
    _configure_simulation(clean_env)  # sets HUSHH_DEV_PHONE_TEST_CODE=424242
    clean_env.setenv("ENVIRONMENT", "dev")
    clean_env.setenv("HUSHH_UAT_PHONE_TEST_NUMBERS", "+19898989894")
    clean_env.setenv("HUSHH_UAT_PHONE_TEST_CODE", "000000")

    reserved_code, reserved_optional = account_routes._phone_test_expected_code("+15550100")
    assert reserved_optional is False
    assert reserved_code == "424242"

    uat_code, uat_optional = account_routes._phone_test_expected_code("+19898989894")
    assert uat_optional is False
    assert uat_code == "000000"


def test_real_uat_claim_semantics_are_unchanged_by_the_merge(clean_env):
    """On real UAT (no simulation lane) the UAT code still decides, as before."""
    clean_env.setenv("ENVIRONMENT", "uat")
    clean_env.setenv("HUSHH_UAT_PHONE_TEST_NUMBERS", "+19898989894")
    clean_env.setenv("HUSHH_UAT_PHONE_TEST_CODE", "000000")

    assert account_routes._configured_phone_test_numbers() == {"+19898989894"}
    expected, optional = account_routes._phone_test_expected_code("+19898989894")
    assert optional is False
    assert expected == "000000"
