/* Drives the dashboard page in Node with a tiny fake DOM: no browser, and no network
 * beyond the synthetic preview server on 127.0.0.1. Clicks every verdict button, Save,
 * filter and link the page shows, then prints one JSON report on stdout.
 *
 *   node dom_harness.js <static dir> http://127.0.0.1:<port> [full|engine]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const [staticDir, base, scenario = 'full'] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base || '')) {
  process.stderr.write('usage: node dom_harness.js <static dir> http://127.0.0.1:<port> [full|engine]\n');
  process.exit(2);
}

const report = { calls: [], errors: [], texts: {}, clicks: 0 };
process.on('unhandledRejection', (err) => report.errors.push(`unhandled rejection: ${(err && err.stack) || err}`));

// ---- A tiny DOM: just what app.js uses ------------------------------------------------

class TextNode {
  constructor(text) {
    this.nodeType = 3;
    this.data = String(text);
    this.parentNode = null;
  }

  get textContent() {
    return this.data;
  }
}

class ClassList {
  constructor(el) {
    this.el = el;
  }

  names() {
    return this.el.className.split(/\s+/).filter(Boolean);
  }

  add(...names) {
    this.el.className = Array.from(new Set(this.names().concat(names))).join(' ');
  }

  remove(...names) {
    this.el.className = this.names().filter((n) => !names.includes(n)).join(' ');
  }

  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : Boolean(force);
    if (on) this.add(name);
    else this.remove(name);
    return on;
  }

  contains(name) {
    return this.names().includes(name);
  }
}

class Element {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.attrs = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = {};
    this.className = '';
    this.classList = new ClassList(this);
    this.style = {};
    this.valueText = '';
  }

  setAttribute(name, value) {
    if (name === 'style') throw new Error('inline style attributes are blocked by the page CSP');
    if (name === 'class') this.className = String(value);
    else this.attrs.set(name, String(value));
  }

  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }

  hasAttribute(name) {
    return this.attrs.has(name);
  }

  removeAttribute(name) {
    this.attrs.delete(name);
  }

  get id() {
    return this.getAttribute('id') || '';
  }

  get hidden() {
    return this.hasAttribute('hidden');
  }

  set hidden(on) {
    if (on) this.setAttribute('hidden', '');
    else this.removeAttribute('hidden');
  }

  get disabled() {
    return this.hasAttribute('disabled');
  }

  set disabled(on) {
    if (on) this.setAttribute('disabled', '');
    else this.removeAttribute('disabled');
  }

  get value() {
    return this.valueText;
  }

  set value(v) {
    this.valueText = v === null || v === undefined ? '' : String(v);
  }

  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }

  get textContent() {
    return this.childNodes.map((n) => n.textContent).join('');
  }

  set textContent(v) {
    this.replaceChildren();
    if (v !== null && v !== undefined && v !== '') this.append(String(v));
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(typeof node === 'string' ? new TextNode(node) : node);
  }

  appendChild(node) {
    if (!node || (node.nodeType !== 1 && node.nodeType !== 3)) throw new Error(`append of a non-node: ${node}`);
    if (node.parentNode) node.parentNode.detach(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  detach(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentNode = null;
  }

  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }

  remove() {
    if (this.parentNode) this.parentNode.detach(this);
  }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }

  dispatch(type, extra) {
    const event = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...(extra || {}),
    };
    for (const fn of (this.listeners[type] || []).slice()) {
      try {
        fn(event);
      } catch (err) {
        report.errors.push(`${type} handler on ${this.tagName}: ${err.stack || err}`);
      }
    }
    return event;
  }

  click() {
    if (this.disabled) return false;
    this.dispatch('click');
    return true;
  }
}

// The page's fixed elements, read from index.html by id. Everything else app.js builds.
const html = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8');
const fixed = new Map();
for (const m of html.matchAll(/<(\w+)\b([^>]*)\bid="([^"]+)"([^>]*)>/g)) {
  const el = new Element(m[1]);
  el.setAttribute('id', m[3]);
  const attrs = `${m[2]} ${m[4]}`;
  const cls = /\bclass="([^"]*)"/.exec(attrs);
  if (cls) el.className = cls[1];
  if (/(^|\s)hidden(\s|$|=)/.test(attrs)) el.hidden = true;
  fixed.set(m[3], el);
}

function walk(el, visit) {
  visit(el);
  for (const child of el.children) walk(child, visit);
}

function findAll(root, test) {
  const out = [];
  walk(root, (el) => {
    if (test(el)) out.push(el);
  });
  return out;
}

function first(root, test) {
  return findAll(root, test)[0] || null;
}

const hasClass = (name) => (el) => el.classList.contains(name);
const button = (text) => (el) => el.tagName === 'BUTTON' && el.textContent === text;

const documentElement = new Element('html');
const document = {
  readyState: 'complete',
  title: '',
  documentElement,
  createElement: (tag) => new Element(tag),
  getElementById: (id) => {
    if (fixed.has(id)) return fixed.get(id);
    for (const root of fixed.values()) {
      const hit = first(root, (el) => el.id === id);
      if (hit) return hit;
    }
    return null;
  },
  addEventListener() {},
};
const $ = (id) => document.getElementById(id);

const storage = new Map();
const windowListeners = {};
const location = { hash: '' };
const window = {
  location,
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
  addEventListener: (type, fn) => (windowListeners[type] = windowListeners[type] || []).push(fn),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
};

// ---- fetch: record every call, send it to the preview server -------------------------

let pending = 0;
const realFetch = globalThis.fetch;

async function fetchShim(target, init) {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')) {
    report.errors.push(`fetch to a non-local path: ${target}`);
    throw new Error('blocked');
  }
  const method = (init && init.method) || 'GET';
  const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null;
  report.calls.push({ method, path: target, body });
  pending += 1;
  let res;
  try {
    res = await realFetch(base + target, init);
  } catch (err) {
    pending -= 1;
    throw err;
  }
  return {
    ok: res.ok,
    status: res.status,
    text: async () => {
      try {
        return await res.text();
      } finally {
        pending -= 1;
      }
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 4));

async function settle() {
  let quiet = 0;
  for (let i = 0; i < 5000 && quiet < 5; i += 1) {
    await tick();
    quiet = pending === 0 ? quiet + 1 : 0;
  }
}

async function click(el) {
  if (!el) {
    report.errors.push(`click on a missing element (${new Error().stack.split('\n')[2].trim()})`);
    return;
  }
  if (el.click()) report.clicks += 1;
  await settle();
}

async function go(hash) {
  const old = location.hash;
  location.hash = hash;
  for (const fn of windowListeners.hashchange || []) fn({ oldURL: `http://127.0.0.1/${old}`, newURL: `http://127.0.0.1/${hash}` });
  await settle();
}

const linksIn = (root) => findAll(root, (el) => el.tagName === 'A' && el.getAttribute('href')).map((a) => a.getAttribute('href'));

// ---- Judging: every verdict, note, Save and missed-file picker -------------------------

async function judgeAll(root, label) {
  for (const head of findAll(root, (el) => el.tagName === 'BUTTON' && hasClass('row-main')(el))) {
    if (head.getAttribute('aria-expanded') === 'false') await click(head);
  }
  const controls = findAll(root, hasClass('label-ctl'));
  for (const ctl of controls) {
    const verdicts = findAll(ctl, (el) => el.tagName === 'BUTTON' && /(^|\s)v-/.test(el.className));
    for (const b of verdicts) await click(b);
    const note = first(ctl, hasClass('note-input'));
    note.value = `${label} note`;
    await click(first(ctl, button('Save note')));
    const picker = first(ctl, (el) => el.tagName === 'SELECT');
    if (picker) {
      await click(verdicts.find((b) => b.classList.contains('v-missed')));
      const option = first(picker, (el) => el.tagName === 'OPTION' && el.getAttribute('value'));
      picker.value = option.getAttribute('value');
      picker.dispatch('change');
      await settle();
      report.texts[`${label}MissedNote`] = note.value;
    }
  }
  return controls.length;
}

async function judgePacket(view, key) {
  const card = first(view, hasClass('label-card'));
  const pick = (cls) => first(card, (el) => el.tagName === 'BUTTON' && el.classList.contains(cls));
  const save = first(card, button('Save check'));
  const reason = first(card, (el) => el.tagName === 'SELECT');
  const note = first(card, (el) => el.tagName === 'TEXTAREA');
  await click(pick('v-correct'));
  note.value = 'Looks right';
  await click(save);
  await click(pick('v-wrong'));
  reason.value = '';
  reason.dispatch('change');
  report.texts[`${key}WrongNeedsReason`] = save.disabled;
  await click(save);
  reason.value = 'wrong_period';
  reason.dispatch('change');
  await click(save);
  await click(pick('v-unsure'));
  await click(save);
  report.texts[`${key}Status`] = first(card, hasClass('save-status')).textContent;
}

// ---- Scenarios ---------------------------------------------------------------------------

async function engineOnly() {
  report.texts.engine = $('engine-strip').textContent;
  report.texts.engineClass = $('engine-strip').className;
}

async function full() {
  report.texts.engine = $('engine-strip').textContent;
  report.texts.engineClass = $('engine-strip').className;
  report.texts.owner = $('owner-line').textContent;
  report.texts.title = document.title;

  // Request: quick ranges, then the six-month ask on fixed dates.
  $('ask-prompt').value = 'I need six months of financial statements';
  await click($('range-8'));
  report.texts.range8 = [$('ask-start').value, $('ask-end').value];
  await click($('range-6'));
  report.texts.range6 = [$('ask-start').value, $('ask-end').value];
  $('ask-start').value = '2026-04-16';
  $('ask-end').value = '2026-10-15';
  $('ask-form').dispatch('submit');
  await settle();
  const result = $('ask-result');
  report.texts.askSections = findAll(result, hasClass('step-head')).map((el) => el.textContent);
  report.texts.askSummary = first(result, hasClass('summary-line')).textContent;
  report.texts.askMeta = first(result, hasClass('summary-detail')).textContent;
  report.texts.askAudit = first(result, hasClass('audit-head')).textContent;
  report.texts.askLead = findAll(result, hasClass('lead')).map((el) => el.textContent);
  report.texts.askLogs = first(result, (el) => el.tagName === 'SUMMARY').textContent;

  // The raw Drive rows: Dropped, a reason chip, the name filter.
  const rowsBlock = first(result, hasClass('rows-block'));
  const countRows = () => first(rowsBlock, (el) => el.tagName === 'TBODY').children.length;
  report.texts.driveRowsAll = countRows();
  await click(first(rowsBlock, (el) => el.tagName === 'BUTTON' && el.textContent.startsWith('Dropped')));
  report.texts.driveRowsDropped = countRows();
  await click(first(rowsBlock, (el) => el.tagName === 'BUTTON' && el.classList.contains('chip')));
  report.texts.driveRowsOneReason = countRows();
  await click(first(rowsBlock, (el) => el.tagName === 'BUTTON' && el.textContent.startsWith('All')));
  const search = first(rowsBlock, (el) => el.tagName === 'INPUT');
  search.value = 'bank';
  search.dispatch('input');
  report.texts.driveRowsBank = countRows();
  report.texts.askLabelControls = await judgeAll(result, 'ask');

  // Over a thousand Drive rows and 159 documents: the page shows them in steps.
  $('ask-prompt').value = 'many files';
  $('ask-form').dispatch('submit');
  await settle();
  const many = first($('ask-result'), hasClass('rows-block'));
  const foot = () => first(many, hasClass('table-foot')).textContent;
  const shown = () => first(many, (el) => el.tagName === 'TBODY').children.length;
  report.texts.many = [[shown(), foot()]];
  await click(first(many, (el) => el.tagName === 'BUTTON' && /^Show \d+ more$/.test(el.textContent)));
  report.texts.many.push([shown(), foot()]);
  await click(first(many, button('Show all')));
  report.texts.many.push([shown(), foot()]);
  const docRows = () =>
    findAll($('ask-result'), (el) => el.tagName === 'LI' && el.classList.contains('row') && first(el, hasClass('row-detail'))).length;
  report.texts.manyDocs = [docRows()];
  await click(first($('ask-result'), (el) => el.tagName === 'BUTTON' && el.parentNode && el.parentNode.classList.contains('more')));
  report.texts.manyDocs.push(docRows());

  // A failing engine call shows the reason and a Retry.
  $('ask-prompt').value = 'engine failure';
  $('ask-form').dispatch('submit');
  await settle();
  report.texts.failure = first($('ask-result'), hasClass('state-error')).textContent;
  report.texts.sendAfterFailure = $('ask-run').textContent;

  // Replays, including the preview of the 13 Oct mistake.
  const chips = findAll($('preset-list'), (el) => el.tagName === 'BUTTON');
  report.texts.presets = chips.map((c) => c.textContent);
  report.texts.replayAudits = [];
  for (const chip of chips) {
    await click(chip);
    report.texts.replayAudits.push({
      note: $('ask-preset-note').textContent,
      audit: first($('ask-result'), hasClass('audit-head')).textContent,
      failed: findAll($('ask-result'), hasClass('audit-note')).map((el) => el.textContent),
      flags: findAll($('ask-result'), hasClass('row-trail')).map((el) => el.textContent),
    });
  }
  await judgeAll($('ask-result'), 'regression');

  // The form refuses what the app refuses.
  $('ask-prompt').value = '';
  $('ask-form').dispatch('submit');
  report.texts.emptyPromptError = $('ask-error').textContent;
  $('ask-prompt').value = 'Bank statements';
  $('ask-start').value = '2026-01-01';
  $('ask-end').value = '';
  $('ask-form').dispatch('submit');
  report.texts.oneDateError = $('ask-error').textContent;
  $('ask-end').value = '2025-01-01';
  $('ask-form').dispatch('submit');
  report.texts.reversedError = $('ask-error').textContent;
  await settle();

  // Real requests: the list, then each request.
  await go('#/real');
  report.texts.realList = $('view-real').textContent;
  report.texts.realBanner = first($('view-real'), hasClass('banner-money')).textContent;
  report.texts.realLinks = linksIn($('view-real'));
  report.texts.real = {};
  for (const href of report.texts.realLinks) {
    await go(href);
    const view = $('view-real-detail');
    report.texts.real[href] = {
      sections: findAll(view, hasClass('step-head')).map((el) => el.textContent),
      text: view.textContent,
      banner: first(view, hasClass('banner-money')).textContent,
      controls: await judgeAll(view, 'real'),
    };
  }

  // Packets: filters, then each packet page.
  await go('#/packets');
  report.texts.packetFilters = {};
  for (const name of ['To check', 'Checked', 'You and AI disagree', 'All']) {
    await click(first($('view-packets'), button(name)));
    report.texts.packetFilters[name] = findAll($('view-packets'), hasClass('row')).length;
  }
  report.texts.packetList = $('view-packets').textContent;
  const packetLinks = linksIn($('view-packets'));
  report.texts.packetLinks = packetLinks;
  for (const href of packetLinks) {
    await go(href);
    await judgePacket($('view-packet'), href);
  }
  report.texts.packetPage = $('view-packet').textContent;

  // Accuracy: two numbers per kind, then a disagreement and back.
  await go('#/accuracy');
  report.texts.accuracy = $('view-accuracy').textContent;
  report.texts.bigNumbers = findAll($('view-accuracy'), hasClass('big')).map((el) => el.textContent);
  const disagreement = linksIn($('view-accuracy')).find((href) => href.startsWith('#/packets/'));
  report.texts.disagreementLink = disagreement || null;
  if (disagreement) {
    await go(disagreement);
    report.texts.backFromAccuracy = first($('view-packet'), hasClass('back')).textContent;
  }

  await go('#/health');
  report.texts.health = $('view-health').textContent;
  await click(first($('view-health'), button('Refresh')));

  await go('#/eval');
  report.texts.eval = $('view-eval').textContent;
  report.texts.evalLinks = linksIn($('view-eval'));

  await go('#/packets/not-a-synthetic-packet');
  report.texts.unknownPacket = $('view-packet').textContent;
  await go('#/real/not-a-synthetic-request');
  report.texts.unknownRequest = $('view-real-detail').textContent;

  await click($('theme-toggle'));
  report.texts.theme = [documentElement.getAttribute('data-theme'), $('theme-toggle').textContent];
  report.texts.hiddenViews = Array.from(fixed.values())
    .filter((el) => el.id.startsWith('view-') && !el.hidden)
    .map((el) => el.id);
}

async function main() {
  const context = vm.createContext({ window, document, fetch: fetchShim, URL, console, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(staticDir, 'app.js'), 'utf8'), context, { filename: 'app.js' });
  await settle();
  if (scenario === 'engine') await engineOnly();
  else await full();
  await settle();
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().catch((err) => {
  report.errors.push(`harness: ${err.stack || err}`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
});
