## Summary

<!-- 1-3 bullet points describing what this PR does -->

## Type

<!-- Check one -->
- [ ] Bug fix
- [ ] Feature (new agent, operon, endpoint)
- [ ] Enhancement (existing functionality)
- [ ] Documentation
- [ ] Refactor (no behavior change)

## Checklist

### Required for all PRs
- [ ] `./bin/consent-protocol ci` passes, or the equivalent individual checks are listed below
- [ ] Commits are signed off (`git commit -s`)
- [ ] No secrets, tokens, raw user data, vault material, or plaintext PKM were added
- [ ] First-party changes remain Apache-2.0 compatible
- [ ] Third-party notice impact was reviewed if dependencies changed

### Impact map
- [ ] API route or response contract changed
- [ ] Database migration or release manifest changed
- [ ] Agent, tool, or operon contract changed
- [ ] Consent scope, vault boundary, or PKM behavior changed
- [ ] Documentation updated with exact files listed below
- [ ] None of the above

### If adding/modifying agents or tools
- [ ] Consent is validated at agent entry (`HushhAgent.run()`)
- [ ] Consent is validated at each tool invocation (`@hushh_tool`)
- [ ] Agent manifest (`agent.yaml`) is created/updated
- [ ] Documentation updated in `docs/reference/agent-development.md`

### If adding/modifying operons
- [ ] Purity classification is correct (PURE vs IMPURE)
- [ ] IMPURE operons validate consent before user data access
- [ ] Tests cover the new operon
- [ ] Operon catalog updated in `docs/reference/agent-development.md`

### If adding/modifying API routes
- [ ] Service layer is used (no direct DB access from routes)
- [ ] Route documented in API contracts
- [ ] Tests cover the new endpoint

### If modifying database schema
- [ ] SQL migration file added in `db/migrations/`
- [ ] `db/release_migration_manifest.json` updated
- [ ] Relevant docs updated, such as `docs/reference/personal-knowledge-model.md`

## Testing

<!-- How was this tested? -->

## Related Issues

<!-- Link related issues: Fixes #123, Relates to #456 -->
