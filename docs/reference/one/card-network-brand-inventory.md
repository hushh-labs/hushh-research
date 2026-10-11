# Card network brand inventory

## Visual Context

This inventory sits below the [Hussh One Index](./README.md) beside the
[Wallet](./wallet.md) contract, and follows the same rules as the
[Runtime provider brand inventory](./runtime-provider-brand-inventory.md).
It records the network marks shown against a card the owner already holds in
their own wallet. A card mark identifies a card; it never selects a payment
method, authorises a charge, or implies a partnership with the network.

## Why a card may show a generic icon instead

`components/wallet/card-network-mark.tsx` renders in two tiers. When a network's
official artwork is recorded in `CARD_MARK_ASSETS`, that artwork renders
unmodified in a transparent cell. Until then the brand uses a generic card icon
with its network name. The icon is not network artwork.

Nothing about the detection changes between the tiers: `detectBrand` in
`hushh-webapp/lib/wallet/card-validation.ts` already classifies every card from
its BIN, and the mark simply reflects what it found.

## Inventory

| Network shown in Wallet | Local asset | Source record |
| --- | --- | --- |
| Visa | _not yet recorded_ | [Visa brand centre](https://usa.visa.com/run-your-business/small-business-tools/payment-technology/visa-brand-guidelines.html) |
| Mastercard | _not yet recorded_ | [Mastercard brand centre](https://brand.mastercard.com/brandcenter/mastercard-brand-mark.html) |
| American Express | `hushh-webapp/public/brand/cards/amex.svg` | [American Express static logo](https://www.aexp-static.com/cdaas/one/statics/axp-static-assets/1.8.0/package/dist/img/logos/dls-logo-bluebox-solid.svg), linked by its merchant site |
| Discover | `hushh-webapp/public/brand/cards/discover.svg` | [Discover Global Network logo](https://www.discoverglobalnetwork.com/content/dam/discover/en_us/dgn/images/global/logos/discover-network-logo.svg) |
| RuPay | `hushh-webapp/public/brand/cards/rupay-transparent.png` | User-supplied RuPay reference, 2026-10-10 (`codex-clipboard-4aa9c7eb-cc2f-4edb-ade3-1c6cb340a832.png`); white background removed with ImageGen at the user's request on 2026-10-11 |
| JCB | `hushh-webapp/public/brand/cards/jcb.svg` | [JCB emblem](https://www.global.jcb/en/common/images/svg/jcb_emblem_logo.svg) |
| UnionPay | `hushh-webapp/public/brand/cards/unionpay.png` | [UnionPay International logo](https://www.unionpayintl.com/imp_file/global/en/static/images/logo.png) |
| Mir | _not yet recorded_ | [NSPK Mir brand](https://mironline.ru/) |
| Elo | _not yet recorded_ | [Elo brand](https://www.elo.com.br/) |
| Diners Club | `hushh-webapp/public/brand/cards/diners.svg` | [Diners Club header logo](https://www.dinersclub.com/content/experience-fragments/diners-club/home-header-xf/master/_jcr_content/root/header/image.coreimg.svg/1779939792007/dci-logo-default.svg) |
| Verve | _not yet recorded_ | [Verve brand](https://vervecard.com/) |

## Handling rules

These mirror the provider inventory, because the obligation is the same.

1. Keep the geometry unmodified and retain the source aspect ratio. Never
   recolour a network mark, and never place official artwork inside the
   coloured fallback tile.
2. Use a fixed transparent mark cell.
3. Record the source before adding an asset. An asset with no row in this table
   is not permitted, because nobody can then say where it came from.
4. The marks identify a card the owner already holds. Do not reuse them on
   marketing surfaces, next to a payment action, or anywhere that could read as
   an endorsement or an accepted-here claim.
5. Each network licenses its artwork under its own brand guidelines. Confirm the
   terms for the specific mark before recording it, and prefer the acceptance
   or brand mark the network publishes for identification use.

## Adding an asset

1. Obtain the file from the network's own brand resource, not from a third-party
   CDN or an icon pack.
2. Save it as `public/brand/cards/<brand>.svg` (or the original raster format), where `<brand>` is exactly the
   `CardBrand` value from `hushh-webapp/lib/wallet/card-validation.ts`.
3. Add the entry to `CARD_MARK_ASSETS` in
   `components/wallet/card-network-mark.tsx`.
4. Replace the `_not yet recorded_` cell above with the source link.

The mark then appears everywhere a card is shown: the Wallet list, the reveal
surface, and the Agent One chat card list. No other change is required.
