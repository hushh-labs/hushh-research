Context transfer for my private agent. Every name, number and identifier below is synthetic test material.

# Identity and preferences
- **Preferred name:** Rowan Ellery, and I go by Ro with close friends
- Pronouns: they/them
- I live in Portland, Oregon, in the Pearl District, and I have lived here since 2021
- Languages: English (native), Spanish (conversational), and beginner Japanese
- I prefer short, direct messages with the decision first and the detail after
- I like dark mode everywhere, a quiet desk, and a single monitor in portrait
- Coffee: one pour-over in the morning, never after 2 pm, oat milk only
- I prefer written updates over meetings, and I keep Fridays free of calls
Background: I grew up in a small coastal town, moved for university, and have spent most of my working life in the Pacific Northwest. I think of myself as an engineer first and a founder second, and I make better decisions after a walk than after a meeting. I would rather have one honest conversation than three polite ones.

# Role and compensation
- **Role:** Founder and CEO of Lumen Ledger — I also act as the de facto head of engineering
- I report to the board, which meets every six weeks
- Base salary: USD 185,000 per year, set by the board in March 2026
- Equity: I hold 41% of the common stock after the seed round, vesting over four years with a one-year cliff
- Annual bonus target: 10 percent of base, tied to revenue milestones
- I take no salary increase until we reach USD 1M in annual recurring revenue
Background: my compensation was benchmarked against seed-stage founders in the region by our board in early 2026. I asked for the salary to stay below market until we have a year of runway past the Series A, and the board agreed to revisit it at the next financing. I do not take a car allowance or a home office stipend.

# Immigration
- I moved to the United States in August 2016 on an F-1 student visa
- My H-1B was approved on 2019-10-01 with Northwind Analytics as the sponsor
- I changed H-1B employers to Lumen Ledger on 2022-04-15 through a transfer petition
- My I-140 was approved on 2024-02-11 in the EB-2 category
- My priority date is 2023-06-30 and I expect the green card interview in 2027
- I renew my passport every ten years; the current one expires in 2031
Background: every immigration step has been handled by the same law firm since 2019, and I keep copies of every approval notice in a fireproof box at home and in an encrypted folder. Travel outside the country needs a check with the lawyer first while the green card case is pending, so I plan international trips at least two months ahead.

# Education
- MS in Computer Science, University of Washington, 2018, with a focus on distributed systems
- BTech in Electronics, a state university, 2016
- My master's thesis was on consistent snapshots for append-only logs
- I completed a short course in product management at a community college in 2020
Background: the thesis work on append-only logs is the reason the vault design uses an event history rather than in-place updates. I still keep in touch with my advisor, who reviews our cryptography design once a year as a favor. I would like to teach a short course on private systems someday.

# Employers
- 2018 to 2020: Northwind Analytics, software engineer on the data ingestion team
- 2020 to 2022: Fabrikam Health, senior engineer and later tech lead for the patient portal
- 2022 to now: Lumen Ledger, founder
- At Fabrikam Health I led a team of six and shipped the appointment booking service
- I left Fabrikam Health to start a company around personal data ownership
Background: Northwind Analytics taught me how to run data pipelines at scale, and Fabrikam Health taught me how regulated data should be handled, which is most of what Lumen Ledger is built on. I left both on good terms and two former colleagues now work with me.

# Company
- Lumen Ledger is a Delaware C-corp founded in May 2022, with an office in Portland
- We raised a USD 3.2M seed round in November 2023 led by Harbor Light Ventures
- We have 11 full-time people: 7 engineers, 2 designers, 1 operations lead, and me
- Our mission is to let people own their personal records and share them only with consent
- Monthly burn is about USD 210,000 and runway is 14 months as of September 2026
- We are incorporated in Delaware and pay state taxes in Oregon
Background: we chose Delaware for the seed round at the investors' request, and we keep a small office in Portland mostly for design reviews and the monthly all-hands. Everyone else works remotely across three time zones, with core hours from 10 am to 2 pm Pacific.
Detail: the cap table is simple, with founders, a small option pool of 12 percent, and the seed investors, and there are no convertible notes outstanding. Board decisions are recorded in written consents that Lena files the same week.

# Product
- Our product is Lumen One, a private agent that keeps a person's records in an encrypted vault
- The web app is at app.lumen-demo.dev and the iOS app is in TestFlight
- Pricing: free for individuals, USD 12 per month for the family plan
- We have 2,400 weekly active users and 310 paying families
- The roadmap for Q4 2026 is shared calendars, receipts import, and an Android build
- Our north-star metric is weekly active vault unlocks
Background: the first version of Lumen One was a password-protected notes app, and the agent arrived in the second year once we had the consent model right. Most families find us through word of mouth, and the family plan is the only thing we have ever charged for.
Detail: the three most used features are the shared family calendar, receipt capture from email, and asking the agent what a family member already shared. Support requests average about forty a week, and most of them are about restoring access after a lost phone.

# Tech stack
- Frontend: Next.js 16 with React 19 and TypeScript
- Styling: Tailwind CSS with our own token system
- Mobile: Capacitor 8 wrapping the web app for iOS and Android
- Backend: FastAPI on Python 3.13
- Package manager for Python: uv
- Package manager for JavaScript: npm with a lockfile
- Database: Postgres 16 on Cloud SQL
- Migrations: plain SQL files applied in order by a release job
- Cache: Redis on Memorystore for rate limits
- Queue: Cloud Tasks for background jobs
- Hosting: Cloud Run for the API and the web server
- Auth: Firebase Authentication with Google and Apple sign-in
- Encryption: AES-GCM in the browser with a vault key derived from a passphrase
- Models: Gemini through Vertex AI for the agents
- Agent framework: Google ADK with A2A between agents
- Search: Postgres full-text search, no separate search cluster
- Observability: Cloud Logging and Cloud Monitoring with custom dashboards
- Analytics: GA4 with a BigQuery export
- Payments: Stripe Checkout and the Stripe customer portal
- Email: Gmail API for reading, SendGrid for transactional mail
- CI: GitHub Actions with a single status gate
- Infrastructure as code: Terraform for networking, shell scripts for the rest
- Testing: pytest for the backend and Vitest plus Playwright for the web app
- Linting: ruff, mypy, ESLint and the TypeScript compiler
- Design: Figma with a shared component library
Background: the stack is deliberately boring, with one database, one cloud, and one language per side of the network, so that a new engineer can ship on their first day and nobody has to page a specialist at night.

# Architecture
- Each person gets a private agent; their records stay encrypted and only they hold the key
- The backend never sees plaintext records; it stores ciphertext and a metadata manifest
- Our agents are orchestrated with Google ADK and talk to each other over A2A
- The MCP server exposes consented tools to outside assistants, one scope at a time
- The system architecture is a monorepo with a shared contracts folder that both the web app and the API read
- Consent is a signed token with a scope, an expiry, and the requester's identity
Background: the rule we never break is that the server holds ciphertext and the device holds the key, so even a full database leak would expose metadata and nothing a person wrote. Every new feature has to explain how it keeps that rule before it gets a design review.
Detail: records are split into domains, each domain into encrypted segments, and the manifest lists paths and sensitivity labels so that a consent request can name an exact path without the server ever reading the value behind it.

# Infrastructure
- GCP project: lumen-demo-482910 in region us-central1
- Staging project: lumen-staging-118204, which mirrors production at a smaller size
- The API reads its signing key from the LUMEN_SIGNING_KEY environment variable
- The Google OAuth callback is https://app.lumen-demo.dev/api/auth/callback/google
- The iOS bundle identifier is com.lumendemo.one and the Android app id is com.lumendemo.one.android
- The deploy service account is called lumen-deployer and has only Cloud Run and Artifact Registry roles
- Our GitHub deploy token is ⟦secret:sec_00000000000000a1 GitHub deploy token ending 9f3c⟧ and it rotates every 90 days
- Backups run nightly to a separate bucket with a 30-day retention policy
Background: production and staging live in separate projects with separate service accounts, and nobody on the team has standing owner access to production; access is granted for an hour at a time through a request that the operations lead approves.
Detail: deploys go from a green main branch to staging automatically and to production only after a person approves the promotion, and a rollback is a single command that points traffic back at the previous Cloud Run revision.

# Repository metrics
- The monorepo has about 9,800 commits since May 2022
- 41 people have contributed, including contractors and interns
- There are roughly 1,150 backend tests and 2,300 web tests
- A full CI run takes about 22 minutes and the merge queue holds up to 5 pull requests
- We merge about 60 pull requests per week
Background: we track the median time from pull request to merge, which is about four hours, and the share of changes that need a follow-up fix within a week, which is under three percent. Both numbers are on the team dashboard and reviewed every Monday.

# AI tools
- I code every day with Claude Code and Gemini CLI, usually in two terminals side by side
- I use a local model for private notes so that they never leave my laptop
- The team reviews every AI-written change by hand before it merges
- I keep a running prompt library for release notes and incident write-ups
Background: the tools write first drafts and the people own the result. We have a written rule that an AI-written change is reviewed with the same care as a change from a new hire, and the author of record is always the person who merged it.
Detail: release notes, incident timelines and test plans start from prompts in the shared library, and every prompt has an owner who updates it when the output drifts. We do not paste customer records into any hosted tool.

# Hardware
- Laptop: a 16-inch workstation laptop with 128 GB of unified memory
- The local mixture-of-experts model runs at about 62 tokens per second on that laptop
- The dense 32B model runs at about 18 tokens per second, so I use it only for long documents
- I test the iOS app on an older phone to keep the slow path honest
- Home network: a mesh router with a wired backhaul to my desk
Background: running models locally matters to me because private notes should not need a network connection, and the laptop was bought specifically to keep a capable model on the device. I measure the speed again after every model update.
Detail: the local models are a mixture-of-experts model for everyday notes and a dense model for long documents, both quantized, and both stay loaded in the background so that the first answer of the day is not slow.

# Vendors
- Google Cloud for hosting, with committed-use discounts on Cloud Run
- Stripe for payments and Twilio for SMS verification codes
- Plaid for bank connections in the finance features
- SendGrid for transactional email
- Our accountant is Brightline CPA, and payroll runs through a payroll provider
- Stripe for payments and Twilio for SMS verification codes
- Legal counsel is a two-partner firm in Portland that also handled the seed round
Background: we review every vendor once a year for price and for what data they can see, and we prefer vendors that let us keep personal records out of their systems entirely. Contracts above USD 10,000 a year need a second signature from the operations lead.
Detail: the payroll provider and the accountant are the only vendors who see salary information, and both were chosen because they support role-based access for a small team. Our insurance broker reviews coverage every spring.

# People
- Asha Varma is our CTO in all but title and owns the data platform
- Mateo Ruiz leads design and runs the weekly design review on Tuesdays
- Lena Okafor is our operations lead and handles payroll, vendors and hiring logistics
- Daniel Cho at Harbor Light Ventures is our board member and lead investor
- My mentor is a former founder named Priya Nair, and we meet once a month
- My partner Sam works as a nurse, and we share a calendar for weekends
Background: the core team has worked together for more than two years and most decisions are made in a short written proposal that anyone can comment on. I try to give every person one uninterrupted day a week without meetings.
Detail: Asha and I split the on-call week between us, Mateo owns everything a person sees, and Lena owns everything a vendor or an auditor sees. Daniel joins one product review a quarter so the board hears about users from users.

# Housing
- I rent a two-bedroom apartment in the Pearl District for USD 3,150 per month
- The security deposit was USD 4,800, held by the landlord until the lease ends
- The lease runs until 2027-06-30 and renews for twelve months at a time
- I want to buy a house within three years, ideally with a small yard
Background: the apartment is a ten-minute walk from the office and the light rail, which is the main reason we chose it, and the landlord has been reasonable about repairs. We have looked at houses in the eastside neighborhoods but nothing has fit the budget yet.

# Health and routines
- I run three mornings a week before 7 am, usually 5 to 8 kilometers
- I avoid dairy and keep caffeine to one cup a day
- I sleep badly when I work past 11 pm, so I stop screens at 10:30 pm
- I see a physical therapist every other week for a recurring knee issue
Background: the knee issue started after a trail race in 2023, and the physical therapist has me on a strength routine three evenings a week. My sleep is the first thing to slip during a launch, so I protect it more than anything else on the calendar.

# Travel
- I prefer aisle seats on flights longer than three hours
- I fly Alaska Airlines when I can and I hold its mid-tier status
- I travel to San Francisco about once a month for investor meetings
- I like small hotels near train stations over large conference hotels
Background: investor meetings are usually stacked into one long day so that I can fly down and back without a hotel, and I keep a small packed bag by the door for those trips. For holidays we prefer trains and small towns over big cities.
Detail: my loyalty numbers and the known traveler number are kept with my documents, not in this note, and I book through the airline sites directly rather than through an agency.

# Goals
- Reach USD 1M in annual recurring revenue by the end of 2027
- Hire a dedicated security engineer before the Series A
- Ship the Android app by March 2027
- Run a half marathon in the spring of 2027
Background: the revenue goal and the Series A are linked, since investors have told us that a clear path to one million in recurring revenue is what they need to see. The half marathon is the personal goal that keeps the running routine honest.
Detail: the security hire is the first role in the Series A plan, ahead of sales, because the product promise depends on it, and the Android app is the most requested feature from paying families.

# Information not known
- Information not known: my exact home street address
- Information not known: the final Series A valuation
- Not supplied here: any passwords or private keys
