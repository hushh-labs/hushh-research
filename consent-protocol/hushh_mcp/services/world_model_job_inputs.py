"""Frozen, owner-approved research input lifecycle over existing job ports."""


class PublicProfilesChanged(ValueError):
    """A different public seed requires an explicit, non-overlapping discovery."""


def prepare_start_state(manager, state, *, context=None, prepare):
    if state is None:
        return state
    prepared = prepare(
        state,
        scope=manager.budget_scope(),
        stored_attempts=manager.stored_attempts,
        clock=manager.clock,
    )
    if prepared is None:
        return None
    # Explicit Update approves one frozen context for a discovery and its
    # resumptions, not an automatic export into a later fresh generation.
    continuing = prepared["status"] in {
        "pending",
        "paused",
        "unavailable",
    } and manager.checkpoint_retained(prepared.get("discovery_started_at", prepared["started_at"]))
    if (
        not continuing
        or (
            context is not None
            and any(prepared.get(key) != value for key, value in context.items())
        )
    ) and "research_context" in prepared.get("inputs", {}):
        prepared = {
            **prepared,
            "inputs": {
                key: value for key, value in prepared["inputs"].items() if key != "research_context"
            },
        }
    return prepared


def prepare_inputs(manager, state, inputs, refresh_completed, *, provider):
    from hushh_mcp.one_adk.public_sources import OwnerPublicProfiles
    from hushh_mcp.one_adk.research_context import OwnerResearchContext

    prior = (state or {}).get("inputs") or {}
    carried = dict(prior if inputs is None else inputs)
    if refresh_completed and (inputs is None or "research_context" not in inputs):
        carried.pop("research_context", None)
    for field in ("public_profiles", "owner_decisions", "research_context"):
        if field not in carried and field in prior:
            if field == "research_context" and refresh_completed:
                continue
            carried[field] = prior[field]
    profiles = carried.get("public_profiles")
    if profiles is not None:
        if provider not in {"azure_openai_web_search", "azure_openai_tavily"}:
            raise PublicProfilesChanged("Public profile discovery requires Azure consent")
        profiles = OwnerPublicProfiles.model_validate(profiles).model_dump()
        carried["public_profiles"] = profiles
    context = carried.get("research_context")
    if context is not None:
        context = OwnerResearchContext.model_validate(context).model_dump()
        if inputs is not None and "research_context" in inputs:
            if not refresh_completed or not set(context["confirmed"]) <= set(
                (inputs.get("owner_decisions") or {}).get("confirmed", [])
            ):
                raise PublicProfilesChanged("Confirmed research context requires explicit approval")
        carried["research_context"] = context
    same = (
        sorted((prior.get("public_profiles") or {}).get("urls", []))
        == sorted((profiles or {}).get("urls", []))
        and prior.get("research_context") == context
    )
    if inputs is not None and "research_context" in inputs and refresh_completed:
        # A live identical POST is an idempotent retry. Otherwise Update
        # approves a new discovery, even if its confirmed text is unchanged.
        if not (state and state["status"] == "pending" and manager.reusable(state)):
            same = False
    if not same and (
        not refresh_completed
        or (state and state["status"] == "pending" and manager.reusable(state))
    ):
        raise PublicProfilesChanged("Research inputs changed")
    return carried or None, same


def prepare_bound_inputs(state, binding):
    inputs = state.get("inputs")
    if inputs and state.get("resume_binding") and state["resume_binding"] != binding:
        # A different identity/policy binding cannot reuse an earlier
        # discovery's confirmed-context authorization.
        return {key: value for key, value in inputs.items() if key != "research_context"}
    return inputs
