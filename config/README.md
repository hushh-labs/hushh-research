# Config Directory

This directory contains configuration files and data lists used across the project.

## Contents

- `available_models.txt` - List of available Gemini 3 models
- `ci-governance.json` - Canonical branch, merge queue, protected pipeline, and deploy-environment governance policy

## Usage

These files are typically referenced by:
- Development scripts (`scripts/`)
- Documentation
- CI/CD workflows

Model policy:
- `available_models.txt` is intentionally Gemini 3 only.

## Adding New Config Files

When adding new configuration files:
1. Place them in this directory
2. Document their purpose in this README
3. Update any scripts/docs that reference them
