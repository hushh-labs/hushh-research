"""The Agent One validation harness.

A harness that stubs the ADK ``Runner`` proves the runtime wrapper works and says
nothing at all about orchestration -- the thing it stubs out IS the thing under
test. This package inverts that: it scripts the *model* and runs the **real**
agent tree, so tool dispatch, AgentTool delegation, and context propagation are
genuinely exercised while costing no model quota and staying deterministic.

Modules:

* ``scripted_llm``  -- a ``BaseLlm`` whose turns are a script, recording what the
  tree actually asked for and what it actually did.
* ``journey``       -- runtime generation of diverse journeys from the live tool
  surface, rather than a static list of cases that ages into a lie.
* ``observers``     -- the ten recorded dimensions, each derived from real
  runtime signal rather than asserted.
* ``harness``       -- concurrent execution, result aggregation, failure
  clustering.
"""
