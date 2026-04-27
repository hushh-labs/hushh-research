# CRED-Inspired App Design Guidelines

> This is a CRED-inspired premium design system for building a dark, luxury, fintech-style mobile app.
> Do not copy CRED directly. Use this as inspiration for layout, hierarchy, colors, CTA, cards, icons, typography, and motion.

---

# 1. Design Personality

The design should feel:

- Premium
- Dark
- Bold
- Minimal
- High-contrast
- Financially trustworthy
- Slightly mysterious
- Luxury-tech
- Reward-driven
- Smooth and interactive

The UI should not feel colorful like a normal finance app.
It should feel like a private premium club.

---

# 2. Core Design Principles

## 2.1 Dark First

Use a dark background as the base.

Avoid pure flat black everywhere.
Use layered dark surfaces to create depth.

Example:

- Main background: very dark black
- Cards: slightly lighter black
- Elevated cards: dark grey
- Borders: soft grey
- CTA: bright accent

---

## 2.2 One Main Focus Per Screen

Every screen should have only one main action.

Example:

- Pay bill
- View rewards
- Check credit score
- Claim benefit
- Confirm payment

Avoid showing too much information at once.

---

## 2.3 Strong Visual Hierarchy

The user should immediately understand:

1. What this screen is about
2. What is important
3. What action to take next

Use large headings, big numbers, clean cards, and one clear CTA.

---

## 2.4 Premium Spacing

Do not make the UI crowded.

Use generous spacing between:

- Header and card
- Card and CTA
- CTA and secondary sections
- Icons and text

Premium design needs breathing space.

---

# 3. Color System

## 3.1 Primary Colors

| Purpose | Color |
|---|---|
| Main Background | `#010203` |
| Screen Background | `#050608` |
| Card Background | `#0B0D12` |
| Elevated Card | `#12151D` |
| Deep Surface | `#171A22` |
| Border | `#252A36` |

---

## 3.2 Text Colors

| Purpose | Color |
|---|---|
| Primary Text | `#F4F4F5` |
| Secondary Text | `#A3A7B2` |
| Muted Text | `#6F7480` |
| Disabled Text | `#454A55` |

---

## 3.3 Accent Colors

| Purpose | Color |
|---|---|
| Primary CTA Blue | `#4F5BFF` |
| Premium Gold | `#D7B56D` |
| Reward Green | `#B7FF3C` |
| Luxury Purple | `#6D45FF` |
| Error Red | `#FF5A5F` |
| Warning Orange | `#FFB020` |

---

## 3.4 Gradients

Use subtle gradients for premium cards.

### Dark Card Gradient

```css
background: linear-gradient(180deg, #151922 0%, #0B0D12 100%);
```

### Premium Gold Gradient

```css
background: linear-gradient(135deg, #D7B56D 0%, #8F6F2F 100%);
```

### Purple Reward Gradient

```css
background: linear-gradient(135deg, #6D45FF 0%, #25105F 100%);
```

### Green Reward Glow

```css
box-shadow: 0 0 28px rgba(183, 255, 60, 0.25);
```

---

# 4. Typography

Use the following font system:

| Use               | Font       |
| ----------------- | ---------- |
| Headings          | Inter      |
| Body              | Geist      |
| Numbers / Data    | Geist Mono |
| Labels / Eyebrows | Geist Mono |

---

# 5. Font Sizes

## 5.1 Hero Heading

Use for the main screen title.

```css
font-family: Inter;
font-size: 36px;
font-weight: 800;
line-height: 110%;
letter-spacing: -0.8px;
color: #F4F4F5;
```

Example:

```txt
pay smarter
earn better
```

---

## 5.2 Page Heading

Use for normal screen titles.

```css
font-family: Inter;
font-size: 28px;
font-weight: 750;
line-height: 120%;
letter-spacing: -0.5px;
color: #F4F4F5;
```

Example:

```txt
your cards
```

---

## 5.3 Card Heading

Use inside cards.

```css
font-family: Inter;
font-size: 20px;
font-weight: 700;
line-height: 120%;
letter-spacing: -0.3px;
color: #F4F4F5;
```

Example:

```txt
payment due
```

---

## 5.4 Subheading

Use below heading.

```css
font-family: Geist;
font-size: 15px;
font-weight: 400;
line-height: 145%;
color: #A3A7B2;
```

Example:

```txt
track bills, rewards, and payments in one place
```

---

## 5.5 Body Text

```css
font-family: Geist;
font-size: 14px;
font-weight: 400;
line-height: 150%;
color: #A3A7B2;
```

---

## 5.6 Small Label

```css
font-family: Geist Mono;
font-size: 11px;
font-weight: 600;
line-height: 120%;
letter-spacing: 0.8px;
text-transform: uppercase;
color: #6F7480;
```

Example:

```txt
TOTAL DUE
```

---

## 5.7 Large Number

Use for amount, score, balance, or rewards.

```css
font-family: Geist Mono;
font-size: 34px;
font-weight: 700;
line-height: 110%;
letter-spacing: -1px;
color: #F4F4F5;
```

Example:

```txt
₹24,850
```

---

# 6. Heading Guidelines

Headings should be short and confident.

Good examples:

```txt
pay credit card bills
earn rewards every time
your score looks strong
one place for every card
unlock member rewards
```

Avoid long headings like:

```txt
This screen helps you pay all your credit card bills and earn rewards
```

Keep headings emotional, direct, and premium.

---

# 7. Subheading Guidelines

Subheadings should explain the value in one clean line.

Good examples:

```txt
manage cards, bills, and rewards without the noise
```

```txt
pay before due date and unlock exclusive rewards
```

```txt
your financial actions, simplified into one clear view
```

Avoid boring subheadings like:

```txt
click here to check your details
```

---

# 8. CTA Guidelines

CTAs should feel premium, tactile, and important.

Use only one primary CTA per screen.

---

## 8.1 Primary CTA

```css
height: 52px;
width: 100%;
border-radius: 12px;
background: #4F5BFF;
color: #FFFFFF;
font-family: Geist;
font-size: 15px;
font-weight: 700;
letter-spacing: 0.2px;
box-shadow: 0 12px 32px rgba(79, 91, 255, 0.28);
```

CTA text examples:

```txt
pay now
continue
claim reward
confirm payment
view bills
unlock reward
```

---

## 8.2 Secondary CTA

```css
height: 48px;
width: 100%;
border-radius: 12px;
background: #171A22;
color: #F4F4F5;
border: 1px solid #2A2E3A;
font-family: Geist;
font-size: 14px;
font-weight: 650;
```

CTA text examples:

```txt
view details
maybe later
see statement
manage cards
```

---

## 8.3 Ghost CTA

Use for small text actions.

```css
background: transparent;
color: #A3A7B2;
font-family: Geist;
font-size: 14px;
font-weight: 600;
```

Example:

```txt
skip for now
```

---

## 8.4 CTA Rules

* Use lowercase CTA text where possible
* Use short action words
* Avoid more than 2 CTAs on one screen
* Primary CTA should stand out clearly
* CTA should appear after the main value is shown
* Use haptic feedback on tap
* Press state should slightly scale down

```css
transform: scale(0.98);
opacity: 0.9;
```

---

# 9. Icon Guidelines

Icons should feel sharp, premium, and controlled.

Use three types of icons:

1. Thin line icons for utility
2. Filled icons for active states
3. 3D / glowing icons for rewards and premium moments

---

## 9.1 Icon Sizes

| Icon Type         | Size        |
| ----------------- | ----------- |
| Bottom Nav Icon   | 22px - 26px |
| Small Status Icon | 14px - 18px |
| Card Icon         | 32px - 44px |
| Feature Icon      | 48px - 64px |

---

## 9.2 Icon Container

```css
width: 44px;
height: 44px;
border-radius: 12px;
background: #151922;
border: 1px solid #2A2E3A;
display: flex;
align-items: center;
justify-content: center;
```

---

## 9.3 Active Icon Glow

```css
box-shadow: 0 0 24px rgba(183, 255, 60, 0.25);
```

---

## 9.4 Icon Colors

| State         | Color     |
| ------------- | --------- |
| Active Icon   | `#F4F4F5` |
| Inactive Icon | `#6F7480` |
| Reward Icon   | `#B7FF3C` |
| Premium Icon  | `#D7B56D` |
| Error Icon    | `#FF5A5F` |

---

# 10. Card Guidelines

Cards are the most important part of the design.

Cards should feel:

* Deep
* Tactile
* Premium
* Slightly glossy
* Minimal
* Financially serious

---

## 10.1 Default Card

```css
background: linear-gradient(180deg, #151922 0%, #0B0D12 100%);
border: 1px solid #252A36;
border-radius: 18px;
padding: 20px;
box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
```

---

## 10.2 Small Card

```css
background: #0B0D12;
border: 1px solid #252A36;
border-radius: 14px;
padding: 16px;
```

---

## 10.3 Premium Reward Card

```css
background: linear-gradient(135deg, #D7B56D 0%, #8F6F2F 100%);
border-radius: 20px;
padding: 22px;
box-shadow: 0 20px 50px rgba(215, 181, 109, 0.22);
```

---

## 10.4 Card Rules

* One strong card at the top
* Use big numbers inside financial cards
* Keep text minimal
* Use subtle borders
* Use gradients instead of flat grey
* Avoid too many cards on one screen
* Use max 2-4 cards in one viewport
* Use strong spacing between cards

---

# 11. Layout Guidelines

## 11.1 Screen Padding

```css
padding-left: 22px;
padding-right: 22px;
padding-top: 24px;
padding-bottom: 24px;
```

---

## 11.2 Section Spacing

| Element                 | Spacing     |
| ----------------------- | ----------- |
| Header to card          | 28px        |
| Card to CTA             | 20px        |
| CTA to next section     | 32px        |
| Between cards           | 16px        |
| Inside card             | 18px - 24px |
| Between label and value | 8px         |

---

## 11.3 Screen Structure

Use this order:

```txt
Top Bar
↓
Eyebrow / Label
↓
Main Heading
↓
Subheading
↓
Hero Card
↓
Primary CTA
↓
Secondary Cards
↓
Bottom Navigation
```

---

# 12. Top Bar Guidelines

Top bar should be minimal.

Use:

* Left: Greeting or screen title
* Right: Profile icon / notification icon
* No clutter
* No heavy borders

```css
height: 56px;
display: flex;
align-items: center;
justify-content: space-between;
```

Example:

```txt
good evening
```

Right side:

```txt
profile circle / bell icon
```

---

# 13. Bottom Navigation

Use 4-5 items maximum.

Recommended tabs:

```txt
home
cards
rewards
pay
profile
```

---

## 13.1 Bottom Nav Container

```css
height: 72px;
background: #050608;
border-top: 1px solid #181B22;
display: flex;
align-items: center;
justify-content: space-around;
```

---

## 13.2 Active Nav Item

```css
color: #F4F4F5;
font-weight: 700;
```

Use glow for active icon:

```css
box-shadow: 0 0 20px rgba(183, 255, 60, 0.18);
```

---

## 13.3 Inactive Nav Item

```css
color: #6F7480;
font-weight: 500;
```

---

# 14. Form Fields

Fields should feel secure and premium.

```css
height: 52px;
background: #0B0D12;
border: 1px solid #252A36;
border-radius: 12px;
padding: 0 16px;
color: #F4F4F5;
font-family: Geist;
font-size: 15px;
```

Placeholder:

```css
color: #6F7480;
```

Focus state:

```css
border: 1px solid #4F5BFF;
box-shadow: 0 0 0 3px rgba(79, 91, 255, 0.14);
```

---

# 15. Financial Data Style

Use big, clear, masked, and trustworthy numbers.

Examples:

```txt
₹24,850 due
```

```txt
•••• 4821
```

```txt
credit score 782
```

```txt
₹1,240 rewards earned
```

Rules:

* Use Geist Mono for numbers
* Use large font for main amount
* Use muted labels above numbers
* Use green only for positive gain/reward
* Use red only for failure or urgent warning

---

# 16. Rewards UI

Rewards should feel slightly more playful than finance UI.

Use:

* Gold
* Green
* Purple
* Glowing icons
* Cards with stronger gradients
* Unlock animations
* Confetti only after major action

Reward card example:

```txt
reward unlocked
₹250 cashback
```

Reward CTA:

```txt
claim reward
```

---

# 17. Motion Guidelines

Motion should feel smooth and premium.

Use motion for:

* Card entry
* CTA press
* Reward unlock
* Number count-up
* Bottom sheet opening
* Active icon transition

Avoid:

* Too much bounce
* Too many animations together
* Slow animations
* Distracting motion during payments

---

## 17.1 CTA Press

```css
transform: scale(0.98);
transition: all 160ms ease;
```

---

## 17.2 Card Entry

```css
opacity: 0;
transform: translateY(16px);
animation: fadeUp 320ms ease forwards;
```

```css
@keyframes fadeUp {
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

---

## 17.3 Reward Reveal

```css
transform: scale(1);
animation: rewardPop 420ms cubic-bezier(0.16, 1, 0.3, 1);
```

---

# 18. Shadows

Use soft shadows, not harsh shadows.

```css
box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
```

For CTA:

```css
box-shadow: 0 12px 32px rgba(79, 91, 255, 0.28);
```

For reward:

```css
box-shadow: 0 16px 40px rgba(183, 255, 60, 0.2);
```

---

# 19. Borders

Borders should be subtle.

```css
border: 1px solid #252A36;
```

Avoid bright borders unless it is selected/focused.

Selected border:

```css
border: 1px solid #4F5BFF;
```

---

# 20. Image / Illustration Style

Use:

* 3D objects
* Floating cards
* Abstract premium shapes
* Dark glass surfaces
* Isometric elements
* Gold or green highlights

Avoid:

* Stock photos
* Cartoon illustrations
* Overly colorful graphics
* Cheap-looking icons

---

# 21. Copywriting Style

Copy should be short, direct, and premium.

Use lowercase where possible.

Good:

```txt
pay smarter
```

```txt
rewards unlocked
```

```txt
your score looks strong
```

```txt
one view for every card
```

Bad:

```txt
Welcome to our application where you can pay your bills and earn rewards
```

---

# 22. Component Examples

## 22.1 Hero Section

```txt
EYEBROW:
MEMBER DASHBOARD

HEADING:
pay smarter

SUBHEADING:
track cards, bills, and rewards in one premium view
```

---

## 22.2 Payment Card

```txt
LABEL:
TOTAL DUE

VALUE:
₹24,850

SUBTEXT:
due in 4 days

CTA:
pay now
```

---

## 22.3 Reward Card

```txt
HEADING:
reward unlocked

SUBHEADING:
complete payment and claim your exclusive benefit

CTA:
claim reward
```

---

## 22.4 Credit Score Card

```txt
LABEL:
CREDIT SCORE

VALUE:
782

SUBTEXT:
excellent credit health
```

---

# 23. Do’s

* Use dark premium backgrounds
* Use large headings
* Use strong CTA
* Use one clear action per screen
* Use cards with depth
* Use subtle gradients
* Use big financial numbers
* Use icons with containers
* Use premium spacing
* Use smooth motion
* Use reward moments carefully

---

# 24. Don’ts

* Do not use too many colors
* Do not use flat boring cards
* Do not overload the screen
* Do not use more than one primary CTA
* Do not use long paragraphs
* Do not use weak grey-on-grey contrast
* Do not make icons too colorful everywhere
* Do not use generic finance-app UI
* Do not copy CRED exactly
* Do not make the app look like a normal dashboard

---

# 25. Final UI Formula

Use this formula for every screen:

```txt
Dark premium background
+ bold confident heading
+ one strong financial card
+ one clear CTA
+ subtle icon detail
+ reward/premium accent
+ smooth motion
+ clean spacing
```

---

# 26. Sample Screen Structure

```txt
Top Bar:
good evening                         profile icon

Eyebrow:
MEMBER DASHBOARD

Heading:
pay smarter

Subheading:
track your cards, bills, and rewards in one premium view

Hero Card:
TOTAL DUE
₹24,850
due in 4 days

Primary CTA:
pay now

Secondary Cards:
credit score
rewards unlocked
recent activity

Bottom Navigation:
home | cards | pay | rewards | profile
```

---

# 27. Recommended CSS Tokens

```css
:root {
  --color-bg-main: #010203;
  --color-bg-screen: #050608;
  --color-surface-card: #0B0D12;
  --color-surface-elevated: #12151D;
  --color-surface-deep: #171A22;

  --color-border: #252A36;
  --color-border-active: #4F5BFF;

  --color-text-primary: #F4F4F5;
  --color-text-secondary: #A3A7B2;
  --color-text-muted: #6F7480;
  --color-text-disabled: #454A55;

  --color-cta-primary: #4F5BFF;
  --color-success: #B7FF3C;
  --color-gold: #D7B56D;
  --color-purple: #6D45FF;
  --color-error: #FF5A5F;
  --color-warning: #FFB020;

  --font-heading: 'Inter', sans-serif;
  --font-body: 'Geist', sans-serif;
  --font-mono: 'Geist Mono', monospace;

  --radius-sm: 10px;
  --radius-md: 12px;
  --radius-lg: 18px;
  --radius-xl: 24px;

  --space-xs: 6px;
  --space-sm: 8px;
  --space-md: 12px;
  --space-lg: 16px;
  --space-xl: 24px;
  --space-2xl: 32px;
  --space-3xl: 40px;

  --shadow-card: 0 20px 60px rgba(0, 0, 0, 0.35);
  --shadow-cta: 0 12px 32px rgba(79, 91, 255, 0.28);
  --shadow-reward: 0 16px 40px rgba(183, 255, 60, 0.2);
}
```

---

# 28. Final Design Rule

The app should feel like:

```txt
private club + luxury fintech + reward system + dark premium dashboard
```

It should not feel like:

```txt
regular banking app + crowded dashboard + colorful startup UI
```
