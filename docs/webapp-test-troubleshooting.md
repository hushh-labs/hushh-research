# Webapp Test Troubleshooting

## Visual Context

This guide helps troubleshoot common issues when running webapp tests locally, especially when `npm test` is run from the wrong directory.

## `npm test` fails with `ENOENT package.json````text
Could not read package.json
ENOENT: no such file or directory
```

you are likely running the command from the repository root instead of the webapp package directory.

## Correct Usage

Run webapp tests from:

```powershell
cd hushh-webapp
npm test -- <test-name>
```

Example:

```powershell
cd hushh-webapp
npm test -- financial-sources
```

## Quick Check

Before running webapp tests, confirm that `package.json` exists:

```powershell
dir package.json
```

Expected output should include:

```text
package.json
```

If the file is missing, move into the webapp folder first:

```powershell
cd hushh-webapp
```

## Common Mistake

Running tests from:

```text
hushh-research
```

instead of:

```text
hushh-research/hushh-webapp
```

will cause npm to fail because it cannot locate the webapp package configuration.

## Resolution Steps

1. Navigate to the webapp directory.
2. Verify `package.json` is present.
3. Run the desired test suite.
4. Confirm the test runner starts successfully.

Example:

```powershell
cd hushh-webapp
dir package.json
npm test -- financial-sources
```
