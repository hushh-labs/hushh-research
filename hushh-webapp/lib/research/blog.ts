/**
 * PCHP protocol blog — seed posts.
 *
 * Content strategy (learned from how MCP seeded adoption, adapted to a broader
 * audience): lead with the human's job-to-be-done, not the mechanism; one
 * carried analogy; a concrete on-ramp; and a legible roadmap. Every post is
 * bylined to the founder + the research team to establish authorial authority,
 * the same way MCP bylines named, credentialed authors.
 *
 * Bodies are GitHub-flavored Markdown, rendered by ProseMarkdown.
 */

export type BlogPost = {
  slug: string;
  title: string;
  subtitle: string;
  author: string;
  date: string; // ISO
  readingMinutes: number;
  tags: string[];
  /** Short teaser for the index list. */
  excerpt: string;
  body: string;
};

const AUTHOR = "Manish Sainani and 🤫 Research & Intelligence Team";

export const BLOG_POSTS: BlogPost[] = [
  {
    slug: "financial-health-at-the-speed-of-consent",
    title: "Your financial health should move at the speed of your consent",
    subtitle:
      "Sharing your financial life with the people who advise you is still a mess of PDFs and portals. It does not have to be.",
    author: AUTHOR,
    date: "2026-07-12",
    readingMinutes: 6,
    tags: ["Jobs to be done", "Consent", "Finance"],
    excerpt:
      "Every year, millions of people email statements to their CPA, screenshot balances for a loan officer, and lose track of who has a copy of what. Here is why that is a protocol problem — and what solving it unlocks.",
    body: `Picture the last time you had to share your financial life with someone who works *for* you.

Maybe it was tax season, and your CPA needed a year of brokerage statements, 1099s, and bank exports. Maybe you were applying for a loan, and the banker needed to see your accounts to underwrite it. Maybe your lawyer needed your holdings for an estate plan, or an auditor needed a scoped slice for a review.

What did you actually do? You logged into six portals. You downloaded PDFs. You emailed them — to an inbox, unencrypted, forever. You screenshotted a balance. And a month later you had no idea who still had a copy, whether they could see more than you meant them to, or how to take it back.

**This is not a paperwork problem. It is a protocol problem.**

## Work backwards from the human

Start with what the person actually wants to get done: *"Let my CPA see exactly what they need to do my taxes, for as long as they need it, and not one thing more — and let me see who has what, and take it back when we are done."*

Read that sentence again. It is a specification. It has scope ("exactly what they need"), duration ("as long as they need it"), least privilege ("not one thing more"), visibility ("see who has what"), and revocation ("take it back"). Every one of those is a property a protocol can guarantee — and none of them is guaranteed by emailing a PDF.

Today, the person carries all of that in their head, badly. The data, once shared, is a copy that lives forever in someone else's inbox. The "consent" was a decision made once, silently, with no receipt and no undo.

## What a consent handshake changes

Now imagine the same moment, done right:

- Your CPA's software asks for a **scoped** read: *brokerage statements and 1099s, for this tax year, for 90 days.*
- You get a plain-language request — who, what, why, how long — and approve it with a tap and a fingerprint.
- A **receipt** is minted. Your CPA receives a sealed, time-boxed key — not your password, not a permanent copy.
- Every read is written to a log **you** can see.
- When taxes are filed, the key expires on its own — or you revoke it early, and it dies everywhere at once.

No PDFs. No inbox copies. No wondering. The share moved at the speed of your consent, and your consent stayed in your hands the whole time.

## The opportunity, not just the relief

It is tempting to stop at "less friction." But the bigger prize is what becomes *possible* once consent is programmable.

When your financial health is something you can share safely in seconds, a helpful agent can do things for you that were never safe before: get you three real loan offers by giving three banks a scoped, revocable read instead of three permanent copies; keep your advisor continuously current instead of quarterly-stale; let a new fiduciary onboard you in an afternoon. Your **financial network score** — a picture of your standing that you own and grant — becomes something you *lend*, not something you *leak*.

That is the difference between removing a pain and creating an opportunity. We want to do both, in that order.

## This is what PCHP is for

We built the Personal Consent Handshake Protocol so that this stops being a story and becomes plumbing. It defines the handshake, the receipt, the scoped key, the sealed envelope, and the log — as an open standard, so any CPA's software, any bank, any app, and any agent can honor it.

And we are giving it away. PCHP is being donated to the open-source community under the most permissive license we can offer, because a person's consent over their own data should be a shared standard, not anyone's product feature.

Read the [specification](/research/protocol), and tell us where it is unclear. We are working backwards from you.

*— ${AUTHOR}*`,
  },
  {
    slug: "the-missing-consent-layer-of-the-agentic-internet",
    title:
      "The missing consent layer of the agentic internet",
    subtitle:
      "This week the internet gave agents payment, legitimacy, and authorization. It still has not given the person consent. PCHP is proposed to fill that gap — a peer to TLS.",
    author: AUTHOR,
    date: "2026-07-12",
    readingMinutes: 6,
    tags: ["Positioning", "Protocol", "Networking"],
    excerpt:
      "x402 settles payments, PACT verifies legitimacy, OAuth authorizes apps — and none of them answer whether the human owner consented to a read of their own data. Here is why consent belongs at the protocol layer, alongside TLS.",
    body: `This week, the infrastructure of the internet took several big steps toward an agentic future — and in doing so, made the case for PCHP better than we could have ourselves.

Cloudflare, with AWS and Stripe, wired **x402** into the edge so agents can *pay* for access to pages, datasets, APIs, and tools. Cloudflare, with Chrome, Firefox, and Edge, proposed **PACT** — Private Access Control Tokens — so a site can tell a legitimate human or authorized bot from an abuser *without tracking anyone*. OAuth for agents went generally available, so an agent can be granted scoped, revocable permission to an *application*. Agents can now even spin up temporary accounts and deploy code on their own.

Look at that list. Payment. Legitimacy. Application-authorization. Deployment. The internet is rapidly giving autonomous agents everything they need to *act*.

There is exactly one thing missing. **Consent — the human owner's consent over their own private data.**

## Payment is not consent. Legitimacy is not consent.

It is worth being precise, because these are easy to conflate:

- **x402** answers *"has this been paid for?"* — an economic question.
- **PACT** answers *"is this visitor a legitimate human or authorized bot?"* — an integrity question.
- **OAuth** answers *"may this application act with these permissions?"* — an application-authorization question.

None of them answers the question a person actually cares about when their financial life, their health record, or their identity is involved: *"Did **I** agree to let **this** party read **this** slice of **my** data, for **this** long — and can I see it and take it back?"*

That is not a payment. It is not a bot check. It is not an app grant. It is **consent**, and it belongs to a person. Today it is implemented — when it is implemented at all — as a checkbox inside each app, which means it does not travel, does not interoperate, and ends at each app's edge.

## The stack has a human-shaped hole at the top

Think of the secure networking stack as handshakes:

\`\`\`
  Application data / agents
  ─────────────────────────────────────────────
  PCHP    ← consent handshake   (may this party read THIS person's data?)
  TLS     ← encryption handshake (is the channel private? who is the server?)
  TCP/IP  ← transport            (do the packets arrive?)
\`\`\`

TCP/IP got the packets there. TLS made the channel private and authenticated the server — and became invisible infrastructure precisely *because* it was a protocol, not a per-site feature. Every server can speak it; every browser expects it.

Consent deserves the same treatment. **PCHP is proposed as the consent handshake** — a peer to TLS, one layer up. It composes with everything shipping this week: an agent can be paid (x402), proven legitimate (PACT), and app-authorized (OAuth), and *still* be required to complete a PCHP handshake — a scoped, logged, revocable receipt — before it reads a single field of a person's private data.

## Why now, and why open

The window is open right now. The agentic internet is being wired this quarter, and the layers are being decided. If consent is not proposed as a protocol now, it will calcify as ten thousand incompatible checkboxes, and the person will lose — again.

So we are proposing it as a protocol, and **donating it to the commons** under the most permissive license we can (CC0 for the text, Apache-2.0 for the schema and code). We are not trying to own the consent layer. We are trying to make sure there *is* one, that it is open, and that it puts the person in control — before the alternative sets.

Read the [specification](/research/protocol), and specifically [Where PCHP Sits](/research/protocol) for how it composes with the rest of the stack. Then tell us what you would change. The best time to shape a protocol is while it is still a request for comments.

*— Manish Sainani and 🤫 Research & Intelligence Team*`,
  },
  {
    slug: "introducing-pchp",
    title:
      "Introducing PCHP: an open consent handshake for humans, agents, and the people they trust",
    subtitle:
      "We are donating the Personal Consent Handshake Protocol to the open-source community. Here is what it is, and why now.",
    author: AUTHOR,
    date: "2026-07-12",
    readingMinutes: 7,
    tags: ["Announcement", "Protocol", "Open source"],
    excerpt:
      "PCHP is an open standard for sharing personal information with consent and control built into every transaction. Today we are publishing the first unified specification as a public request for comments — and dedicating it to the commons.",
    body: `Today we are publishing the first unified specification for **PCHP — the Personal Consent Handshake Protocol** — as a public request for comments, and donating it to the open-source community under the most permissive license we can offer.

## The one idea

PCHP standardizes a single thing: **consent on every read of personal information.**

Think of it as a signed receipt and a revocable key attached to every share of your information. Before anything private moves, a handshake happens — the requester says exactly what they want and why, the owner approves with a real credential, a scoped and time-boxed key is issued, the information moves inside a sealed envelope, and every step is written to a log the owner can read. Revoke, and the key dies.

The owner is always a human — or a machine that human governs, so the human keeps complete visibility and a kill switch.

## Why a protocol, and why now

Two things are true at once in 2026. First, agents are becoming genuinely capable of acting on our behalf. Second, the data they need to be useful — our financial lives, our health, our identity — is exactly the data we cannot afford to hand over carelessly.

The industry solved "connect an agent to a tool" beautifully with the Model Context Protocol. But there is no open standard for the harder, more human question underneath it: *how does a person grant, see, and revoke access to their own private data — to an agent, or to another person — with consent built into the protocol itself, not bolted on as a checkbox?*

That gap is what PCHP fills. If MCP is how an AI application connects to tools and context, PCHP is how a **person's private data** connects to the humans and agents they trust — with consent as the protocol.

## What is in the spec

The [specification](/research/protocol) defines, with RFC-2119 normative language:

- A **six-phase handshake** — Discover, Hello, Offer, Consent, Deliver, Acknowledge — with version and capability negotiation.
- Two token families — a **Consent Receipt** and a per-read **Data Access Token** — with a published wire format, a scope grammar, and a JSON Schema.
- A **zero-knowledge sealed envelope** so data is delivered such that only the intended requester can open it, and the host never needs the plaintext.
- An append-only **transparency log** so every grant, read, and revocation is visible to the owner.
- Two **conformance levels**, stated honestly: a shipped baseline (with a cross-language golden-vector test suite) and a proposed high-assurance profile.

We were deliberate about honesty. Where something is shipped, the spec says so. Where something is a proposal for v1 — tamper-evident log sealing, threshold signing — the spec says that too. A mature protocol earns trust by being legible about its own frontier, not by overclaiming.

## We learned from the best — and we credit them

PCHP's structure is directly inspired by MCP, which in turn credits the Language Server Protocol. We stand on that lineage gratefully, alongside SSH (the ancestor of *hu_ssh*, "SSH for humans"), OAuth, WebAuthn/passkeys, and the consent-receipt work of the wider privacy-engineering community. The [Acknowledgements](/research/protocol) page names them, because crediting your lineage is how a standard earns trust.

## A gift to the commons

We are dedicating the specification text to the public domain (CC0) and releasing the schema and reference code under Apache-2.0 — more open than MCP's MIT-only posture. We are not trying to own a standard. We are trying to make consent-first data sharing so easy and so open that it is adopted everywhere, faster than any protocol before it.

That only works if you take it, use it, break it, and tell us. Read the [spec](/research/protocol). Send us the parts that are unclear. Propose changes. We are publishing early and in the open precisely so PCHP is shaped by the people who adopt it.

*— ${AUTHOR}*`,
  },
  {
    slug: "the-consent-handshake-in-five-minutes",
    title: "The consent handshake in five minutes",
    subtitle:
      "The shortest path from zero to a working understanding of PCHP — for the developer who has five minutes.",
    author: AUTHOR,
    date: "2026-07-12",
    readingMinutes: 5,
    tags: ["Tutorial", "Getting started", "Developers"],
    excerpt:
      "Ease of use is the whole point. Here is the entire protocol — discover, ask, approve, deliver — in one readable pass, with the shape of the calls you will make.",
    body: `Ease of adoption is a requirement of PCHP, not an afterthought. If you cannot understand the protocol in five minutes, we have failed. So here is the whole thing, fast.

## The mental model

A person (the **owner**) has private data. Someone else (a **requester** — an app, a CPA's software, an agent) wants to read a slice of it. PCHP is the handshake that gets from "wants to read" to "has read, with a receipt" — and lets the owner see and revoke the whole time.

Five nouns, and you know the protocol:

- **Consent Receipt** — proof the owner said yes, to these scopes, until this time.
- **Data Access Token** — a single-read key derived from a receipt.
- **Sealed Envelope** — the data, encrypted so only the requester can open it.
- **Transparency Log** — the append-only record the owner can read.
- **Scope** — a dotted, least-privilege string like \`attr.identity.*\` or \`portfolio.read\`.

## The handshake, in six steps

**1. Discover.** The requester reads the host's capabilities:

\`\`\`
GET https://host.example/.well-known/hussh
→ { protocol_versions, issuer, scopes_supported, token_profiles, log }
\`\`\`

**2. Hello.** The requester asks for exactly what it needs, and no more:

\`\`\`
POST {issuer}/hello
{ "version": "pchp/2026-07-12",
  "requester": "...verifiable id...",
  "scope": ["portfolio.read"],
  "purpose": "Prepare 2026 tax return" }
\`\`\`

**3. Offer.** The issuer shows the owner a plain-language request: who, what, why, how long.

**4. Consent.** The owner approves with a real credential (a passkey/biometric tap). A **Consent Receipt** is minted, and \`REQUESTED\` + \`CONSENT_GRANTED\` land in the log.

**5. Deliver.** For each read, the issuer derives a **Data Access Token** and returns a **sealed envelope**:

\`\`\`
GET {issuer}/read?resource=portfolio.statements
Authorization: Bearer <data-access-token>
→ sealed envelope (opens only with the requester's key)
\`\`\`

**6. Acknowledge.** The requester confirms; a \`READ\` event is logged. Done — and fully attributable.

At any moment the owner can revoke, and the receipt and every token derived from it die everywhere at once.

## Least privilege, by construction

Notice what you *cannot* accidentally do. You cannot ask for "everything" — scopes are narrow and the issuer refuses over-broad asks. You cannot hold a permanent copy — tokens expire and reads are sealed per-envelope. You cannot share silently — every step is logged. The protocol makes the safe path the easy path.

## Conform in one test

At the baseline level, conformance has an objective test: **reproduce the published golden vectors** for the token format. If your implementation matches every vector, your token layer is conformant. The reference implementation cross-checks the same suite in two languages, so "it works on my machine" is not a question of opinion.

## Where to go next

- The full [specification](/research/protocol) — normative, with the JSON Schema and the scope grammar.
- The [Overview](/research/protocol) — if you want the *why* before the *how*.

That is PCHP. Five nouns, six steps, one conformance test. Now go build something that treats a person's consent as the protocol.

*— ${AUTHOR}*`,
  },
];

export function getBlogPost(slug: string): BlogPost | undefined {
  return BLOG_POSTS.find((post) => post.slug === slug);
}
