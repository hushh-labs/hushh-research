# Agent One card artwork

The versioned SVG files preserve the approved Profile, Referral, and emerald NWS art from the adjacent `agent-one-card-*.html` reference files. Embedded hushing artwork is retained from those references. These SVGs contain only public artwork; owner fields and real QR modules are added in memory by `lib/wallet/wallet-card-image.ts` for both the displayed face and PNG export.

Plus Jakarta Sans weights 400, 600, and 700 are embedded in WOFF2 form to keep browser rendering and local PNG export self-contained. The OFL license is included in `../../fonts/PlusJakartaSans/LICENSE.txt`. No external font or image request is required when an SVG is rendered.

The Jakarta artwork is `*-v2.svg`. Keep the earlier `*-v1.svg` artwork and its `Lexend-OFL.txt` license available for older cached app bundles and existing public asset URLs. New app code loads v2.

NWS shows the requested sample score of 900/1000 and has no QR on its face. The sample is identified in the accessible description and card details.

Bump the SVG filename version and its loader reference together whenever the public art changes. Do not save composed owner images or QR links in these assets.

## Focused export check

From `hushh-webapp`, run:

```sh
node scripts/verify-wallet-card-image-export.mjs
```

This headless Chromium and WebKit check exports all three actual PNG Files. It decodes Profile and Referral QR modules from PNG pixels, checks the distinct intended links, verifies the NWS sample and absent QR, and rejects external image/font requests. It uses no app account or live backend.
