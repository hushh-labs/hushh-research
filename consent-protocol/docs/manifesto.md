# 🌱 The Hushh Manifesto

> Consent is not a checkbox.  
> It’s a contract, a signal, and a programmable boundary.


## Visual Context

Canonical visual owner: [consent-protocol](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

---

## 🧠 Why We Exist

HushhMCP was built to give **humans control over their data** in an AI-powered world.

Most AI agents today are trained to maximize engagement, extract value, or serve the platform.  
**We believe agents should serve the person** — and only when asked to.

That’s why we built a programmable trust layer that:

- Requires explicit permission from the user
- Can be verified cryptographically
- Can be revoked instantly
- Can’t be faked

---

## 🔐 Design Principles

### 1. **Consent is First-Class**

Agents do nothing until permission is granted.  
We use **signed tokens** and **scoped access** — not vague “I agree” buttons.

### 2. **Trust Must Be Programmable**

We enable **delegation of access** through verifiable TrustLinks, not hardcoded relationships.  
One agent can trust another, but only within defined scopes and durations.

### 3. **Data is Vaulted**

All sensitive information is encrypted using AES-256-GCM.  
Only agents with valid keys and tokens can see the data — and even then, only within scope.

### 4. **Everything is Auditable**

Tokens and links are signed, inspectable, and time-bound.  
We assume your system will be inspected — by humans or code.

### 5. **Modularity Wins**

Inspired by operons in biology, we design agent actions to be **small, reusable, and testable**.  
Agents should be swappable. Behaviors should be composable.

---

## 🔍 What We Don’t Do

- ❌ We don’t trust the platform by default  
- ❌ We don’t store plaintext user data  
- ❌ We don’t assume “user signed in” = user gave consent  
- ❌ We don’t allow agents to bypass protocol logic

---

## ⚖️ Real Consent is Verifiable

If your agent can’t show:

- ✅ A signed `HushhConsentToken`
- ✅ A matched `ConsentScope`
- ✅ A validated `TrustLink` (if delegated)

…then it doesn’t have permission. And it shouldn’t act.

---

## 💡 What We Hope You’ll Build

- 🧠 Agents that summarize, organize, and protect your life
- 🤖 Teams of agents that collaborate with scoped trust
- 🧬 AI that’s modular, permissioned, and inspectable
- 🔐 Systems where consent is always provable

---

## 🫱🏽‍🫲 Final Words

We’re not here to “own” trust.  
We’re here to make it programmable — and make sure it's used responsibly.

Let’s build a world where humans own the keys, the scopes, and the outcomes.

Consent-first. Privacy-native. Agent-ready.

—
Team Hushh
```
