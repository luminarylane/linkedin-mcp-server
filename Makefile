# Makefile for LinkedIn MCP Server development

.PHONY: help install build dev test lint format typecheck check clean ci-local

help: ## Show this help message
	@echo "Usage: make [target]"
	@echo ""
	@echo "Available targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-15s %s\n", $$1, $$2}'

install: ## Install dependencies
	npm install

build: ## Build TypeScript to dist/
	npm run build

dev: ## Run in dev mode (tsx, no build needed)
	npm run dev

test: ## Run tests
	npm test

lint: ## Run prettier check
	npx prettier --check .

format: ## Format code with prettier
	npx prettier --write .

typecheck: ## Type check with tsc
	npx tsc --noEmit

check: format typecheck test ## Run all checks (format, typecheck, test)

clean: ## Remove build artifacts
	rm -rf dist/

ci-local: ## Run CI checks locally (matches GitHub Actions)
	npm ci
	npx prettier --check .
	npx tsc --noEmit
	npm test
