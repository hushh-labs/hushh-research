# Connector brand assets

Official SVG assets, unmodified, retrieved 2026-09-24 (exceptions are noted per mark). These marks identify the
connected products; they are not Hussh capability icons.

- Gmail: https://www.gstatic.com/images/branding/productlogos/gmail_2026/v2/web/192px.svg
- Drive: https://www.gstatic.com/images/branding/productlogos/drive_2026/v2/web/192px.svg
- Calendar: https://www.gstatic.com/images/branding/productlogos/calendar_2026/v2/web/192px.svg
- Plaid: https://plaid.com/assets/img/favicons/safari-pinned-tab.svg
- Attio: https://attio.com/brand/v1/attio-logomark.svg (retrieved 2026-10-05; the logomark, unmodified.
  Attio's brand page asks that it is not warped, stretched, recoloured or redrawn, so the dark theme
  inverts it with CSS instead of editing the file)
- HubSpot: NOT an official HubSpot file. HubSpot's own brand assets are in a login-gated
  Brandfolder, so this is the sprocket glyph from the Simple Icons set (CC0 1.0),
  simple-icons@16.34.0, icons/hubspot.svg, retrieved 2026-10-05:
  https://cdn.jsdelivr.net/npm/simple-icons@16.34.0/icons/hubspot.svg
  The only change is the added fill="#FF7A59" on the root element (HubSpot's brand orange,
  per that package's data, which cites https://www.hubspot.com/style-guide). Replace it with
  the official file from HubSpot's Brandfolder when one is available. Whether Hushh may show
  HubSpot's mark is a decision recorded outside this repository.
- Notion: NOT an official Notion file. Notion's own brand assets are behind a sign-in, so this is
  the Notion mark from the Simple Icons set (CC0 1.0), simple-icons@16.34.0, icons/notion.svg,
  retrieved 2026-10-06:
  https://cdn.jsdelivr.net/npm/simple-icons@16.34.0/icons/notion.svg
  Unmodified. It is single-colour black (that package lists hex 000000, source https://www.notion.so),
  so the dark theme inverts it with CSS, as for Plaid and Attio. Replace it with the official file
  when one is available. Whether Hushh may show Notion's mark is a decision recorded outside this
  repository.

Google sources are linked from https://workspace.google.com/products/drive/;
the Plaid source is linked from https://plaid.com/; the Attio source is linked from
https://attio.com/brand. Serve these assets locally
so rendering the connector list does not contact the providers.
