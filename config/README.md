# Config Directory

This directory contains configuration files and data lists used across the project.

## Contents

- `available_models.txt` - Approved Gemini 3 text models for agentic and bounded workloads
- `ci-governance.json` - Canonical branch, merge queue, protected pipeline, and deploy-environment governance policy
- `runtime-topology-maintenance.json` - Authored semantic-route, compatibility, retirement, and maintenance-profile metadata for the generated runtime topology index

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
