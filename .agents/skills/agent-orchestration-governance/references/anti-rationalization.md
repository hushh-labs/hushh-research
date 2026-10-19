# agent-orchestration-governance — Anti-Rationalization Table

| Rationalization | Reality |
|---|---|
| "This agent needs the full skill text in its prompt" | "Duplicating broad skill guidance into agent files instead of keeping agents thin" — agents are thin evidence lanes; skills stay the single source. Duplication forks the contract. |
| "Pin the model so the agent is reproducible" | "Pinning model and reasoning in baseline agent files instead of inheriting the parent runtime choice" — the parent runtime owns model selection; pinning creates silent staleness. |
| "Write access would make this agent so much more useful" | "Making wave-1 custom agents write-capable without an explicit need and review" — read-only is the default for a reason: evidence lanes that write become second decision-makers (Doctrine #5). |
| "Depth 2 would let the agent handle its own subtasks" | "Raising max_depth above 1 without proving the recursion need" — recursion multiplies drift and cost; the need is proven first, not assumed. |
| "The child agent verified it, so it's decided" | "Letting child agents self-authorize merge, deploy, or governance outcomes" — children return evidence; the parent or governor decides. Always. |
| "I'll add the manifest now and the workflow pack later" | "Adding a skill manifest without a matching workflow pack or docs discoverability update" — undiscoverable lanes are dead lanes that still cost audit surface. |
| "The validator can be wired in a follow-up" | "Failing to wire the orchestration validator into the existing governance path" — an unwired validator validates nothing; wiring IS the task. |

## Red Flags

- An agent TOML whose developer_instructions restate a SKILL.md section
- A new agent with write access and no recorded need/review
- A child handoff that contains a decision ("merge it", "safe to deploy") instead of classified evidence
- max_depth > 1 anywhere without a written recursion justification
