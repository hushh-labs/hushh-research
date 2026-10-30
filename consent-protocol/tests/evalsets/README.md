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
