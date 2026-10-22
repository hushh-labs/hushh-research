#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { JSDOM } from "jsdom";
import { renderNavigationArtwork } from "../../components/icons/native-navigation-artwork.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(SCRIPT_DIR, "../..");
const REPO_ROOT = resolve(WEB_ROOT, "..");
const SOURCE_PATH = resolve(WEB_ROOT, "assets/brand/hushh-mark-source.svg");
const CHECK_ONLY = process.argv.includes("--check");
const APP_ICON_BACKGROUND = "#1d1d1f";
// Android launcher and Google Play surfaces retain the existing premium dark
// production treatment. The transparent mark is kept separate so Android can
// apply its own mask without introducing an extra plate, border, or shadow.
const ANDROID_APP_ICON_BACKGROUND = APP_ICON_BACKGROUND;
const LIGHT_SPLASH_BACKGROUND = "#ffffff";
const IOS_DARK_SPLASH_BACKGROUND = "#111111";
const ANDROID_DARK_SPLASH_BACKGROUND = "#151515";
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

const changed = [];
const stale = [];

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const ICO_SIGNATURE = Buffer.from([0x00, 0x00, 0x01, 0x00]);
const MAX_RASTER_CHANNEL_DELTA = 1;
const MAX_RASTER_CHANGED_CHANNELS = 4;

function hasSignature(buffer, signature) {
  return (
    buffer.length >= signature.length &&
    buffer.subarray(0, signature.length).equals(signature)
  );
}

async function pngPixelsMatch(existing, expected) {
  try {
    const [existingImage, expectedImage] = await Promise.all([
      sharp(existing).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
      sharp(expected).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    ]);

    if (
      existingImage.info.width !== expectedImage.info.width ||
      existingImage.info.height !== expectedImage.info.height ||
      existingImage.info.channels !== expectedImage.info.channels ||
      existingImage.data.length !== expectedImage.data.length
    ) {
      return false;
    }

    let changedChannels = 0;
    for (let index = 0; index < existingImage.data.length; index += 1) {
      const delta = Math.abs(
        existingImage.data[index] - expectedImage.data[index],
      );
      if (delta > MAX_RASTER_CHANNEL_DELTA) return false;
      if (delta > 0) {
        changedChannels += 1;
        if (changedChannels > MAX_RASTER_CHANGED_CHANNELS) return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

function decodeIcoFrames(buffer) {
  if (!hasSignature(buffer, ICO_SIGNATURE) || buffer.length < 6) return null;

  const count = buffer.readUInt16LE(4);
  const directoryEnd = 6 + count * 16;
  if (count === 0 || directoryEnd > buffer.length) return null;

  const frames = [];
  for (let index = 0; index < count; index += 1) {
    const entryOffset = 6 + index * 16;
    const frameLength = buffer.readUInt32LE(entryOffset + 8);
    const frameOffset = buffer.readUInt32LE(entryOffset + 12);
    const frameEnd = frameOffset + frameLength;
    if (
      frameOffset < directoryEnd ||
      frameEnd < frameOffset ||
      frameEnd > buffer.length
    ) {
      return null;
    }

    const encodedWidth = buffer.readUInt8(entryOffset);
    const encodedHeight = buffer.readUInt8(entryOffset + 1);
    frames.push({
      width: encodedWidth === 0 ? 256 : encodedWidth,
      height: encodedHeight === 0 ? 256 : encodedHeight,
      planes: buffer.readUInt16LE(entryOffset + 4),
      bitDepth: buffer.readUInt16LE(entryOffset + 6),
      buffer: buffer.subarray(frameOffset, frameEnd),
    });
  }

  return frames;
}

async function icoFramesMatch(existing, expected) {
  const existingFrames = decodeIcoFrames(existing);
  const expectedFrames = decodeIcoFrames(expected);
  if (
    existingFrames === null ||
    expectedFrames === null ||
    existingFrames.length !== expectedFrames.length
  ) {
    return false;
  }

  for (let index = 0; index < existingFrames.length; index += 1) {
    const existingFrame = existingFrames[index];
    const expectedFrame = expectedFrames[index];
    if (
      existingFrame.width !== expectedFrame.width ||
      existingFrame.height !== expectedFrame.height ||
      existingFrame.planes !== expectedFrame.planes ||
      existingFrame.bitDepth !== expectedFrame.bitDepth ||
      !hasSignature(existingFrame.buffer, PNG_SIGNATURE) ||
      !hasSignature(expectedFrame.buffer, PNG_SIGNATURE) ||
      !(await pngPixelsMatch(existingFrame.buffer, expectedFrame.buffer))
    ) {
      return false;
    }
  }

  return true;
}

async function generatedAssetMatches(existing, expected) {
  if (existing.equals(expected)) return true;

  // libvips resampling can round a handful of channels by one level across
  // native and WASM/Linux/macOS backends. Keep that tolerance deliberately
  // tiny; dimensions must match and any real pixel drift still fails. Text
  // assets remain byte-for-byte reproducible.
  if (
    hasSignature(existing, PNG_SIGNATURE) &&
    hasSignature(expected, PNG_SIGNATURE)
  ) {
    return pngPixelsMatch(existing, expected);
  }
  if (
    hasSignature(existing, ICO_SIGNATURE) &&
    hasSignature(expected, ICO_SIGNATURE)
  ) {
    return icoFramesMatch(existing, expected);
  }

  return false;
}

async function emit(path, buffer) {
  const absolutePath = resolve(WEB_ROOT, path);
  if (CHECK_ONLY) {
    try {
      const existing = await readFile(absolutePath);
      if (!(await generatedAssetMatches(existing, buffer))) stale.push(path);
    } catch {
      stale.push(path);
    }
    return;
  }

  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, buffer);
  changed.push(path);
}

async function emitRepo(path, buffer) {
  const absolutePath = resolve(REPO_ROOT, path);
  if (CHECK_ONLY) {
    try {
      const existing = await readFile(absolutePath);
      if (!(await generatedAssetMatches(existing, buffer))) {
        stale.push(`../${path}`);
      }
    } catch {
      stale.push(`../${path}`);
    }
    return;
  }

  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, buffer);
  changed.push(`../${path}`);
}

const source = await readFile(SOURCE_PATH);
// Keep the historical raster source path as a generated compatibility asset.
await emit(
  "assets/brand/hushh-mark-source.png",
  await sharp(source).png().toBuffer(),
);
const { data: trimmedMark, info: trimmedMarkInfo } = await sharp(source)
  .trim({ background: TRANSPARENT })
  .png()
  .toBuffer({ resolveWithObject: true });

async function markLayer(
  canvasWidth,
  canvasHeight,
  markWidth,
  markHeight,
) {
  const mark = await sharp(trimmedMark)
    .resize(markWidth, markHeight, {
      fit: "contain",
      background: TRANSPARENT,
      kernel: sharp.kernel.lanczos3,
    })
    .png()
    .toBuffer();

  return sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 4,
      background: TRANSPARENT,
    },
  })
    .composite([
      {
        input: mark,
        left: Math.round((canvasWidth - markWidth) / 2),
        top: Math.round((canvasHeight - markHeight) / 2),
      },
    ])
    .png()
    .toBuffer();
}

async function opaqueIcon(
  canvasWidth,
  canvasHeight,
  markWidth,
  markHeight,
  background = APP_ICON_BACKGROUND,
) {
  const layer = await markLayer(
    canvasWidth,
    canvasHeight,
    markWidth,
    markHeight,
  );
  return sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 3,
      background,
    },
  })
    .composite([{ input: layer, left: 0, top: 0 }])
    .removeAlpha()
    .png()
    .toBuffer();
}

async function opaqueIconWithAlpha(
  canvasWidth,
  canvasHeight,
  markWidth,
  markHeight,
  background = APP_ICON_BACKGROUND,
) {
  const layer = await markLayer(
    canvasWidth,
    canvasHeight,
    markWidth,
    markHeight,
  );
  return sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 4,
      background,
    },
  })
    .composite([{ input: layer, left: 0, top: 0 }])
    .ensureAlpha(1)
    .png()
    .toBuffer();
}

async function solidPng(width, height, background) {
  return sharp({
    create: { width, height, channels: 3, background },
  })
    .png()
    .toBuffer();
}

function embeddedIconSvg({
  width,
  height,
  markWidth,
  markHeight,
  embeddedPng,
  transparent = false,
}) {
  const x = Math.round((width - markWidth) / 2);
  const y = Math.round((height - markHeight) / 2);
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n` +
      (transparent ? "" : `  <rect width="${width}" height="${height}" fill="${APP_ICON_BACKGROUND}"/>\n`) +
      `  <image href="data:image/png;base64,${embeddedPng.toString("base64")}" x="${x}" y="${y}" width="${markWidth}" height="${markHeight}" preserveAspectRatio="xMidYMid meet"/>\n` +
      `</svg>\n`,
  );
}

function encodeIco(images) {
  const headerSize = 6;
  const entrySize = 16;
  let offset = headerSize + entrySize * images.length;
  const directory = Buffer.alloc(offset);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(images.length, 4);

  images.forEach(({ size, buffer }, index) => {
    const entryOffset = headerSize + index * entrySize;
    directory.writeUInt8(size >= 256 ? 0 : size, entryOffset);
    directory.writeUInt8(size >= 256 ? 0 : size, entryOffset + 1);
    directory.writeUInt8(0, entryOffset + 2);
    directory.writeUInt8(0, entryOffset + 3);
    directory.writeUInt16LE(1, entryOffset + 4);
    directory.writeUInt16LE(32, entryOffset + 6);
    directory.writeUInt32LE(buffer.length, entryOffset + 8);
    directory.writeUInt32LE(offset, entryOffset + 12);
    offset += buffer.length;
  });

  return Buffer.concat([directory, ...images.map(({ buffer }) => buffer)]);
}

// One transparent runtime mark. It has no theme-specific pixels; callers own
// their existing host dimensions while this asset supplies identical artwork.
const runtimeMark = await markLayer(512, 512, 478, 512);
await emit("public/brand/hushh-mark.png", runtimeMark);
await emit("public/brand/hushh-mark.svg", source);

// Browser icons use a transparent canvas and a generous, centered mark.
// Keep a small safe margin so the artwork is legible without clipping at 16px.
const webIcon = await markLayer(512, 512, 448, 480);
await emit("public/quiet-emoji-icon.png", webIcon);
await emit("public/hushh-maskable-icon.png", await opaqueIcon(512, 512, 280, 292));
await emit(
  "public/quiet-emoji-icon.svg",
  embeddedIconSvg({
    width: 512,
    height: 512,
    markWidth: 448,
    markHeight: 480,
    transparent: true,
    embeddedPng: trimmedMark,
  }),
);
await emit("public/hushh_icon.png", await opaqueIcon(256, 256, 140, 146));

await emit("app/apple-icon.png", await opaqueIcon(180, 180, 98, 103));
await emit(
  "app/icon.svg",
  embeddedIconSvg({
    width: 1024,
    height: 1024,
    markWidth: 896,
    markHeight: 960,
    transparent: true,
    embeddedPng: trimmedMark,
  }),
);
const faviconSizes = [16, 32, 48, 64];
const faviconImages = [];
for (const size of faviconSizes) {
  const transparentFrame = await markLayer(
    size,
    size,
    Math.max(1, Math.round((448 / 512) * size)),
    Math.max(1, Math.round((480 / 512) * size)),
  );
  faviconImages.push({
    size,
    // Preserve RGBA transparency in every ICO resolution.
    buffer: transparentFrame,
  });
}
await emit("app/favicon.ico", encodeIco(faviconImages));

// Historical Capacitor inputs and older browser icon outputs remain aligned so
// a future generation command cannot silently restore the gradient S artwork.
const sourceIcon = await opaqueIcon(256, 256, 140, 146);
await emit("assets/icon.png", sourceIcon);
await emit("assets/icon-only.png", sourceIcon);
await emit("assets/icon-foreground.png", await markLayer(256, 256, 140, 146));
await emit(
  "assets/icon-background.png",
  await solidPng(256, 256, APP_ICON_BACKGROUND),
);
for (const size of [48, 72, 96, 128, 192, 256, 512]) {
  await emit(
    `icons/icon-${size}.webp`,
    await opaqueIcon(
      size,
      size,
      Math.max(1, Math.round((280 / 512) * size)),
      Math.max(1, Math.round((292 / 512) * size)),
    ),
  );
}

// iOS and Wallet require opaque, square sources without pre-rounded corners.
// Native tabs project the same registry descriptor as web/Android. Alpha carries
// Phosphor's duotone; UIKit owns the accent, foreground and selection material.
const navigationIcons = JSON.parse(await readFile(
  resolve(WEB_ROOT, "components/icons/bottom-navigation-icons.json"), "utf8",
));
for (const [tab, definition] of Object.entries(navigationIcons)) {
  for (const selected of [false, true]) {
    const variant = selected ? "selected" : "default";
    const directory = `ios/App/App/Assets.xcassets/HushhNav-${tab}-${variant}.imageset`;
    const svg = Buffer.from(renderNavigationArtwork(definition, selected));
    const images = [];
    for (const scale of [1, 2, 3]) {
      const filename = `icon@${scale}x.png`;
      await emit(`${directory}/${filename}`, await sharp(svg).resize(24 * scale, 24 * scale).png().toBuffer());
      images.push({ filename, idiom: "universal", scale: `${scale}x` });
    }
    await emit(`${directory}/Contents.json`, Buffer.from(JSON.stringify({
      images, info: { author: "xcode", version: 1 },
      properties: { "template-rendering-intent": "template" },
    }, null, 2) + "\n"));
  }
}

// Render the actual shared Profile roster. Do not maintain a second vector or
// SF Symbol mapping. Template alpha preserves duotone; an optional second
// layer preserves the account glyphs' app-authoritative accent strokes.
const profileAssets = [];
const profileGlyphSize = 28; // Shared SettingsRow glyph, inside its 32-point well.
// The key's pinpoint is deliberately Blue even when the app accent is Gold.
// Read that existing authored token; native artwork must not invent a palette.
const profileStyles = await readFile(resolve(WEB_ROOT, "app/globals.css"), "utf8");
const keyAccentHex = profileStyles.match(/--accent-preview-blue:\s*(#[0-9a-f]{6})\s*;/i)?.[1];
if (!keyAccentHex) throw new Error("Missing canonical Blue artwork token");
const destructiveHex = profileStyles.match(/--app-destructive:\s*(#[0-9a-f]{6})\s*;/i)?.[1];
if (!destructiveHex) throw new Error("Missing canonical destructive artwork token");
const profileLoader = await createServer({
  configFile: false, root: WEB_ROOT, appType: "custom", logLevel: "error",
  resolve: { alias: { "@": WEB_ROOT } },
  server: { middlewareMode: true, watch: null },
  oxc: { jsx: { runtime: "automatic" } },
});
try {
  const { PROFILE_MENU_GROUPS } = await profileLoader.ssrLoadModule("/components/profile/profile-menu-model.ts");
  const rows = await profileLoader.ssrLoadModule("/components/icons/agents/row-icons.tsx");
  const { PROFILE_ICONS } = await profileLoader.ssrLoadModule("/components/icons/profile-icons.ts");
  const payoutInnerIcons = await profileLoader.ssrLoadModule("/components/profile/profile-inner-icons.tsx");
  const payoutSecondaryIcons = await profileLoader.ssrLoadModule("/components/profile/profile-secondary-icons.tsx");
  const { GeminiLogo } = await profileLoader.ssrLoadModule("/components/brand/gemini-logo.tsx");
  const formIcons = [
    { id: "style-name", icon: rows.PreferredNameRowIcon },
    { id: "style-tone", icon: rows.ToneRowIcon },
    { id: "style-length", icon: rows.ReplyLengthRowIcon },
    { id: "style-language", icon: rows.LanguageRowIcon },
    { id: "style-punctuation", icon: rows.PunctuationRowIcon },
    { id: "account-name", icon: PROFILE_ICONS.name },
    { id: "account-mail", icon: PROFILE_ICONS.mail },
    { id: "account-phone", icon: PROFILE_ICONS.phone },
    { id: "account-wallet", icon: PROFILE_ICONS.wallet },
    { id: "account-reset", icon: PROFILE_ICONS.reset },
    { id: "account-delete", icon: PROFILE_ICONS.delete },
    { id: "appearance", icon: PROFILE_ICONS.appearance },
    { id: "accent", icon: PROFILE_ICONS.accent },
    { id: "voice", icon: PROFILE_ICONS.voice },
    { id: "vault-methods", icon: PROFILE_ICONS.vault },
    { id: "vault-password", icon: PROFILE_ICONS.passphrase },
    { id: "payout-receipt", icon: payoutSecondaryIcons.ProfileSecondaryReceiptIcon },
    { id: "payout-warning", icon: payoutInnerIcons.ProfileInnerWarningIcon },
    { id: "payout-progress", icon: payoutInnerIcons.ProfileInnerProgressIcon },
    { id: "payout-review", icon: payoutInnerIcons.ProfileInnerReviewIcon },
    { id: "gemini", icon: GeminiLogo, original: true, size: 32 },
  ];
  for (const entry of [...PROFILE_MENU_GROUPS.flatMap(group => group.entries), ...formIcons]) {
    if (!/^[a-z][a-z-]*$/.test(entry.id)) throw new Error("Invalid authored Profile asset id");
    const glyphSize = entry.size ?? profileGlyphSize;
    const markup = renderToStaticMarkup(createElement(entry.icon, { size: glyphSize }));
    const document = new JSDOM(markup, { contentType: "image/svg+xml" }).window.document;
    const svg = document.documentElement;
    svg.setAttributeNS("http://www.w3.org/2000/xmlns/", "xmlns", "http://www.w3.org/2000/svg");
    const fill = svg.getAttribute("fill");
    const colorHex = svg.hasAttribute("data-trash-icon")
      ? destructiveHex
      : /^#[0-9a-f]{6}$/i.test(fill ?? "") ? fill : null;
    const original = entry.original === true;
    const accentColorHex = svg.querySelector('[fill="var(--app-key-accent)"]') ? keyAccentHex : null;
    const accentFill = fill === "var(--app-accent)";
    // Existing key/reset glyphs paint accent geometry through an SVG pattern.
    // Keep that authored paint server in both masks instead of recolouring or
    // dropping its combined path. Never replace its vector geometry.
    for (const paint of svg.querySelectorAll('[fill="var(--app-key-accent)"], [fill="var(--account-accent, var(--app-accent))"]')) {
      paint.setAttribute("data-profile-native-accent", "true");
      paint.setAttribute("fill", "#000000");
    }
    const accentSelector = ".profile-account-icon-accent, .profile-account-icon-accent-fill, .profile-pane-icon-accent, .profile-pane-icon-accent-fill, [data-profile-native-accent]";
    const hasAccent = accentFill || svg.querySelector(accentSelector) !== null;
    if (!original) {
      svg.setAttribute("style", "color:#000000");
      if (accentFill) svg.setAttribute("fill", "#000000");
      for (const node of [svg, ...svg.querySelectorAll("*")]) {
        for (const attribute of ["fill", "stroke"]) {
          if (/^#[0-9a-f]{6}$/i.test(node.getAttribute(attribute) ?? "")) node.setAttribute(attribute, "#000000");
        }
      }
    }
    for (const layer of hasAccent ? ["base", "accent"] : ["base"]) {
      const artwork = svg.cloneNode(true);
      for (const node of artwork.querySelectorAll("path,circle,rect,ellipse,line,polyline,polygon")) {
        const accented = accentFill || node.closest(accentSelector) !== null;
        const paintServer = ["fill", "stroke"].some(attribute =>
          /^url\(/.test(node.closest(`[${attribute}]`)?.getAttribute(attribute) ?? ""));
        if (!paintServer && ((layer === "base" && accented) || (layer === "accent" && !accented))) node.setAttribute("opacity", "0");
        if (node.matches(".profile-account-icon-accent-fill, .profile-pane-icon-accent-fill")) node.setAttribute("fill", "#000000");
      }
      const name = `HushhProfile-${entry.id}-${layer}`;
      const directory = `ios/App/App/Assets.xcassets/${name}.imageset`;
      const images = [];
      for (const scale of [1, 2, 3]) {
        const filename = `icon@${scale}x.png`;
        await emit(`${directory}/${filename}`, await sharp(Buffer.from(artwork.outerHTML))
          .resize(glyphSize * scale, glyphSize * scale).png().toBuffer());
        images.push({ filename, idiom: "universal", scale: `${scale}x` });
      }
      await emit(`${directory}/Contents.json`, Buffer.from(JSON.stringify({
        images, info: { author: "xcode", version: 1 },
        properties: { "template-rendering-intent": original ? "original" : "template" },
      }, null, 2) + "\n"));
    }
    profileAssets.push({ id: entry.id, colorHex, accentColorHex, hasAccent, original });
  }
  // The same authored vendor files/crop as ProfileConnectorGlyph. Match its
  // 22-point optical size in the shared 28-point native artwork well.
  const { CONNECTOR_ARTWORK } = await profileLoader.ssrLoadModule("/lib/profile/connector-artwork.ts");
  for (const [key, artwork] of Object.entries(CONNECTOR_ARTWORK)) {
    const id = `connector-${key.replaceAll("_", "-")}`;
    const directory = `ios/App/App/Assets.xcassets/HushhProfile-${id}-base.imageset`;
    const images = [];
    for (const scale of [1, 2, 3]) {
      let source = sharp(await readFile(resolve(WEB_ROOT, "public/icons/connectors", artwork.file)));
      if (artwork.crop) source = source.extract(artwork.crop);
      const inset = 3 * scale, filename = `icon@${scale}x.png`;
      await emit(`${directory}/${filename}`, await source.resize(22 * scale, 22 * scale, { fit: "contain", background: TRANSPARENT })
        .extend({ top: inset, bottom: inset, left: inset, right: inset, background: TRANSPARENT }).png().toBuffer());
      images.push({ filename, idiom: "universal", scale: `${scale}x` });
    }
    await emit(`${directory}/Contents.json`, Buffer.from(JSON.stringify({ images, info: { author: "xcode", version: 1 },
      properties: { "template-rendering-intent": artwork.monochrome ? "template" : "original" } }, null, 2) + "\n"));
    profileAssets.push({ id, colorHex: null, hasAccent: false, original: !artwork.monochrome });
  }
} finally { await profileLoader.close(); }
await emit("ios/App/App/Plugins/NativeProfileArtwork.swift", Buffer.from(`// Generated by scripts/design/generate-hushh-brand-assets.mjs. Do not edit.
// Source: Profile menu/icons and lib/profile/connector-artwork.ts.
import UIKit

enum NativeProfileArtwork {
    struct Artwork {
        let base: UIImage
        let accent: UIImage?
        let colorHex: String?
        let accentColorHex: String?
    }
    static let ids = [${profileAssets.map(entry => JSON.stringify(entry.id)).join(", ")}]
    static func resolve(_ id: String) -> Artwork? {
        let colorHex: String?
        let accentColorHex: String?
        let hasAccent: Bool
        let original: Bool
        switch id {
${profileAssets.map(entry => `        case ${JSON.stringify(entry.id)}: colorHex = ${entry.colorHex ? JSON.stringify(entry.colorHex) : "nil"}; accentColorHex = ${entry.accentColorHex ? JSON.stringify(entry.accentColorHex) : "nil"}; hasAccent = ${entry.hasAccent}; original = ${entry.original}`).join("\n")}
        default: return nil
        }
        guard let base = UIImage(named: "HushhProfile-\\(id)-base") else { return nil }
        let accent = hasAccent ? UIImage(named: "HushhProfile-\\(id)-accent") : nil
        guard !hasAccent || accent != nil else { return nil }
        return Artwork(base: base.withRenderingMode(original ? .alwaysOriginal : .alwaysTemplate),
                       accent: accent?.withRenderingMode(.alwaysTemplate), colorHex: colorHex, accentColorHex: accentColorHex)
    }
}
`));

const iosAppIcon = await opaqueIcon(1024, 1024, 560, 586);
await emit(
  "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png",
  iosAppIcon,
);
await emit(
  "ios/App/App/AppIcon.source.svg",
  embeddedIconSvg({
    width: 1024,
    height: 1024,
    markWidth: 560,
    markHeight: 586,
    embeddedPng: trimmedMark,
  }),
);
await emitRepo(
  "consent-protocol/hushh_mcp/services/pass_assets/hushh_pass_icon.png",
  iosAppIcon,
);

// Keep the legacy splash artwork's measured light/dark heights. The three iOS
// scale files share one 2732px canvas, so normalizing by scale would resize it.
for (const filename of [
  "Default@1x~universal~anyany.png",
  "Default@2x~universal~anyany.png",
  "Default@3x~universal~anyany.png",
]) {
  await emit(
    `ios/App/App/Assets.xcassets/Splash.imageset/${filename}`,
    await opaqueIcon(2732, 2732, 202, 202, LIGHT_SPLASH_BACKGROUND),
  );
}
for (const filename of [
  "Default@1x~universal~anyany-dark.png",
  "Default@2x~universal~anyany-dark.png",
  "Default@3x~universal~anyany-dark.png",
]) {
  await emit(
    `ios/App/App/Assets.xcassets/Splash.imageset/${filename}`,
    await opaqueIcon(2732, 2732, 203, 203, IOS_DARK_SPLASH_BACKGROUND),
  );
}

// Android launcher files retain every legacy canvas and optical footprint.
// Legacy launchers need an opaque canvas, while adaptive launchers require a
// transparent foreground and a separate solid background. Adaptive layers are
// 108dp square (rather than the 48dp legacy size); keep the actual artwork in
// the centered 66dp safe zone so circular, squircle, and rounded-square masks
// neither crop nor double-shrink it. Baking a dark canvas into the foreground
// would surface as an unintended black circle when a system surface applies
// its own mask.
const androidLaunchers = [
  ["ldpi", 36, 20, 22],
  ["mdpi", 48, 26, 28],
  ["hdpi", 72, 40, 43],
  ["xhdpi", 96, 52, 56],
  ["xxhdpi", 144, 78, 83],
  ["xxxhdpi", 192, 105, 110],
];
for (const [density, size, markWidth, markHeight] of androidLaunchers) {
  const legacyIcon = await opaqueIcon(
    size,
    size,
    markWidth,
    markHeight,
    ANDROID_APP_ICON_BACKGROUND,
  );
  const adaptiveCanvas = Math.round(size * 2.25);
  const adaptiveMarkHeight = Math.round((62 / 108) * adaptiveCanvas);
  const adaptiveMarkWidth = Math.round(
    (trimmedMarkInfo.width / trimmedMarkInfo.height) * adaptiveMarkHeight,
  );
  const adaptiveForeground = await markLayer(
    adaptiveCanvas,
    adaptiveCanvas,
    adaptiveMarkWidth,
    adaptiveMarkHeight,
  );
  const adaptiveBackground = await solidPng(
    adaptiveCanvas,
    adaptiveCanvas,
    ANDROID_APP_ICON_BACKGROUND,
  );

  await emit(
    `android/app/src/main/res/mipmap-${density}/ic_launcher.png`,
    legacyIcon,
  );
  await emit(
    `android/app/src/main/res/mipmap-${density}/ic_launcher_round.png`,
    legacyIcon,
  );
  await emit(
    `android/app/src/main/res/mipmap-${density}/ic_launcher_foreground.png`,
    adaptiveForeground,
  );
  await emit(
    `android/app/src/main/res/mipmap-${density}/ic_launcher_background.png`,
    adaptiveBackground,
  );
}

await emit(
  "android/app/src/main/res/drawable/ic_launcher_foreground_inset.xml",
  Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<bitmap xmlns:android="http://schemas.android.com/apk/res/android"\n` +
      `    android:gravity="fill"\n` +
      `    android:src="@mipmap/ic_launcher_foreground" />\n`,
  ),
);

// Google Play listing artwork is Console-managed, but it must stay visually
// identical to the established dark Android identity. Keep a ready-to-upload,
// full-bleed 512px RGBA PNG in an Android-only path; the release workflow
// deliberately uploads only the AAB and never mutates the store listing.
await emit(
  "assets/android/play-store-icon-512.png",
  await opaqueIconWithAlpha(512, 512, 280, 292, ANDROID_APP_ICON_BACKGROUND),
);

await emit(
  "android/app/src/main/res/values/ic_launcher_background.xml",
  Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<resources>\n` +
      `    <color name="ic_launcher_background">${ANDROID_APP_ICON_BACKGROUND.toUpperCase()}</color>\n` +
      `</resources>\n`,
  ),
);

// Each Android entry records the existing canvas and measured mark height.
// Portrait and landscape intentionally share the density-specific footprint.
const androidSplashes = [
  ["drawable/splash.png", 320, 480, 62, false],
  ["drawable-night/splash.png", 320, 240, 48, true],
  ["drawable-port-ldpi/splash.png", 240, 320, 46, false],
  ["drawable-port-mdpi/splash.png", 320, 480, 62, false],
  ["drawable-port-hdpi/splash.png", 480, 800, 90, false],
  ["drawable-port-xhdpi/splash.png", 720, 1280, 136, false],
  ["drawable-port-xxhdpi/splash.png", 960, 1600, 180, false],
  ["drawable-port-xxxhdpi/splash.png", 1280, 1920, 241, false],
  ["drawable-port-night-ldpi/splash.png", 240, 320, 48, true],
  ["drawable-port-night-mdpi/splash.png", 320, 480, 63, true],
  ["drawable-port-night-hdpi/splash.png", 480, 800, 91, true],
  ["drawable-port-night-xhdpi/splash.png", 720, 1280, 137, true],
  ["drawable-port-night-xxhdpi/splash.png", 960, 1600, 182, true],
  ["drawable-port-night-xxxhdpi/splash.png", 1280, 1920, 240, true],
  ["drawable-land-ldpi/splash.png", 320, 240, 46, false],
  ["drawable-land-mdpi/splash.png", 480, 320, 62, false],
  ["drawable-land-hdpi/splash.png", 800, 480, 90, false],
  ["drawable-land-xhdpi/splash.png", 1280, 720, 136, false],
  ["drawable-land-xxhdpi/splash.png", 1600, 960, 180, false],
  ["drawable-land-xxxhdpi/splash.png", 1920, 1280, 241, false],
  ["drawable-land-night-ldpi/splash.png", 320, 240, 48, true],
  ["drawable-land-night-mdpi/splash.png", 480, 320, 63, true],
  ["drawable-land-night-hdpi/splash.png", 800, 480, 91, true],
  ["drawable-land-night-xhdpi/splash.png", 1280, 720, 137, true],
  ["drawable-land-night-xxhdpi/splash.png", 1600, 960, 182, true],
  ["drawable-land-night-xxxhdpi/splash.png", 1920, 1280, 240, true],
];
for (const [path, width, height, markSize, dark] of androidSplashes) {
  await emit(
    `android/app/src/main/res/${path}`,
    await opaqueIcon(
      width,
      height,
      markSize,
      markSize,
      dark ? ANDROID_DARK_SPLASH_BACKGROUND : LIGHT_SPLASH_BACKGROUND,
    ),
  );
}

if (CHECK_ONLY) {
  if (stale.length > 0) {
    console.error("Hussh brand assets are stale:");
    for (const path of stale) console.error(`- ${path}`);
    process.exitCode = 1;
  } else {
    console.log("Hussh brand assets match the canonical source.");
  }
} else {
  console.log(`Generated ${changed.length} Hussh brand assets.`);
}
