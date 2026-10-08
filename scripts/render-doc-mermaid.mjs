#!/usr/bin/env node
// Render every maintained Markdown Mermaid block with the web app's pinned
// Mermaid and Playwright Chromium. Keep artifacts under ignored tmp/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.join(root, 'hushh-webapp');
const requireWeb = createRequire(path.join(web, 'package.json'));
const { chromium } = requireWeb('playwright');
const mermaidBundle = requireWeb.resolve('mermaid/dist/mermaid.min.js');
const { runDiagramCheck } = createRequire(import.meta.url)('./verify-doc-diagrams.cjs');
const roots = ['docs', 'consent-protocol/docs', 'hushh-webapp/docs',
  'README.md', 'consent-protocol/README.md', 'hushh-webapp/README.md'];
const writeSvg = process.argv.includes('--write-svg');
const svgDirectory = path.join(root, 'tmp', 'doc-mermaid-svg');
const ignored = new Set(['node_modules', '.next', '.git', '.venv', 'dist', 'build']);
const blockPattern = /```mermaid\n([\s\S]*?)```/g;

function markdownFiles(relative) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) return [];
  if (fs.statSync(absolute).isFile()) return [relative];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory()) return ignored.has(entry.name) ? [] : markdownFiles(path.join(relative, entry.name));
    return entry.name.endsWith('.md') ? [path.join(relative, entry.name)] : [];
  });
}

const blocks = [];
for (const relative of roots.flatMap(markdownFiles).sort()) {
  const markdown = fs.readFileSync(path.join(root, relative), 'utf8');
  for (const match of markdown.matchAll(blockPattern)) {
    const source = match[1];
    blocks.push({
      path: relative.replaceAll(path.sep, '/'),
      line: markdown.slice(0, match.index).split('\n').length,
      index: blocks.filter(block => block.path === relative).length + 1,
      sha256: crypto.createHash('sha256').update(source).digest('hex'),
      source,
    });
  }
}

if (blocks.length === 0) throw new Error('No Mermaid blocks found');
const structural = runDiagramCheck({ workspaceRoot: root });
if (!structural.ok || structural.blocks !== blocks.length) {
  throw new Error(`Diagram inventory/structure mismatch: renderer=${blocks.length}, checker=${structural.blocks}, findings=${structural.findings.join('; ')}`);
}
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const results = [];
try {
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ path: mermaidBundle });
  await page.evaluate(() => {
    const mermaid = window.__esbuild_esm_mermaid_nm?.mermaid?.default;
    if (!mermaid) throw new Error('Pinned Mermaid bundle did not initialize');
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });
  });
  for (const [number, block] of blocks.entries()) {
    try {
      const svg = await page.evaluate(async ({ id, source }) => {
        const mermaid = window.__esbuild_esm_mermaid_nm.mermaid.default;
        return (await mermaid.render(id, source)).svg;
      }, { id: `doc_diagram_${number}`, source: block.source });
      if (!svg.includes('<svg') || !svg.includes('</svg>')) throw new Error('No SVG produced');
      const svgPath = writeSvg ? path.join(svgDirectory, `${String(number + 1).padStart(3, '0')}.svg`) : null;
      if (svgPath) {
        fs.mkdirSync(svgDirectory, { recursive: true });
        fs.writeFileSync(svgPath, svg);
      }
      results.push({ ...block, source: undefined, result: 'rendered', svgBytes: Buffer.byteLength(svg),
        ...(svgPath ? { artifact: path.relative(root, svgPath) } : {}) });
    } catch (error) {
      results.push({ ...block, source: undefined, result: 'failed', error: String(error) });
    }
  }
} finally {
  await browser.close();
}
const output = path.join(root, 'tmp', 'doc-mermaid-render-results.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ renderer: requireWeb('mermaid/package.json').version,
  browser: 'Playwright Chromium', count: blocks.length, results }, null, 2) + '\n');
const failed = results.filter(result => result.result !== 'rendered');
console.log(`Rendered ${blocks.length - failed.length}/${blocks.length} Mermaid diagrams with pinned Mermaid; ${output}`);
for (const result of failed) console.error(`${result.path}:${result.line}: ${result.error}`);
if (failed.length) process.exitCode = 1;
