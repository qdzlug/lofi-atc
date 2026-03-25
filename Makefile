PYTHON ?= python3
VENV   := venv
BIN    := $(VENV)/bin
PORT   := 7331

.PHONY: help setup run clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

setup: $(VENV)/bin/activate ## Create venv and install deps

$(VENV)/bin/activate: requirements.txt
	$(PYTHON) -m venv $(VENV)
	$(BIN)/pip install --upgrade pip
	$(BIN)/pip install -r requirements.txt
	touch $(VENV)/bin/activate

run: setup ## Start the server (opens browser on macOS)
	$(BIN)/python lofi-atc-server.py

clean: ## Remove venv
	rm -rf $(VENV)
