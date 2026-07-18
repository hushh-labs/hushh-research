.PHONY: test lint typecheck format check all

# Default target runs all checks
all: format lint typecheck test

test:
	@echo "Running tests..."
	python -m pytest tests/

lint:
	@echo "Running Ruff linter..."
	python -m ruff check .

typecheck:
	@echo "Running Mypy type checker..."
	python -m mypy .

format:
	@echo "Formatting code with Ruff..."
	python -m ruff format .

check:
	@echo "Running all checks (lint + typecheck)..."
	python -m ruff check .
	python -m mypy .
