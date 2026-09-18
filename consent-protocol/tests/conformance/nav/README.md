# Nav and Consent conformance

These two real Gemini 3.8 Flash recordings cover active location sharing and
revoked sharing history. They were recorded on 2026-09-15 through the managed
Vertex bridge `hushh-vertex-personal54`, location `global`, using the production
`build_nav_agent` factory and its authored low-thinking configuration.

Only synthetic information enters these recordings: `conformance_fixture_user`,
`fixture-grant`, and `Fixture Alex`. Authorization validation and
`ConsentCenterService.list_center` are fixture-backed; the model responses are
real. No production records, owner credentials, or database calls are involved.

Run `python -m pytest tests/test_nav_conformance.py` from `consent-protocol`.
The test uses a refusing model and socket guard. It replays both parent and child
LLM requests, leaf tools, and complete outer session events/state. A deterministic
adapter test also rejects altered child tool arguments and recorded responses.

ADK 2.9's stock plugins do not support this nested shape completely: AgentTool
filters `_adk*` state, recordings use the same file for each invocation, and replay
skips AgentTool execution (losing its actions and state propagation). The
test-local adapters in `test_nav_conformance.py` forward only the plugin config,
retain distinct-agent recordings, and execute the original AgentTool with replay
models. No application state or golden actions are synthesized. These adapters
support this sequential two-agent fixture, not arbitrary concurrent graphs or
repeated invocations of the same child. Revisit them when upgrading ADK.

To regenerate, import `CASES`, `fixture_boundary`, `fixture_agent`, and
`NestedRecordingsPlugin` from the test module; patch the conformance harness's
`RecordingsPlugin` to that adapter and call `record_case` for each case with the
managed model explicitly selected as `gemini-3.8-flash`. Assert the managed model's
project is `hushh-vertex-personal54` and location is `global` before calling it.
Use a 120-second bound per case. Review fixture contents, then replay offline.

This proves the fixture trajectories, not overall accuracy, latency, Connections
dispatch, the public A2A wrapper, or deployed behavior. Original parent-only
recording attempts remain in ignored `tmp/nav-conformance-20260916/` as evidence.
