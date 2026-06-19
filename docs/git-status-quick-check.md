## Visual Map

```mermaid
flowchart TD
  A[Check branch] --> B[Check working tree]
  B --> C[Review diff]
  C --> D[Commit with signoff]
  D --> E[Push branch]