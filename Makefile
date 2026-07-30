# Repo-level task shortcuts.
#
# The canonical implementations live in scripts/ and package.json; these targets
# are thin, discoverable entry points.

.PHONY: help ios-prod-release ios-prod-release-dry

help: ## List available targets
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-24s\033[0m %s\n", $$1, $$2}'

# One reliable production App Store release command.
#   make ios-prod-release                      # prepare-only (no public submit), SHA=origin/main
#   make ios-prod-release ARGS="--dry-run"     # archive + sign only, no upload
#   make ios-prod-release ARGS="--sha <sha>"   # pin an explicit green SHA
#   make ios-prod-release ARGS="--submit --ack-blockers"   # IRREVERSIBLE public submit
# See docs/guides/mobile/release-ios-appstore.md for the full runbook.
ios-prod-release: ## Build → sign → upload → prepare the production iOS App Store release
	node scripts/release/dispatch-ios-appstore.mjs $(ARGS)

ios-prod-release-dry: ## Dry run: archive + sign on the runner, no upload / no ASC changes
	node scripts/release/dispatch-ios-appstore.mjs --dry-run $(ARGS)
