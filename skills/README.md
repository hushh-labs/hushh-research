# Hussh portable skills

`skills/` is the behavior source of truth shared by every supported coding-agent host.
Platform folders contain discovery bridges only; they must point here instead of copying
procedures that can drift.

| Skill | Canonical behavior | Platform bridges |
| --- | --- | --- |
| Verify before claim | [verify-before-claim](./verify-before-claim/SKILL.md) | `.claude/skills/verify-before-claim/` |
| Context refresh | [context-refresh](./context-refresh/SKILL.md) | host discovery only where installed |
| Animation vocabulary | [animation-vocabulary](./animation-vocabulary/SKILL.md) | `.claude/skills/animation-vocabulary/` |
| UI library lookup (explicit invocation) | [pick-ui-library](./pick-ui-library/SKILL.md) | `.claude/skills/pick-ui-library/` |
| Portable PDF artifacts | [pdf-artifact-generation](./pdf-artifact-generation/SKILL.md) — including monthly executive calendar reports | `.codex` governed pointer; `.claude/skills/pdf-artifact-generation/` |

For a platform bridge, copy the canonical frontmatter verbatim, then instruct the host to
read the canonical file. Do not put behavioral rules, renderers, asset bundles, or tokens
inside a bridge.

The enforced bridge body is `Read` followed by the backtick-quoted canonical
`skills/<name>/SKILL.md` path and `and follow it.`. Keep the frontmatter identical.
`skill_lint.py` validates existing twins on both hosts and dangling canonical
pointers; it does not require every host to install every skill.

Additional shared practices (each has a Claude discovery bridge):

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
