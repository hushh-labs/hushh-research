# ADK conformance recordings for specialist agents

Deterministic, model-free regression for the private agent's specialist agents,
built on ADK's own `RecordingsPlugin` / `ReplayPlugin` (google-adk 2.9.0).

A recording captures, per case, the exact sequence the agent produced: every
model request and response, every tool call and response. A replay feeds the
recorded model responses back and verifies, strictly, that the agent sends the
same model requests and the same tool calls. Once a recording exists, a change to
an instruction, a tool signature, a tool description or the roster shows up as a
`ReplayVerificationError` here, offline, instead of in front of a person.

## The rule: fixture information only

**No real person's records may enter a committed recording.**

A recording holds every model request verbatim, which means it holds whatever the
tools returned: profile fields, holdings, connections, messages. There is no
redaction step and none is planned; a recording is only useful if it is exact.
So the only safe input is fixture information, and the CLI enforces the moment of
decision: `record` refuses to run unless `--fixture-ack` is passed. Passing it is
an affirmation that every case in the run executes against fixtures. Review a new
or re-recorded `generated-recordings.yaml` with that rule in mind before it lands.

## Layout

Each case is a directory in the layout ADK's `adk conformance` tooling expects:

```
tests/conformance/<name>/
  cases.yaml                          the case list this suite records from
  <case_id>/
    spec.yaml                         TestSpec: description, agent, initial_state, user_messages
    generated-recordings.yaml         written by RecordingsPlugin (model + tool exchanges)
    generated-session.yaml            final session, used for event-by-event comparison
```

`cases.yaml` is a list (or `{cases: [...]}`) of:

```yaml
- id: greets_by_name            # becomes the directory name; [A-Za-z0-9][A-Za-z0-9_.-]{0,63}
  user_message: "hello there"
  state: {}                      # optional initial session state
  description: "one turn, no tools"   # optional, copied into spec.yaml
```

## Commands

```bash
cd consent-protocol

# Record (live model; fixture information only)
PYTHONPATH=. uv run python scripts/conformance_specialist.py record \
  --agent hushh_mcp.one_adk.agent_tree.build_one_text_agent \
  --cases tests/conformance/one_text/cases.yaml \
  --dir tests/conformance/one_text \
  --fixture-ack

# Replay (no model, no network); exit 1 on any failing case
PYTHONPATH=. uv run python scripts/conformance_specialist.py replay \
  --agent hushh_mcp.one_adk.agent_tree.build_one_text_agent \
  --cases tests/conformance/one_text/cases.yaml \
  --dir tests/conformance/one_text
```

`--agent` is a dotted path to a zero-argument factory returning an `LlmAgent`.
Re-recording a case removes its generated files first; `RecordingsPlugin`
otherwise appends to an existing file.

From a test, call the library function instead of the CLI:

```python
from scripts.conformance_specialist import replay_case

result = replay_case(agent_factory, Path("tests/conformance/one_text/greets_by_name"))
assert result.passed, result.error
```

`ReplayResult` carries `case_id`, `passed`, `error` (the ADK verification text),
`error_type` (`ReplayVerificationError`, `ReplayConfigError`, `SessionMismatch`,
or the crashing exception's class), `event_count` and `session_compared`.

## What replay does and does not do

- **The model is never called.** In replay ADK swaps the agent's model for a
  recording-fed stand-in. The agent still needs a model *object* because ADK
  reads its name into the request, and that name must equal the recorded one.
  `tests/test_conformance_harness.py` proves this with a model that raises if
  called.
- **Tools still execute.** `ReplayPlugin` runs every non-`AgentTool` tool and
  then discards the live result in favour of the recorded response. A tool that
  reaches a live backend will still reach it during replay, so specialist tools
  under conformance need fixture-backed or offline behaviour under `TESTING=1`.
- **Verification is strict.** Model requests are compared after ADK's own
  normalisation (schema titles, `labels`, `http_options` and
  `live_connect_config` are ignored); tool names and arguments must match
  exactly, in order, per agent. When `generated-session.yaml` exists the final
  events and session are also compared, with ids and timestamps excluded.
- **ADK wraps verification errors.** The plugin manager re-raises a failing
  callback as `RuntimeError`; the harness walks the cause chain so `error_type`
  still names the ADK error.

## Adding a suite

1. Create `tests/conformance/<name>/cases.yaml` with fixture-only cases.
2. Record with `--fixture-ack` against a fixture-backed runtime.
3. Review every `generated-recordings.yaml` for the rule above.
4. Add a test that calls `replay_case` for each case directory, so CI replays it.
