---
name: access-explained
description: Plain-English map of who can do what in Hushh's Google Cloud and GitHub, written for product and non-engineering people. Explains in tables why a deploy gets refused, why UAT is locked even for the boss, what each robot account is for, why logins keep expiring, and which error messages are actually normal. Use when someone asks "why can't I deploy", "do I have access", "what does this error mean", "who can approve this", or when a non-engineer needs to understand the access setup without reading the technical gcp-access skill.
---

# Access, explained without the jargon

This is the plain-English version. The technical version lives in `gcp-access`
(commands, exact role names) and `safe-changes` (rules for not breaking things).

Read this one if you want to **understand** the setup. Read those if you want to
**operate** it.

---

## First, four words you'll keep seeing

| Word | What it actually means |
|---|---|
| **Project** | A separate walled-off space in Google Cloud. Our app lives in a few of them. |
| **Service account** | A robot user. Not a person. Software logs in as these, not as humans. |
| **Impersonation** | Borrowing a robot's badge for one task. You stay you; you just act as the robot. |
| **Deny policy** | A "NO ENTRY" sign that beats every permission slip, including the CEO's. |

That last one is the single most misunderstood thing here, so it gets its own
section below.

---

## The three environments

Think of these as three copies of the same building.

| Name | Real project ID | What it's for | Who it hurts if broken |
|---|---|---|---|
| **Dev** | `hushh-pda-dev` | Messing around, trying things | Nobody |
| **UAT** | `hushh-pda-uat` | The rehearsal before going live | The team's testing |
| **Production** | `hushh-pda` | The real thing, real customers | **Customers** |

There are ~24 projects in total, but these three are the ones that matter day to day.

---

## The cast of characters

Not everyone here is a person. Two of them are robots, and that's on purpose.

| Who | Person or robot? | What they're for |
|---|---|---|
| `ankit@hushh.ai` | Person | Org admin. Can reach basically everything. |
| `gcp-admins@hushh.ai` | A group of people | The admin club. Membership *is* the access. |
| `developers@hushh.ai` | A group of people | Engineers. 10 members, can read every password we store. |
| `claude-code-gcp-operator` | 🤖 Robot | The badge Claude borrows to do work on this laptop. |
| `github-actions-uat-deployer` | 🤖 Robot | **The only one allowed to deploy to UAT.** Nobody else. Not even admins. |

**The thing people get wrong:** access here comes from being *in a group*, not from
your name being written on a project. If you look someone up directly, you'll see
nothing and conclude they have no access. They probably do — through a group.

---

## Why "even the boss can't deploy to UAT"

This surprises everyone, so here it is plainly.

UAT has a NO ENTRY sign on it called **`uat-deploy-authority-lock`**, put up on
**3 May 2026**. It says: *nobody deploys here directly.* And "nobody" genuinely means
nobody — org owners included.

| | Can deploy straight to UAT? |
|---|:---:|
| A random engineer | ❌ |
| Ankit (org admin) | ❌ |
| Kushal (org admin) | ❌ |
| Claude | ❌ |
| 🤖 `github-actions-uat-deployer` | ✅ **only this one** |

In Google Cloud, a "NO ENTRY" sign always wins over a "please let them in" note.
You cannot out-rank it. You can only be the one robot it was written to exclude.

**This is a feature, not a bug.** It means every UAT deploy goes through the same
reviewed, logged pipeline. No one can quietly hand-push something at 11pm.

Production, by contrast, has **no such lock**. Read that sentence again — the
rehearsal room is locked tighter than the live stage. That is worth a conversation
someday, but it is the current reality.

---

## So how does anything ever reach UAT?

Two legitimate doors. Both end up as the same robot.

| Door | What you do | When to use |
|---|---|---|
| **The normal one** | Trigger the GitHub workflow | Almost always |
| **The side door** | Borrow the deploy robot's badge | Emergencies, when GitHub is down |

The normal one, in practice, is a single command an engineer runs:

```
gh workflow run deploy-uat.yml --repo hushh-labs/hushh-research \
  --ref main -f scope=auto -f sha=<the-commit>
```

The side door does the same job but skips GitHub. It still gets logged as the robot,
so the audit trail survives. It is not a way around the rules — it is the rules,
taken manually.

---

## "Is it broken?" — a translation table

Most scary-looking messages here are normal. This table is the point of this document.

| What you see | Is it broken? | What's really happening |
|---|:---:|---|
| Permission denied deploying to UAT | ✅ Normal | The NO ENTRY sign. Use the workflow. |
| Permission denied deploying to **prod** | ⚠️ Real | Prod has no lock. Something else is wrong. |
| "Failed to impersonate…" right after a permission change | ✅ Normal | Google takes ~1 minute to catch up. Wait, retry. |
| Someone shows zero permissions when you look them up | ✅ Normal | Their access comes via a group. Check the group. |
| A permissions list looks generous but things still fail | ✅ Normal | Lists ignore NO ENTRY signs. The list is lying. |
| "Reauthentication required" for the tenth time | 😤 Known | See the next section. |
| Deploy succeeded but the site looks unchanged | ⚠️ Real | Probably reading the wrong version. Ask an engineer. |

---

## Why you keep getting logged out

The honest answer, because this wastes real hours.

Google limits how many active logins one person can have through one tool. The
`gcloud` tool uses **one shared door for every user on earth**. So each time you log
in somewhere new, one of your older logins silently dies.

Result: you fix it on your laptop, and it breaks on your other machine. Fix that one,
the laptop breaks. Forever.

| Approach | Stops the loop? | The catch |
|---|:---:|---|
| Just log in again | ❌ | You're back in 3 days. |
| Borrow a robot badge (current setup) | ⚠️ Partly | Still dies when your own login dies. |
| Put a robot's permanent key on the laptop | ✅ Yes | A file that never expires = permanent full access, on a laptop. |

The permanent key genuinely fixes it. It is also the riskiest option, which is why it
is **not** currently in use on this machine and should be a deliberate decision, not a
convenience choice.

---

## The uncomfortable bits

Not problems to fix today. Things a product owner should simply *know*.

| Situation | Why it matters |
|---|---|
| **7 permanent keys exist** for the Claude robot, spread over 4 setup sessions, 4 of which never expire | Each one is a full-access copy sitting on somebody's disk. Nobody knows where they all are. |
| **10 people can read every stored password**, incl. 4 personal Gmail accounts and 1 external company address | That's the `developers@hushh.ai` group. Wide by default. |
| **Group owners can add members silently** | Someone can gain full access without it showing up in any permission audit. |
| **`abdul.zalil@gmail.com` is an owner** of the project holding the Claude robot | A project owner can mint new keys for that robot at will. |
| **Production has no deploy lock, UAT does** | The environment that can hurt customers is the less protected one. |

---

## Who to ask

| You need | Ask |
|---|---|
| Access to something | Whoever owns `gcp-admins@hushh.ai` |
| A UAT deploy | Any engineer — it's one command |
| A production deploy | Follow the release process. Never freelance this. |
| "Is this error normal?" | The translation table above, then an engineer |

---

## Related

- `gcp-access` — the technical version: exact commands, role names, traps
- `safe-changes` — rules written after real incidents; read before touching config
- `hushh-research-ship` — how code actually gets to main and to UAT
- `deploy-uat` — the deploy command and why dispatches sometimes vanish
