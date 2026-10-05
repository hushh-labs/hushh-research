#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(SCRIPT_DIR, "../..");
const REPO_ROOT = resolve(WEB_ROOT, "..");
const SOURCE_PATH = resolve(WEB_ROOT, "assets/brand/hushh-mark-source.png");
const CHECK_ONLY = process.argv.includes("--check");
const APP_ICON_BACKGROUND = "#1d1d1f";
// Android system surfaces can mask the adaptive launcher artwork. Keep its
// required background separate and light so the transparent Hussh mark does
// not acquire a dark circular plate on a light system sheet.
const ANDROID_APP_ICON_BACKGROUND = "#ffffff";
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
const trimmedMark = await sharp(source)
  .trim({ background: TRANSPARENT })
  .png()
  .toBuffer();

async function markLayer(canvasWidth, canvasHeight, markWidth, markHeight) {
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
}) {
  const x = Math.round((width - markWidth) / 2);
  const y = Math.round((height - markHeight) / 2);
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n` +
      `  <rect width="${width}" height="${height}" fill="${APP_ICON_BACKGROUND}"/>\n` +
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

// Browser/PWA/SEO/mail icons keep the established dark canvas and optical
// footprint while swapping only the face artwork.
const webIcon = await opaqueIcon(512, 512, 280, 292);
await emit("public/quiet-emoji-icon.png", webIcon);
await emit("public/hushh-maskable-icon.png", webIcon);
await emit(
  "public/quiet-emoji-icon.svg",
  embeddedIconSvg({
    width: 512,
    height: 512,
    markWidth: 280,
    markHeight: 292,
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
    markWidth: 560,
    markHeight: 586,
    embeddedPng: trimmedMark,
  }),
);
const faviconSizes = [16, 32, 48, 64];
const faviconImages = [];
for (const size of faviconSizes) {
  const opaqueFrame = await opaqueIcon(
    size,
    size,
    Math.max(1, Math.round((280 / 512) * size)),
    Math.max(1, Math.round((292 / 512) * size)),
  );
  faviconImages.push({
    size,
    // Next's ICO decoder requires embedded PNG frames to use RGBA even when
    // every pixel is opaque.
    buffer: await sharp(opaqueFrame).ensureAlpha(1).png().toBuffer(),
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

// Android launcher files retain every existing canvas and optical footprint.
// Legacy launchers need an opaque canvas, while adaptive launchers require a
// transparent foreground and a separate solid background. Baking the dark
// canvas into the foreground would surface as an unintended black circle when
// a system surface applies its own mask.
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
  const adaptiveForeground = await markLayer(size, size, markWidth, markHeight);
  const adaptiveBackground = await solidPng(
    size,
    size,
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
