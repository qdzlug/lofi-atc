PYTHON ?= python3
VENV   := .venv
BIN    := $(VENV)/bin
PORT   ?= 7331

.PHONY: help setup run test test-py test-js lint fmt check clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

setup: $(VENV)/.installed ## Create .venv with dev tools (pytest, ruff)

$(VENV)/.installed: pyproject.toml
	$(PYTHON) -m venv $(VENV)
	$(BIN)/pip install --upgrade pip
	$(BIN)/pip install -e '.[dev]'
	touch $@

run: ## Start the server and open the browser (no setup needed)
	$(PYTHON) -m lofi_atc --port $(PORT) --open

test: test-py test-js ## Run all tests

test-py: setup ## Run Python tests
	$(BIN)/pytest

test-js: ## Run frontend unit tests (needs Node 20+)
	node --test "tests/js/**/*.test.js"

lint: setup ## Lint Python
	$(BIN)/ruff check .
	$(BIN)/ruff format --check .

fmt: setup ## Auto-format Python
	$(BIN)/ruff check --fix .
	$(BIN)/ruff format .

check: lint test ## Everything CI runs

clean: ## Remove venv and caches
	rm -rf $(VENV) venv .pytest_cache .ruff_cache *.egg-info
	find . -name __pycache__ -type d -prune -exec rm -rf {} +
