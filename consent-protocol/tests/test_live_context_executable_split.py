"""What the model is told about and what it may run are different questions.

The browser ranks its screen's actions and truncates the list, because a prompt
has a budget. That same truncated list was also the execution allowlist, so an
action that lost the ranking race came back `action_unavailable` -- the app
declining to do something it can plainly do, for a reason nobody could see. On
Location that was 18 of 52 actions, `location.create_circle` among them.

`executable_action_ids` carries the route's own declaration instead: uncapped,
server-derived from the generated route orchestration index, never
client-supplied. These tests pin the three properties that make widening it
safe -- it is route-scoped, it cannot be injected into, and a blocking layer
still bounds it.
"""

from __future__ import annotations

from api.routes.one.live_context import sanitize_live_context


def test_execution_is_not_bounded_by_the_prompt_budget() -> None:
    """A route's executable set does not shrink to what the prompt mentioned."""
    context = sanitize_live_context(
        {
            "route_family": "/one/location",
            # One id declared, as if everything else lost the ranking race.
            "available_action_ids": ["location.refresh"],
        }
    )

    assert context["available_action_ids"] == ["location.refresh"]
    executable = context["executable_action_ids"]
    assert len(executable) > 40, (
        "Location declares ~52 actions in the route index; an executable set "
        f"of {len(executable)} means it collapsed back to the prompt budget."
    )
    assert "location.create_circle" in executable, (
        "create_circle is the action this whole change exists for: it was "
        "dropped by the cap and then refused at execution."
    )


def test_the_executable_set_stays_scoped_to_the_route() -> None:
    """Uncapped is not the same as unbounded.

    A Location action must not become runnable because someone is standing on
    Profile. If this ever passes vacuously -- both sets empty -- the route
    index lookup is broken and the assertion below is meaningless, so the
    Location side is checked for content too.
    """
    profile = sanitize_live_context({"route_family": "/one/profile", "available_action_ids": []})
    location = sanitize_live_context({"route_family": "/one/location", "available_action_ids": []})

    assert location["executable_action_ids"], "Location resolved no actions at all"
    assert "location.create_circle" in location["executable_action_ids"]
    assert "location.create_circle" not in profile["executable_action_ids"]


def test_a_client_cannot_inject_into_the_executable_set() -> None:
    """The payload describes a screen; it does not get to name what may run."""
    context = sanitize_live_context(
        {
            "route_family": "/one/profile",
            "available_action_ids": ["not.a.real.action"],
            # A forged frame trying to hand itself authority directly.
            "executable_action_ids": ["location.delete_circle", "not.a.real.action"],
        }
    )

    assert "not.a.real.action" not in context["executable_action_ids"]
    assert "location.delete_circle" not in context["executable_action_ids"], (
        "The executable set must be derived from the route index, never read back from the payload."
    )


def test_a_blocking_layer_still_bounds_execution() -> None:
    """Widening the executable set must not become a way to act behind a modal."""
    open_modal = sanitize_live_context(
        {
            "route_family": "/one/location",
            "available_action_ids": ["location.refresh"],
            # Every field here is load-bearing: sanitize_interaction_layer
            # returns None unless layer_id, kind, modality, lifecycle_state and
            # agent_continuity are all present and valid. A partial layer is
            # silently discarded, which would make this test pass without ever
            # engaging the filter it claims to check.
            "interaction_layer": {
                "layer_id": "location-confirm-dialog",
                "kind": "dialog",
                "modality": "blocking",
                "lifecycle_state": "open",
                "agent_continuity": "interactive",
                "visible_action_ids": ["location.refresh"],
            },
        }
    )

    assert open_modal["interaction_layer"] is not None, (
        "The layer was discarded as malformed, so this test would pass "
        "without the blocking filter ever running."
    )
    executable = open_modal["executable_action_ids"]
    assert "location.create_circle" not in executable, (
        "A blocking layer bounds what may run, or the split reopens every "
        "action behind an open dialog."
    )
    assert set(executable) <= {"location.refresh"}
