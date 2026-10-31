"""Research-provider lineage and initial rollout metadata over canonical checkpoint ports."""

import uuid


def prepare_discovery_start_state(state, *, scope, stored_attempts, clock, provider, work_version):
    """Translate a provider checkpoint without resetting paid hourly starts."""
    prior_scope = state.get("budget_scope")
    if prior_scope == scope:
        return state
    work = state.get("work")
    if isinstance(work, dict) and "azure_work_version" in work:
        if (
            type(work["azure_work_version"]) is not int
            or work["azure_work_version"] != work_version
        ):
            raise RuntimeError("Unsupported discovery work version")
    if prior_scope is not None:
        # A same-provider layout change needs its own migration, even if
        # every old slot index happens to fit the new range.
        known_limits = {
            "vertex_google_search:v1:32:128": 160,
            "azure_openai_web_search:v1:8:16": 24,
            "azure_openai_tavily:v1:8:16": 24,
        }
        prior_limit = known_limits.get(prior_scope) if isinstance(prior_scope, str) else None
        if prior_limit is None:
            raise RuntimeError("Unsupported discovery budget scope")
        prior_provider = prior_scope.split(":", 1)[0]
        if prior_provider == provider:
            raise RuntimeError("Unsupported discovery budget scope")
        prior = state.get("attempted_combinations", [])
        if (
            not isinstance(prior, list)
            or any(type(index) is not int or not 1 <= index <= prior_limit for index in prior)
            or len(set(prior)) != len(prior)
        ):
            raise RuntimeError("Invalid discovery attempt budget")
        incompatible = True
    elif provider == "vertex_google_search":
        incompatible = isinstance(work, dict) and "azure_work_version" in work
    elif isinstance(work, dict) and "azure_work_version" in work:
        # Azure checkpoints written before the scope marker shipped.
        return {**state, "budget_scope": scope}
    else:
        prior = state.get("attempted_combinations", [])
        valid_vertex_slots = (
            isinstance(prior, list)
            and all(type(index) is int and 1 <= index <= 160 for index in prior)
            and len(set(prior)) == len(prior)
        )
        incompatible = valid_vertex_slots and (
            work or any(index > stored_attempts for index in prior)
        )

    if incompatible:
        # A provider switch gets a fresh provider ledger and private work.
        # Hourly starts survive so switching cannot evade start limits.
        return {
            **{key: value for key, value in state.items() if key not in {"work", "inputs"}},
            "budget_scope": prior_scope or "legacy-provider-checkpoint",
            "identity_binding": "",
            "resume_binding": "",
            "attempted_combinations": [],
            "discovery_started_at": clock(),
        }
    # No incompatible evidence exists. Carry ambiguous paid slots rather
    # than granting a second Azure budget after an early provider failure.
    return {**state, "budget_scope": scope}


async def carry_legacy_starts(
    user_id, require_access, *, store, legacy_store, context_factory, clock
):
    if legacy_store is None or await store.get(user_id) is not None:
        return
    legacy = await legacy_store.get(user_id)
    await require_access()
    if legacy is None:
        return
    # No legacy provider content crosses the retrieval/retention boundary.
    # Preserve recent paid starts at rollout, not old provider slot meanings.
    starts = [at for at in legacy.get("starts", []) if at > clock() - 3600]
    context = await context_factory()
    state = {
        **context,
        "job_id": str(uuid.uuid4()),
        "status": "pending",
        "started_at": 0,
        "finished_at": 0,
        "discovery_started_at": clock(),
        "identity_binding": "",
        "resume_binding": "",
        "starts": starts,
        "attempted_combinations": [],
        "result": {"status": "pending", "pkm_written": False, "restart_required": True},
    }
    await store.write(user_id, state, None)
    await require_access()
