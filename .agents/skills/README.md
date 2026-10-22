# Hussh portable skills

`.agents/skills/` is the authored source shared by every supported coding-agent host.
Governed owners/spokes retain their `skill.json` and workflow contracts; portable
practices retain their supporting resource trees and explicit classification.
Codex discovers this directory directly. Claude's native discovery directories are
checked relative links to these sources; do not copy procedures or frontmatter.

| Skill | Canonical behavior | Claude discovery link |
| --- | --- | --- |
| Verify before claim | [verify-before-claim](./verify-before-claim/SKILL.md) | `.claude/skills/verify-before-claim/` |
| Context refresh | [context-refresh](./context-refresh/SKILL.md) | `.claude/skills/context-refresh/` |
| Animation vocabulary | [animation-vocabulary](./animation-vocabulary/SKILL.md) | `.claude/skills/animation-vocabulary/` |
| UI library lookup (explicit invocation) | [pick-ui-library](./pick-ui-library/SKILL.md) | `.claude/skills/pick-ui-library/` |
| Portable PDF artifacts | [pdf-artifact-generation](./pdf-artifact-generation/SKILL.md) — including monthly executive calendar reports | `.claude/skills/pdf-artifact-generation/` |

Author changes here, then use the existing adapter generator to check native links.
`skill_lint.py` verifies canonical sources and discovery without a second skill copy.
Host invocation adapters belong in [adapters](../adapters/README.md); they do not
create another policy or subagent fleet.

Additional shared practices (each has a Claude discovery link):

- [animate](./animate/SKILL.md)
- [apple-design](./apple-design/SKILL.md)
- [brandkit](./brandkit/SKILL.md)
- [client-env-parity](./client-env-parity/SKILL.md)
- [emil-design-eng](./emil-design-eng/SKILL.md)
- [find-animation-opportunities](./find-animation-opportunities/SKILL.md)
- [imagegen-frontend-mobile](./imagegen-frontend-mobile/SKILL.md)
- [imagegen-frontend-web](./imagegen-frontend-web/SKILL.md)
- [improve-animations](./improve-animations/SKILL.md)
- [industrial-brutalist-ui](./industrial-brutalist-ui/SKILL.md)
- [prototype](./prototype/SKILL.md)
- [review-animations](./review-animations/SKILL.md)
- [stitch-design-taste](./stitch-design-taste/SKILL.md)

Optional design practices inherit the existing design-system owner; invocation does not
authorize a new design system, dependencies, invented claims, or extra deliverables.

Governed owner/spoke discovery: `./bin/hushh codex scan section skills`.

Additional reviewed practices: [Profile typography](profile-ui/SKILL.md) and
[concise interface copy](less-text-karma-ji/SKILL.md).
