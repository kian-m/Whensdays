# clSandbox — one entrypoint for the polyglot monorepo.
# JS side via pnpm; Go side via the go toolchain; everything orchestrated here.
.PHONY: help install dev dev-api dev-web build test e2e e2e-update fmt lint up down clean generate db-up db-down migrate migrate-down scan-secrets install-hooks

DATABASE_URL ?= postgres://clsandbox:clsandbox@localhost:5432/clsandbox?sslmode=disable
GOOSE = go run github.com/pressly/goose/v3/cmd/goose@latest -dir apps/api/db/migrations postgres "$(DATABASE_URL)"

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## Install all deps (pnpm + go modules + playwright browsers)
	pnpm install
	cd apps/api && go mod tidy
	cd e2e && pnpm exec playwright install --with-deps chromium

generate: ## Regenerate type-safe Go from SQL (sqlc)
	cd apps/api && go run github.com/sqlc-dev/sqlc/cmd/sqlc@latest generate

db-up: ## Start the local Postgres container
	docker compose up -d db

db-down: ## Stop the local Postgres container
	docker compose stop db

migrate: ## Apply DB migrations (goose up)
	$(GOOSE) up

migrate-down: ## Roll back the last migration (goose down)
	$(GOOSE) down

scan-secrets: ## Scan the repo + full git history for leaked secrets (gitleaks, Docker)
	docker run --rm -v "$(PWD)":/repo -w /repo zricethezav/gitleaks:latest detect \
		--source=/repo --config=/repo/.gitleaks.toml --redact --verbose

og-card: ## Regenerate the shared Open Graph share-card image (apps/web/public/og-card.png)
	docker run --rm -v "$(PWD)":/work -w /work mcr.microsoft.com/playwright:v1.49.1-jammy \
		sh -c "npm i --no-save @playwright/test@1.49.1 --no-audit --no-fund >/dev/null 2>&1 && node scripts/gen-og-card.mjs"

install-hooks: ## Enable the local pre-commit secret guard (.githooks/pre-commit)
	git config core.hooksPath .githooks
	chmod +x .githooks/pre-commit
	@echo "✓ pre-commit secret scan enabled"

dev: ## Run api + web with hot reload (two processes)
	@$(MAKE) -j2 dev-api dev-web

dev-api: ## Run the Go api (expects `make db-up` + `make migrate` first)
	cd apps/api && DATABASE_URL="$(DATABASE_URL)" go run .

dev-web: ## Run the Vite dev server
	pnpm dev:web

build: ## Build web bundle + api binary
	pnpm build:web
	cd apps/api && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/api .

test: ## Run unit tests (go) + typecheck (web)
	cd apps/api && go test ./...
	pnpm typecheck

e2e: ## Run Playwright visual end-to-end tests (needs local toolchains)
	pnpm e2e

# NOTE: down -v must run even when the suite fails — a leaked DB volume feeds
# the next run's "fresh" pass with stale events and cascades into bogus failures.
e2e-docker: ## Run the FULL e2e in containers — only Docker required, nothing else installed
	docker compose -f compose.e2e.yaml up --build --abort-on-container-exit --exit-code-from e2e; \
	ec=$$?; docker compose -f compose.e2e.yaml down -v; exit $$ec

docs-shots: ## Regenerate README feature screenshots from the live app (Docker only)
	docker compose -f compose.docs.yaml up --build --abort-on-container-exit --exit-code-from shots
	docker compose -f compose.docs.yaml down -v

e2e-update: ## Refresh visual baselines (review diffs before committing!)
	cd e2e && pnpm run update-snapshots

fmt: ## Format Go + JS/TS
	cd apps/api && go fmt ./...

lint: ## Vet Go code
	cd apps/api && go vet ./...

up: ## Build and run the full containerized stack
	docker compose up --build

down: ## Stop the stack
	docker compose down

clean: ## Remove build/test artifacts
	rm -rf apps/web/dist apps/api/bin e2e/test-results e2e/playwright-report
