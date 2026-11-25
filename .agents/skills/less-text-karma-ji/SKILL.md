---
name: less-text-karma-ji
description: "Use this skill when writing, reviewing, or redesigning interface copy. It removes unnecessary words, repeated ideas, robotic explanations, and visual noise while protecting clarity, context, and user confidence."
---

# Less Text Karma Ji

Use the least text needed for the person to understand and act confidently.
Improve understanding; add missing context when fewer words would make a choice unclear.
Clarity takes priority over a word count.

Apply the [repository operating contract](../../instructions.md). This portable
practice supports the existing product, design and release owners; it creates no
new workflow, approval requirement or authority to deploy.

## Start with the person's decision

Before rewriting, identify:

1. Who is reading: owner, recipient, buyer or another actor?
2. What state are they in: locked, waiting, ready, active, ended or uncertain?
3. What do they need to understand or decide now?
4. What is the next action, and what will it actually do?

Read the existing component, its callers and the action or state contract before
changing consequential wording. Shared copy may appear to several actors. A
short instruction that tells the wrong person to act is still wrong.

## Shape the screen

- Lead with the information or outcome that matters to this decision.
- Make one action dominant. Its label describes the result; keep secondary
  actions quieter and retain a clear way to cancel, go back or recover.
- Say each idea in its most useful place. Avoid repeating it across the page
  title, subtitle, card, description, button and confirmation.
- Remove introductions, decorative explanations, filler and implementation
  language. Keep a technical detail when it changes the person's decision.
- Use familiar grouping, selection, progress and icons where they communicate
  clearly. Do not explain what the layout already makes obvious.
- Whitespace is allowed. Do not add a subtitle or helper sentence just to fill it.
- Put optional explanation behind an existing detail surface when useful. Keep
  material terms visible before confirmation; a tooltip is not a substitute.
- Reuse the existing components, navigation and accessibility conventions.
  Shorter copy must still read well on narrow screens and with assistive tools.

For every element, ask: **Does the person need this now? Does it help their next
decision? Is it already shown? Would removing it lose meaning?** Remove or
rewrite what does not earn its place.

## Protect the meaning

Simplify language without weakening safety, privacy, consent, legal obligations,
accessibility, destructive-action warnings, financial consequences or recovery.

Where relevant, preserve:

- What information or resource is involved and who receives access.
- Purpose, permissions, duration, updates and important limitations.
- Exact amounts and units, currency, fees, possible debt and refund destination.
- When access, charges, expiry, cancellation and refunds actually take effect.
- What is irreversible and what the person can do when an action fails.

Do not silently round a consequential amount, obscure a fee, broaden consent or
replace a concrete limitation with reassuring language. Keep units and time zones
clear wherever ambiguity could change a decision.

Match the words to the actual state and authority:

- Use neutral status copy for shared surfaces unless the actor is explicit.
  **“Approved. Waiting for payment.”** works for both an owner and a buyer;
  **“Confirm payment”** belongs beside the buyer's action.
- A request sent, funds reserved, information prepared and access active are
  different outcomes. Name the observed outcome; keep unknown results uncertain.
- Show the effective deadline for the current action. **“Complete sharing by”**
  must use its actual cutoff, not a later outer expiry. Remove completed-step
  deadlines from the default view when they no longer help the person act.
- Describe the action the existing handler performs. Do not imply immediate
  delivery, payment, deletion or success when another step or acknowledgement
  is still required.

## Write like a person

Use calm, direct, natural English. Contractions are welcome. Avoid robotic
formality, corporate filler, promotional claims, unnecessary politeness and
instructions written only to occupy space.

Headings name the task. Buttons name the result. Status messages lead with the
outcome. Errors say what happened and what the person can do next, without blame
or unnecessary diagnostics. An empty state needs a clear state and one useful
next action; add context only when it helps.

| Instead of | Prefer |
| --- | --- |
| Everything you need to know about your payment | Review payment |
| Click here to view more information | View details |
| Your profile has been successfully updated | Profile updated |
| We were unable to complete your request at this time | Couldn't save changes. Try again. |
| You currently do not have any saved places | No saved places |
| Please select one of the following options to continue | Choose an option |
| Attributed processing costs | Payment fees |
| Refresh sharing request | Check again |

Use these as patterns, not substitutions made without context. “Continue” is
fine when its outcome is clear. Avoid “Submit,” “Proceed,” “Yes” or “Okay” when
the person needs to know what they are agreeing to. Reassurance and friendliness
must not replace a precise action or condition.

## Verify the experience proportionately

1. Review the screen in reading order: purpose, essential facts, current state,
   primary action and any recovery action. Check for repetition and competing
   emphasis. A few extra words are worthwhile if they prevent a wrong decision.
2. Trace affected shared-copy callers and relevant locked, waiting, error and
   terminal states. Keep actor, amounts, permissions and timing consistent with
   the existing contracts.
3. Use the nearest meaningful check for changed behavior or consequential
   meaning. Reuse unchanged evidence. Do not add tests merely to freeze every
   phrase, or repeat a complete acceptance journey for a wording change.
4. When available and authorized, inspect the actual interface with existing
   accounts and agreements. Look at what the person sees, including responsive
   and accessible presentation where affected. Do not create another payment,
   permission grant or destructive action just to inspect copy.
5. Follow the owning workflow's existing verification and release gates. This
   skill does not mandate new browser automation, screenshots or CI suites.
   Distinguish source review, tests and observations of an identified deployed
   revision. Do not call a local edit live or claim unobserved states passed.

Word counts and screenshots can help diagnose noise, but they do not prove
understanding or justify hiding a consequence. Judge whether the person can
quickly tell where they are, what matters and what happens next. Avoid
“best-in-class” claims without evidence.

## Return useful work

Provide the exact replacement copy in screen order; do not stop at “too much
text.” For a larger review, use **Keep**, **Remove**, **Replace** or **Final screen
copy** when they help. Do not repeat the same copy in a comparison and a full
screen unless both are needed.

For implementation work, report what changed, which states were verified and any
remaining limitation or release step. Keep the handoff as focused as the product.
