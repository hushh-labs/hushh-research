"""Shared real AG-UI/ADK streaming harness; no product implementation."""

from ag_ui.core import RunAgentInput, UserMessage
from google.adk.apps import App
from google.adk.sessions import InMemorySessionService

from hushh_mcp.one_adk.agui_turn_timing import HEAD_ONE, TimedADKAgent
from hushh_mcp.one_adk.request_secrets import store_request_secret


async def run_agent_chat(root, observe=None, *, owner="owner", thread="thread", extra_state=None):
    sessions = InMemorySessionService()
    bridge = TimedADKAgent.from_app(
        App(name="search_answer_contract", root_agent=root),
        head=HEAD_ONE,
        user_id_extractor=lambda _input: owner,
        session_service=sessions,
        use_in_memory_services=True,
        use_thread_id_as_session_id=True,
    )
    state = {"hussh:user_id": owner, "hussh:consent_token": store_request_secret("synthetic")}
    state.update(extra_state or {})
    run = RunAgentInput(
        thread_id=thread,
        run_id="run",
        state=state,
        context=[],
        forwarded_props={},
        tools=[],
        messages=[UserMessage(id="m", role="user", content="Find and cite the public source.")],
    )
    events = []
    async for event in bridge.run(run):
        events.append(event)
        if observe is not None:
            await observe(event)
    session = await sessions.get_session(
        app_name="search_answer_contract", user_id=owner, session_id=thread
    )
    return events, session
