# Hushh Research -- Development Commands
# ========================================
# Usage: make <target>
# Run `make help` for available targets.

.PHONY: help bootstrap doctor dev local uat prod local-web uat-web prod-web local-backend stack web backend profile-use env-bootstrap lint test verify-docs ci-local db-init-iam verify-iam-schema check-main-sync sync-main

PROFILE ?= $(if $(ENV),$(ENV),local-uatdb)
MAIN_SYNC_REMOTE ?= origin
MAIN_SYNC_BRANCH ?= main

# === Help ==================================================================

help: ## Show this help
	@grep -h -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

# === Subtree Sync ==========================================================

ifneq ("$(wildcard consent-protocol/ops/monorepo/protocol.mk)","")
include consent-protocol/ops/monorepo/protocol.mk
endif

# === Runtime Profiles ======================================================

bootstrap: ## Canonical contributor bootstrap (deps + profile hydration + local doctor)
	@bash scripts/env/bootstrap.sh

doctor: ## Check whether a runtime profile is coherent and runnable (PROFILE=local-uatdb|uat-remote|prod-remote)
	@bash scripts/env/doctor.sh "$(PROFILE)"

dev: ## Canonical run command family entrypoint (PROFILE=local-uatdb|uat-remote|prod-remote)
	@$(MAKE) stack PROFILE="$(PROFILE)"

local: ## Start local frontend + local backend against UAT-backed resources
	@$(MAKE) stack PROFILE=local-uatdb

uat: ## Start local frontend pointed at deployed UAT backend
	@$(MAKE) stack PROFILE=uat-remote

prod: ## Start local frontend pointed at deployed production backend
	@$(MAKE) stack PROFILE=prod-remote

local-web: ## Start local frontend only with local-uatdb profile active
	@$(MAKE) web PROFILE=local-uatdb

uat-web: ## Start local frontend only with uat-remote profile active
	@$(MAKE) web PROFILE=uat-remote

prod-web: ## Start local frontend only with prod-remote profile active
	@$(MAKE) web PROFILE=prod-remote

local-backend: ## Start local backend only for local-uatdb
	@$(MAKE) backend PROFILE=local-uatdb

profile-use: ## Activate runtime profile into consent-protocol/.env and hushh-webapp/.env.local (PROFILE=local-uatdb|uat-remote|prod-remote)
	@bash scripts/env/use_profile.sh "$(PROFILE)"

stack: ## Launch the canonical stack for a runtime profile (PROFILE=local-uatdb|uat-remote|prod-remote)
	@bash scripts/runtime/launch_stack.sh "$(PROFILE)"

web: profile-use ## Activate runtime profile then start local frontend only
	cd hushh-webapp && npm run dev:next

backend: ## Activate runtime profile then start local backend only (local-uatdb only)
	@bash scripts/runtime/run_backend_local.sh "$(PROFILE)"

# === Quality ===============================================================

lint: ## Run all linters (backend + frontend)
	@echo "=== Backend (ruff) ==="
	cd consent-protocol && ruff check . && ruff format --check .
	@echo ""
	@echo "=== Frontend (eslint) ==="
	cd hushh-webapp && npm run lint

test: ## Run all tests (backend + frontend)
	@echo "=== Backend (pytest) ==="
	cd consent-protocol && pytest tests/ -v
	@echo ""
	@echo "=== Frontend (vitest) ==="
	cd hushh-webapp && npm test

verify-docs: ## Verify docs/runtime parity and route documentation truth
	node scripts/verify-doc-runtime-parity.cjs

ci-local: ## Full local CI simulation (mirrors GitHub Actions)
	./scripts/test-ci-local.sh

# === Environment Profiles ====================================================

env-bootstrap: ## Create/hydrate local runtime profiles from templates + cached/cloud config
	bash scripts/env/bootstrap_profiles.sh

db-init-iam: ## Apply IAM foundation migrations explicitly (020 + 021)
	cd consent-protocol && PYTHONPATH=. .venv/bin/python db/migrate.py --iam

verify-iam-schema: ## Verify IAM tables/templates readiness
	cd consent-protocol && PYTHONPATH=. .venv/bin/python scripts/verify_iam_schema.py

check-main-sync: ## Ensure current branch already contains the latest origin/main
	@MAIN_SYNC_REMOTE=$(MAIN_SYNC_REMOTE) \
	MAIN_SYNC_BRANCH=$(MAIN_SYNC_BRANCH) \
	sh scripts/git/check-main-sync.sh

sync-main: ## Fetch and merge the latest origin/main into the current branch
	@CURRENT_BRANCH=$$(git branch --show-current); \
	if [ -z "$$CURRENT_BRANCH" ]; then \
		echo "Detached HEAD detected; switch to a branch first."; \
		exit 1; \
	fi; \
	if [ "$$CURRENT_BRANCH" = "$(MAIN_SYNC_BRANCH)" ]; then \
		echo "Already on $(MAIN_SYNC_BRANCH); nothing to sync."; \
		exit 0; \
	fi; \
	echo "Fetching $(MAIN_SYNC_REMOTE)/$(MAIN_SYNC_BRANCH)..."; \
	git fetch $(MAIN_SYNC_REMOTE) $(MAIN_SYNC_BRANCH) --quiet; \
	echo "Merging $(MAIN_SYNC_REMOTE)/$(MAIN_SYNC_BRANCH) into $$CURRENT_BRANCH..."; \
	git merge $(MAIN_SYNC_REMOTE)/$(MAIN_SYNC_BRANCH)
