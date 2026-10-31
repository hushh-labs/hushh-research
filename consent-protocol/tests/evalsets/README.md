# ADK EvalSets for the private agent

Standard [ADK evaluation](https://google.github.io/adk-docs/evaluate/) records
that sit beside the repo's own first-tool KPI harness,
`scripts/eval_one_first_tool.py`, whose cases live in
`scripts/eval_cases/one_first_tool.v1.json`. The harness measures one thing,
the FIRST tool One reaches for on a single-turn prompt, by calling the model
directly with One's real tool declarations. These EvalSets express the
harness's `consent` family (13 cases) in ADK's `EvalSet` schema so the same
questions can be scored by `AgentEvaluator` against the fully built agent,
tools and runner included.

| File | Purpose |
|---|---|
| `one_consent.evalset.json` | One `EvalCase` per `consent`-family fixture case. One user `Invocation` each; `intermediate_data.tool_uses` holds the expected first tool as a `FunctionCall` with empty `args` (for a `run_app_action:<id>` expectation, `run_app_action` with `{"action_id": "<id>"}`). The no-tool case (`no_tool` in the fixture) carries an empty trajectory and a reference `final_response`. |
| `test_config.json` | `{"criteria": {"tool_trajectory_avg_score": 1.0}}`. `AgentEvaluator` reads it from the folder of the EvalSet file. A threshold of 1.0 means a single wrong tool fails the case. |

Follow-up turns live in `scripts/eval_cases/one_first_tool_turns.v2.json`.
`scripts/eval_one_turn_replay.py` replays each case's earlier turns through
the encrypted session codec, ADK's contents builder and One's before-model
history hygiene, so only the final prompt is graded; v1 loaders refuse that
schema. A case may add argument rules per expected tool (`required`,
`nonempty_any`). The right tool without them grades as `<tool>:args_incomplete`,
a named miss, and a wrong tool keeps its own name.

`scripts/eval_one_azure_first_tool.py` scores the follow-ups (default) or both
suites (`--suite all`) on the managed Azure root that UAT serves. It sends:

- the exact admitted deployment and settings;
- the managed head's own tool declarations;
- production Chat's thinking policy;
- ADK's identity line;
- a streamed call.

The harness grader scores the result. Calls are paced like the harness's live
probe because the deployment also serves UAT. An outage stops every later case,
and a model's own undeclared or malformed tool call grades as
`invalid_tool_call`, a miss. A live run needs the environment's managed Azure
identity; offline tests stub the model.

These differences from production remain:

- `typed_chat` composes without the owner keys that production's
  `_extract_state` always sets (PKM context, screen context, timezone). The
  graded instruction therefore lacks the "NO OWNER INFORMATION THIS TURN" block
  and the dated clock line. Closing this needs a versioned owner context derived
  from that function, with a frozen clock.
- 64 of the 76 v1 first turns use the empty surface, while production Chat
  always runs typed chat.
- Earlier answers replay without the provider-encrypted reasoning item that UAT
  stores beside them, which cannot be faked for a live call.
- A device receipt result is folded into its call's invocation. Production
  answers in a new invocation that it marks private. For these cases both give
  the same graded wire.

Where a fixture case accepts more than one first tool, the EvalSet pins the
fixture's primary (first-listed) tool, which is always the read-first path
(`list_active_grants` before `consent.revoke`, and so on).
`tests/test_evalsets_are_valid.py` loads the fixture through the harness's own
`load_cases` / `select_cases` and checks that the prompt sets are identical and
that every pinned tool is one the fixture accepts, so the two never drift
silently.

## Tiers

- **Offline (pytest, no model):** `tests/test_evalsets_are_valid.py` validates
  shape only. Every `*.evalset.json` loads through `EvalSet.model_validate`,
  eval ids are unique, every expected tool name exists on One's built roster
  (`build_one_text_agent` under `TESTING=1`), `test_config.json` carries a
  `tool_trajectory_avg_score` threshold, and the consent EvalSet mirrors the
  harness fixture. No model, no ADC, no network. It gates a PR only once it
  is listed in `scripts/test-ci.manifest.txt`; `scripts/run-test-ci.sh` runs
  manifest files and merely collects the rest.
- **Tier T3 (live, founder session):** the EvalSet runs through
  `AgentEvaluator` against the real agent and a real model. This needs Vertex
  ADC in the shell (`gcloud auth application-default login`) and the project
  that hosts the model. It is never run in CI.

## Running Tier T3

`AgentEvaluator` loads the agent by importing a module that exposes
`root_agent` (or has an `agent` member that does). The repo ships no such
module on purpose; register one in-process from One's real builder:

```bash
cd consent-protocol
GENAI_GOOGLE_CLOUD_PROJECT=<project> GOOGLE_GENAI_USE_VERTEXAI=true \
PYTHONPATH=. uv run python - <<'PY'
import asyncio
import sys
import types

from google.adk.evaluation.agent_evaluator import AgentEvaluator
from hushh_mcp.one_adk.agent_tree import build_one_text_agent

shim = types.ModuleType("one_eval_agent")
shim.root_agent = build_one_text_agent()
shim.agent = shim
sys.modules["one_eval_agent"] = shim

asyncio.run(
    AgentEvaluator.evaluate(
        agent_module="one_eval_agent",
        eval_dataset_file_path_or_dir="tests/evalsets/one_consent.evalset.json",
        num_runs=4,
    )
)
PY
```

Do not set `TESTING` for a live run: under `TESTING` the builder resolves the
model to a bare name instead of a Vertex-backed model. Pass the file path, not
the directory. `AgentEvaluator.evaluate` only discovers `*.test.json` when
handed a directory, and the EvalSet suffix here is `.evalset.json` so that the
offline test and the live runner never disagree about which files are eval
records. Expect run-to-run variance even at temperature 0 and 429s from Vertex
on back-to-back runs, exactly as the harness docstring records; `num_runs=4`
is a deliberate step above the harness default of two reps per case.

## What the live score does and does not say

- The default criterion is an EXACT trajectory match: the whole turn's tool
  calls, names and arguments, must equal the expected list. The harness KPI is
  only the first tool. A turn in which One calls the right tool first and then
  a second one, or passes arguments (`discover_person_information` needs a
  `person`), scores 0 under EXACT. To score the harness KPI rather than the
  full turn, switch the criterion for that run to in-order matching and fill in
  the arguments the case pins:

  ```json
  {"criteria": {"tool_trajectory_avg_score": {"threshold": 1.0, "match_type": "IN_ORDER"}}}
  ```

  In-order matching still compares arguments, so cases whose first tool takes
  free text (`ask_consent_agent`) cannot be pinned exactly; the harness remains
  the authority for those.
- Arguments are compared with plain equality, and the expected records pin
  `args: {}`. ADK builds the actual `FunctionCall` straight from the model's
  response part, so if the runtime records a no-argument call with `args`
  absent (`None`) rather than `{}`, even the no-argument cases
  (`list_active_grants`, `list_pending_information_requests`, ...) score 0.
  This has not been observed live yet. On the first live run, if every
  no-argument case fails with the right tool name in the actual trajectory,
  that is the cause: drop the `args` key from those expected records (or pin
  `null`) rather than reading it as a routing regression.
- No `session_input` is provided. The live tools run without a person's vault
  context, so their responses are error records; that is fine for a first-tool
  measurement and wrong for anything downstream of it.
- The harness's measured baseline (2026-09-13) was 52/52 correct first tool on
  the revised instruction. That number was produced by the harness, not by this
  EvalSet; do not quote it as an ADK score until an ADK run has produced one.

## Adding a case

Add it to `scripts/eval_cases/one_first_tool.v1.json` under `"family":
"consent"` first (`expected` lists the accepted first tools; `no_tool` means
the private agent answers directly), then mirror it here with a new unique
`eval_id`, pinning the first-listed expected tool. The offline test fails if
the two prompt sets differ, if a prompt appears twice, or if the pinned tool
is not one the fixture accepts. The EvalSet is hand-mirrored today rather than
generated from the fixture; the drift guard is what makes that safe.
