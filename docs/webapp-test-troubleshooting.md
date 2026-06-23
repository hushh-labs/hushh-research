\# Webapp Test Troubleshooting



\## `npm test` fails with `ENOENT package.json`



If `npm test` shows an error like:



```text

Could not read package.json

ENOENT: no such file or directory

```



you are likely running the command from the repository root instead of the webapp package directory.



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



\## Quick check



Before running webapp tests, confirm `package.json` exists:



```powershell

dir package.json

```



If the file is missing, move into the webapp folder first.



