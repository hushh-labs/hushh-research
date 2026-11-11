# The Human Side of the Agent Protocol

### Introducing PCHP — the Personal Consent Handshake Protocol — and the Hussh protocol

**By Manish Sainani & Kushal Trivedi** · November 10, 2026

﻿**The essay lives right here — scroll on.** A standalone web-page edition (essay/index.html) sits alongside it in this folder.(https://github.com/hushh-labs/hushh-research/blob/main/launch/2026-11-10/README.md) · **PDF:** [https://github.com/hushh-labs/hushh-research/blob/main/launch/2026-11-10/essay/the-human-side-of-the-agent-protocol.pdf](https://github.com/hushh-labs/hushh-research/blob/main/launch/2026-11-10/essay/the-human-side-of-the-agent-protocol.pdf)

---

Last month, Sierra and Meta — together with Genesys, Instinct, Rocket, Shopify, Stripe, and Walmart — announced the Personal Agent Protocol: an open standard for how personal agents work with businesses. Authentication. Sessions a customer controls. Visibility for the company into what an agent does on its customer's behalf.

It is the right work, and we want to say so plainly. We have spent five years building the other half of it.

The Personal Agent Protocol answers a real question: *when a person's agent arrives at your business, how should the two work together?* But there is a question that comes before it — the one our work starts with.

**Where does the agent's knowledge of the person come from — and who owns it?**

## Stop being copied

Today, a person's information moves by copying. You fill a form, and the copy stays. An app reads your contacts, and the copy stays. A platform builds a profile of you, and that copy is sold, merged, breached, and rebuilt — a thousand copies of you, owned by everyone except you.

Agents make this worse before they make it better. A personal agent that truly serves a person needs to know the person — their preferences, their documents, their health, their money, their business. If that knowledge moves the way information moves today, we will have built the most complete copying machine in history, pointed at the most private material there is.

So we built the layer that has to exist first: a handshake, owned by the human.

## PCHP — the Personal Consent Handshake Protocol

PCHP is SSH for humans. Before any information moves between a person and a machine — or between their agents — the two sides perform a consent handshake, in four phases:

1. **Identity resolution.** Each side proves who it is, and who it acts for.
2. **Consent negotiation.** The person states what may be shared, for what purpose, and for how long. The requesting side accepts those terms or walks away.
3. **Scoped exchange.** Only the agreed slice moves — nothing adjacent, nothing "just in case."
4. **Audit receipt.** Both sides sign a receipt for exactly what was shared and why. Both keep a copy.

One rule governs the whole protocol: **silence means no. Nothing defaults open.**

PCHP is designed to compose with the protocols this industry is building — the Personal Agent Protocol, MCP, A2A, AP2, UCP, and the web itself. It sits beneath them, at the moment consent is granted, and it travels with the information afterward. We are open-sourcing the specification under Apache 2.0, because a consent layer only works if everyone can build on it.

## The Hussh protocol — information is the subscription

A handshake solves consent. It doesn't solve the economics. For that, the model of information itself has to change — from copies to subscriptions.

The Hussh protocol turns the information a person owns — personal and business alike — into a subscription that the person controls:

- **You own the source.** Your documents, records, preferences, and data live in your vault, under your keys. There is one source of truth, and it's yours.
- **Others subscribe to scopes.** The people and systems who serve you — your bank, your accountant, your doctor's office, your travel agent, and the AI agents acting for all of them — subscribe to exactly the slice they need: a scope, for a purpose, for a duration you set.
- **You set the price.** A subscription can be free for your family, priced for a business, or declined entirely. If your information has value, the value is yours.
- **Consent is the switch.** Revoke a subscription and access ends. No copies to chase, no profiles to delete — access was the product, never the copy.
- **Every exchange leaves a receipt.** The handshake's audit trail means you can always answer the only question that matters: *who has what of mine, and why?*

This is the same inversion streaming brought to music. Nobody ships copies of a song anymore; you subscribe to access, and the artist stays the owner. We are doing that for the most valuable library a person has — their own information.

## Built for the era of humans, AI, and SI working together

We are entering an era where humans, AI systems, and superintelligent systems will work together every day, on the most personal material there is. That era needs more than agents that can act. It needs a person who stays in control while they act.

The Personal Agent Protocol gives businesses a standard way to receive agents. PCHP gives people a standard way to be known — on their own terms, with consent and commerce built into the core of the protocol, not bolted on after. The Hussh protocol makes it an economy: information the owner controls, that the people who serve them can subscribe to.

We'd love to build this with the companies who announced the Personal Agent Protocol, and with everyone building personal agents. The table is open. Come sit at it.

**— Manish Sainani**, Founder, Hussh
**— Kushal Trivedi**, Co-founder, Hussh


---

## The launch set

Published November 10, 2026 — the complete Hussh launch set (mirror of record: this repo, launch/2026-11-10/):

- **The essay (web):** [The Human Side of the Agent Protocol](https://github.com/hushh-labs/hushh-research/blob/main/launch/2026-11-10/README.md)
- **The essay (PDF):** [https://github.com/hushh-labs/hushh-research/blob/main/launch/2026-11-10/essay/the-human-side-of-the-agent-protocol.pdf](https://github.com/hushh-labs/hushh-research/blob/main/launch/2026-11-10/essay/the-human-side-of-the-agent-protocol.pdf)
- **Manifesto:** [Own Your Information — the Hussh manifesto](https://github.com/hushh-labs/hushh-research/blob/main/launch/2026-11-10/manifesto/own-your-information-manifesto.pdf)
- **The story, on one page:** [hussh-story-one-page.pdf](https://github.com/hushh-labs/hushh-research/blob/main/launch/2026-11-10/story/hussh-story-one-page.pdf)
- **Keynote — Dec 27 (PDF):** [Hussh-Keynote-Dec-27.pdf](https://github.com/hushh-labs/hushh-research/blob/main/launch/2026-11-10/keynote/Hussh-Keynote-Dec-27.pdf) · **(PPTX):** [Hussh-Keynote-Dec-27.pptx](https://github.com/hushh-labs/hushh-research/blob/main/launch/2026-11-10/keynote/Hussh-Keynote-Dec-27.pptx)
- **One-pager — Hussh (company):** [hushone-onepager-v5.pdf](https://github.com/hushh-labs/hushh-research/blob/main/launch/2026-11-10/one-pagers/hushone-onepager-v5.pdf)
- **One-pager — Hussh Asset Management:** [hussh-am-onepager-v5.pdf](https://github.com/hushh-labs/hushh-research/blob/main/launch/2026-11-10/one-pagers/hussh-am-onepager-v5.pdf)
- **Press release (canon, Nov 10 2026):** [01-Press-Release.pdf](https://github.com/hushh-labs/hushh-research/blob/main/launch/2026-11-10/press/01-Press-Release.pdf)
- **Press release — Nov 10 re-issue (with the essay link):** [01-Press-Release-Reissue-2026-11-10.pdf](https://github.com/hushh-labs/hushh-research/blob/main/launch/2026-11-10/press/01-Press-Release-Reissue-2026-11-10.pdf)

Hussh builds the private personal agent — intelligence that works only for the person it serves. More at [hussh.si](https://hussh.si).
