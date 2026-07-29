# GitHub Workflows Overview

## Visual Map

CI → PR → Build → Test → UAT → Production

## CI Pipeline
- ci.yml → CI checks

## Deployment
- deploy-uat.yml
- deploy-production.yml

## Validation
- queue-validation.yml
- main-post-merge-smoke.yml

## Notes
- GitHub Actions automation pipeline
