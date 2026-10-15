/* Manish's Drive check: a local, read-only dashboard page.
 *
 * One owner, Manish; there is no owner picker. Every request goes through API
 * below, whose paths and bodies are exactly the dashboard API contract, and the
 * page makes no other network call. Server data is only ever rendered as text.
 */
(function () {
  'use strict';

  // ---- Contract ------------------------------------------------------------------

  const PACKET_VERDICT_VALUES = ['correct', 'wrong', 'unsure'];
  const REQUEST_VERDICT_VALUES = ['right', 'wrong', 'unsure', 'missed'];
  const WRONG_REASON_VALUES = ['wrong_period', 'wrong_person', 'duplicate', 'overclaims_complete', 'other'];

  // A picked document is judged Right or Wrong (precision). A document that was left
  // out can only be reported Missed (recall). The whole answer takes all four verdicts.
  const PICKED_VERDICTS = ['right', 'wrong', 'unsure'];
  const LEFT_OUT_VERDICTS = ['missed', 'unsure'];

  const enc = encodeURIComponent;
  const API = Object.freeze({
    engine: () => request('GET', '/api/engine'),
    owner: () => request('GET', '/api/owner'),
    health: () => request('GET', '/api/health'),
    packets: () => request('GET', '/api/packets'),
    packet: (packetId) => request('GET', `/api/packets/${enc(packetId)}`),
    labelPacket: (packetId, verdict, reason, note) =>
      request('POST', `/api/packets/${enc(packetId)}/label`, { verdict, reason, note }),
    requests: () => request('GET', '/api/requests'),
    realRequest: (requestId) => request('GET', `/api/requests/${enc(requestId)}`),
    labelRequest: (requestId, document_id, verdict, note) =>
      request('POST', `/api/requests/${enc(requestId)}/label`, { document_id, verdict, note }),
    presets: () => request('GET', '/api/presets'),
    ask: (prompt, period_start, period_end) => request('POST', '/api/ask', { prompt, period_start, period_end }),
    labelAsk: (askId, document_id, verdict, note) =>
      request('POST', `/api/ask/${enc(askId)}/label`, { document_id, verdict, note }),
    accuracy: () => request('GET', '/api/accuracy'),
    evalBatches: () => request('GET', '/api/eval'),
  });

  // ---- Words ---------------------------------------------------------------------

  const VERDICT_LABELS = { correct: 'Correct', right: 'Right', wrong: 'Wrong', unsure: 'Not sure', missed: 'Missed' };
  const OVERALL_TEXT = { right: 'Right', wrong: 'Wrong', unsure: 'Not sure', missed: 'Missed a document' };
  const PICKED_TEXT = { right: 'Right', wrong: 'Wrong', unsure: 'Not sure' };
  const LEFT_OUT_TEXT = { missed: 'Missed: should be in', unsure: 'Not sure' };
  const UNKNOWN_TEXT = { right: 'Right', wrong: 'Wrong', unsure: 'Not sure', missed: 'Missed: should be in' };
  const VERDICT_HELP = {
    right: 'Right: it belongs in the answer.',
    wrong: 'Wrong: it should not be in the answer.',
    unsure: 'Not sure.',
    missed: 'Missed: a document that should match was left out.',
  };
  const REASON_LABELS = {
    wrong_period: 'Wrong period',
    wrong_person: 'Wrong person',
    duplicate: 'Duplicate',
    overclaims_complete: 'Claims to be complete, is not',
    other: 'Other',
  };
  const DRY = 'Not in this answer.';
  const REAL = 'Not recorded by the deployed backend.';
  const OVERALL = Symbol('overall');

  // ---- Network: the only place that calls fetch -----------------------------------

  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }

  async function request(method, path, body) {
    const init = {
      method,
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      headers: { Accept: 'application/json' },
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      // Every contract key is always sent; a missing value goes out as null.
      init.body = JSON.stringify(body, (key, value) => (value === undefined ? null : value));
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch (err) {
      throw new ApiError(0, 'The local dashboard server is not answering.');
    }
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (err) {
        data = null;
      }
    }
    if (!res.ok) throw new ApiError(res.status, errorMessage(res.status, data));
    return data;
  }

  function errorMessage(status, data) {
    const detail = data && data.detail;
    if (typeof detail === 'string' && detail) return detail;
    if (Array.isArray(detail) && detail.length) {
      return detail.map((item) => (item && item.msg) || String(item)).join('; ');
    }
    if (status === 404) return 'Not found.';
    return `The server answered ${status}.`;
  }

  // ---- DOM -----------------------------------------------------------------------

  const $ = (id) => document.getElementById(id);

  /** Builds an element. Children are nodes or text; text is never parsed as HTML. */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const key of Object.keys(props)) {
        const value = props[key];
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') el.className = value;
        else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
        else el.setAttribute(key, value === true ? '' : String(value));
      }
    }
    appendAll(el, children);
    return el;
  }

  function appendAll(el, children) {
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue;
      if (Array.isArray(child)) appendAll(el, child);
      else el.append(typeof child === 'string' || typeof child === 'number' ? String(child) : child);
    }
  }

  /** Replaces an element's children; null, undefined and false children are skipped. */
  function fill(el, ...children) {
    el.replaceChildren();
    appendAll(el, children);
    return el;
  }

  // ---- Formatting ------------------------------------------------------------------

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const NUMBER = new Intl.NumberFormat('en-US');
  const pad = (n, width) => String(n).padStart(width || 2, '0');

  function isNum(n) {
    return typeof n === 'number' && Number.isFinite(n);
  }

  function num(n) {
    return isNum(n) ? n : 0;
  }

  function fmtInt(n) {
    return isNum(n) ? NUMBER.format(n) : '–';
  }

  function plural(n, word, many) {
    return `${fmtInt(n)} ${n === 1 ? word : many || `${word}s`}`;
  }

  /** "2026-04-30" or an ISO date-time -> {y, m, d}, read as written (no time-zone shift). */
  function parseDay(value) {
    if (typeof value !== 'string') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]), key: `${m[1]}-${m[2]}-${m[3]}` } : null;
  }

  function fmtDay(p, withYear) {
    return `${MONTHS[p.m - 1] || '?'} ${p.d}${withYear ? `, ${p.y}` : ''}`;
  }

  function fmtDayValue(value) {
    const p = parseDay(value);
    return p ? fmtDay(p, true) : '';
  }

  function fmtRange(start, end) {
    const s = parseDay(start);
    const e = parseDay(end);
    if (s && e) {
      if (s.key === e.key) return fmtDay(s, true);
      return s.y === e.y ? `${fmtDay(s, false)} – ${fmtDay(e, true)}` : `${fmtDay(s, true)} – ${fmtDay(e, true)}`;
    }
    if (s) return `From ${fmtDay(s, true)}`;
    if (e) return `Until ${fmtDay(e, true)}`;
    return '';
  }

  function toDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function fmtStamp(value) {
    const d = toDate(value);
    if (!d) return '–';
    const year = d.getFullYear() === new Date().getFullYear() ? '' : `, ${d.getFullYear()}`;
    return `${MONTHS[d.getMonth()]} ${d.getDate()}${year}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtClock(d, withMs) {
    const base = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    return withMs ? `${base}.${pad(d.getMilliseconds(), 3)}` : base;
  }

  function fmtAgo(value) {
    const d = toDate(value);
    if (!d) return '';
    const sec = Math.round((Date.now() - d.getTime()) / 1000);
    if (sec < 45) return 'just now';
    if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
    if (sec < 86400) return `${Math.round(sec / 3600)} h ago`;
    return `${Math.round(sec / 86400)} d ago`;
  }

  function fmtSeconds(ms) {
    return isNum(ms) ? `${(ms / 1000).toFixed(1)} s` : '–';
  }

  function fmtMs(ms) {
    if (!isNum(ms)) return '–';
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
  }

  function fmtPrice(cents) {
    if (!isNum(cents)) return 'No price';
    return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }

  function fmtCost(usd) {
    if (!isNum(usd)) return 'cost unknown';
    if (usd === 0) return '$0';
    return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
  }

  function ratio(part, whole) {
    return isNum(part) && isNum(whole) && whole > 0 ? part / whole : null;
  }

  function fmtPct(fraction) {
    return isNum(fraction) ? `${Math.round(fraction * 1000) / 10}%` : '–';
  }

  function shortSha(sha) {
    return typeof sha === 'string' && sha.trim() ? sha.trim().slice(0, 10) : 'unknown';
  }

  /** A code as words: "facts_complete" -> "Facts complete", "ocr_failed" -> "OCR failed". */
  function humanize(value) {
    if (value === null || value === undefined || value === '') return '';
    const text = String(value)
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/\b(ocr|pdf|id|url|uat|api|csv)\b/g, (word) => word.toUpperCase());
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  /** Lower-case words for the middle of a sentence. */
  function words(value) {
    const text = humanize(value);
    return /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
  }

  /** Codes ("period_mismatch", "duplicate") read as words; sentences stay as written. */
  function readable(value) {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /^[a-z0-9]+([_-][a-z0-9]+)*$/i.test(text) ? humanize(text) : text;
  }

  /** Defence in depth: an account field never shows more than its last four digits. */
  function maskAccount(value) {
    if (!value) return '';
    return String(value).replace(/\d(?=(?:\D*\d){4})/g, '•');
  }

  /** Any stored value as short text, for fields whose shape the backend chose. */
  function valueText(value) {
    if (value === null || value === undefined || value === '') return '–';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (isNum(value)) return fmtInt(value);
    if (typeof value === 'string') {
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return fmtStamp(value);
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return fmtDayValue(value);
      return readable(value);
    }
    if (Array.isArray(value)) return value.map(valueText).join(', ') || '–';
    try {
      const text = JSON.stringify(value);
      return text.length > 300 ? `${text.slice(0, 300)}…` : text;
    } catch (err) {
      return String(value);
    }
  }

  const MIME_LABELS = {
    'application/pdf': 'PDF',
    'application/vnd.google-apps.document': 'Google Doc',
    'application/vnd.google-apps.spreadsheet': 'Google Sheet',
    'application/vnd.google-apps.presentation': 'Google Slides',
    'application/vnd.google-apps.folder': 'Folder',
    'application/vnd.google-apps.shortcut': 'Shortcut',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
    'application/msword': 'Word',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
    'application/vnd.ms-excel': 'Excel',
    'text/csv': 'CSV',
    'text/plain': 'Text',
    'application/zip': 'ZIP',
  };

  function mimeLabel(mime) {
    if (!mime) return '–';
    const m = String(mime).toLowerCase();
    if (MIME_LABELS[m]) return MIME_LABELS[m];
    if (m.startsWith('image/')) return `Image (${m.slice(6).toUpperCase()})`;
    if (m.startsWith('application/vnd.google-apps.')) return `Google ${humanize(m.slice(28))}`;
    const sub = m.split('/').pop() || '';
    return sub && sub.length <= 12 ? sub.toUpperCase() : 'Other';
  }

  // ---- Small building blocks -------------------------------------------------------

  function toneFor(status) {
    const s = String(status === null || status === undefined ? '' : status).toLowerCase();
    if (!s) return 'neutral';
    if (/skip/.test(s)) return 'neutral';
    if (/no[\s_-]*go|fail|error|block|reject|invalid|denied|declin|broken|withdrawn|expired|wrong/.test(s)) return 'bad';
    if (
      /insufficient|incomplete|unlisted|unknown|unsure|undecided|uncertain|unpaid|(^|[\s_-])not([\s_-]|$)|review|pending|draft|wait|partial|queued|stale|hold|missing|already|open/.test(
        s,
      )
    ) {
      return 'warn';
    }
    if (/ready|listed|complete|done|pass|active|sold|correct|right|shared|deliver|paid|allow|success|^ok$|^go$|^yes$|^true$/.test(s)) {
      return 'ok';
    }
    return 'neutral';
  }

  function tag(text, tone) {
    return h('span', { class: `tag tone-${tone || 'neutral'}` }, text);
  }

  function icon(kind, tone) {
    return h('span', { class: `ico ico-${kind} tone-${tone || 'neutral'}`, 'aria-hidden': 'true' });
  }

  function chevron() {
    return h('span', { class: 'chev', 'aria-hidden': 'true' });
  }

  function sum(values) {
    return values.reduce((total, n) => total + (isNum(n) ? n : 0), 0);
  }

  function sortedEntries(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
    return Object.keys(obj)
      .map((key) => [key, obj[key]])
      .sort((a, b) => num(b[1]) - num(a[1]));
  }

  function asList(value) {
    return Array.isArray(value) ? value : [];
  }

  /** The objects in a list; anything else is dropped. */
  function objects(value) {
    return asList(value).filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item));
  }

  function countBy(list, keyOf) {
    const counts = {};
    for (const item of list) {
      const key = keyOf(item);
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }

  function uniq(list) {
    return Array.from(new Set(list));
  }

  function isNotRecorded(value) {
    return (
      value === null ||
      value === undefined ||
      (typeof value === 'string' && /^not[\s_-]*recorded$/i.test(value.trim()))
    );
  }

  function notRecorded(text) {
    return h('p', { class: 'pad not-recorded' }, text);
  }

  function loadingBlock(text) {
    return h('div', { class: 'card state' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), text);
  }

  function errorBlock(text, retry) {
    return h(
      'div',
      { class: 'card state state-error', role: 'alert' },
      h('span', null, text),
      retry ? h('button', { type: 'button', class: 'btn btn-small', onclick: retry }, 'Retry') : null,
    );
  }

  function emptyBlock(text) {
    return h('div', { class: 'card state' }, text);
  }

  function cardHead(title, aside) {
    return h('div', { class: 'card-head' }, h('h3', null, title), aside ? h('span', { class: 'card-aside' }, aside) : null);
  }

  function refreshButton(loading, onclick) {
    return h('button', { type: 'button', class: 'btn', disabled: loading, onclick }, loading ? 'Refreshing…' : 'Refresh');
  }

  function sectionHead(title, subtitle, ...actions) {
    return h(
      'div',
      { class: 'section-head' },
      h('div', null, h('h2', null, title), subtitle ? h('p', { class: 'hint' }, subtitle) : null),
      actions.length ? h('div', { class: 'section-actions' }, actions) : null,
    );
  }

  /** A numbered part of an answer: "1 What Agent One understood". */
  function section(number, title, body, aside) {
    return h(
      'section',
      { class: 'card step', 'aria-label': title },
      h(
        'div',
        { class: 'step-head' },
        h('span', { class: 'step-num', 'aria-hidden': 'true' }, String(number)),
        h('h3', null, title),
        aside ? h('span', { class: 'card-aside' }, aside) : null,
      ),
      body,
    );
  }

  function quoteBlock(text, page) {
    return h(
      'blockquote',
      { class: 'quote' },
      h('span', { class: 'quote-text' }, `“${text}”`),
      isNum(page) ? h('span', { class: 'quote-page' }, `page ${page}`) : null,
    );
  }

  function fact(label, ...value) {
    return h('div', { class: 'fact' }, h('dt', null, label), h('dd', null, value));
  }

  function th(text, cls) {
    return h('th', { class: cls || null, scope: 'col' }, text);
  }

  function td(content, cls) {
    return h('td', { class: cls || null }, content);
  }

  function tableWrap(table) {
    return h('div', { class: 'table-wrap' }, table);
  }

  /** A link row when there is somewhere to go, else the same row without a link. */
  function rowMain(href, ...children) {
    return href ? h('a', { class: 'row-main', href }, children) : h('div', { class: 'row-main row-static' }, children);
  }

  // ---- Labels ----------------------------------------------------------------------

  /** A saved human label may arrive as a verdict string or an object. */
  function normalizeLabel(label) {
    if (!label) return null;
    if (typeof label === 'string') return { verdict: label, reason: null, note: '', at: null };
    if (typeof label !== 'object' || !label.verdict) return null;
    return {
      verdict: String(label.verdict),
      reason: label.reason || null,
      note: typeof label.note === 'string' ? label.note : '',
      at: label.at || label.saved_at || label.labeled_at || label.updated_at || label.created_at || null,
    };
  }

  function verdictName(verdict) {
    return VERDICT_LABELS[verdict] || humanize(verdict) || 'Unknown';
  }

  function verdictTone(verdict) {
    if (verdict === 'correct' || verdict === 'right') return 'ok';
    if (verdict === 'wrong' || verdict === 'missed') return 'bad';
    return 'warn';
  }

  function labelTag(label, prefix) {
    if (!label) return tag(prefix ? `${prefix}: not checked` : 'Not checked', 'outline');
    const text = verdictName(label.verdict);
    return tag(prefix ? `${prefix}: ${text}` : text, verdictTone(label.verdict));
  }

  function labelText(label) {
    if (!label) return 'Not checked yet.';
    const parts = [`Saved: ${verdictName(label.verdict)}`];
    if (label.reason) parts.push(REASON_LABELS[label.reason] || readable(label.reason));
    if (label.at) parts.push(fmtStamp(label.at));
    return parts.join(' · ');
  }

  /** The eval's verdict on a packet, whatever words it uses, as correct, wrong or undecided. */
  function normalizeAi(value) {
    const raw = value && typeof value === 'object' ? value.verdict || value.status || null : value;
    if (raw === null || raw === undefined || raw === '') return null;
    const s = String(raw).toLowerCase().trim();
    if (/^(none|null|not[\s_-]*judged|no[\s_-]*verdict)$/.test(s)) return null;
    if (/^(pass|passed|correct|right|ok|true)$/.test(s)) return 'correct';
    if (/^(fail|failed|wrong|false)$/.test(s)) return 'wrong';
    return 'undecided';
  }

  function aiTag(value) {
    const v = normalizeAi(value);
    if (v === 'correct') return tag('AI: Correct', 'ok');
    if (v === 'wrong') return tag('AI: Wrong', 'bad');
    if (v === 'undecided') return tag('AI: Undecided', 'warn');
    return tag('AI: not judged', 'outline');
  }

  /** Labels of one answer (a dry run or a real request), kept for this visit. */
  function labelCtx(kind, id, post) {
    return { kind, id, post, states: new Map(), expanded: new Set() };
  }

  function labelState(ctx, documentId, initial) {
    const key = documentId === null ? OVERALL : String(documentId);
    let st = ctx.states.get(key);
    if (!st) {
      const saved = normalizeLabel(initial);
      st = {
        verdict: saved ? saved.verdict : null,
        note: saved ? saved.note : '',
        status: saved ? 'saved' : 'idle',
        message: saved ? labelText(saved) : '',
        seq: 0,
      };
      ctx.states.set(key, st);
    }
    return st;
  }

  function paintMark(mark, st) {
    const saved = st.status === 'saved' && st.verdict;
    mark.className = saved ? `row-mark mark-${st.verdict}` : 'row-mark';
    mark.textContent = saved ? `You: ${verdictName(st.verdict)}` : '';
  }

  /** Verdict buttons and a note, saved through opts.post(verdict, note). Clicking a verdict saves it. */
  function verdictControl(opts) {
    const st = opts.state;
    const buttons = opts.values.map((verdict) =>
      h(
        'button',
        {
          type: 'button',
          class: `seg-btn v-${verdict}`,
          'aria-pressed': 'false',
          title: VERDICT_HELP[verdict] || null,
          onclick: () => {
            st.verdict = verdict;
            save();
          },
        },
        opts.texts[verdict] || verdictName(verdict),
      ),
    );
    const note = h('input', {
      type: 'text',
      class: 'note-input',
      maxlength: '2000',
      placeholder: 'Note (optional)',
      'aria-label': `${opts.aria}: note`,
    });
    note.value = st.note || '';
    note.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        save();
      }
    });
    const saveNote = h('button', { type: 'button', class: 'btn btn-small', onclick: () => save() }, 'Save note');
    const status = h('span', { class: 'save-status', role: 'status' });

    let picker = null;
    const files = asList(opts.missedFiles);
    if (files.length && opts.values.includes('missed')) {
      picker = h(
        'select',
        { class: 'select select-small', 'aria-label': 'Which file was missed?' },
        h('option', { value: '' }, 'Which file? (optional)'),
        files.map((name) => h('option', { value: name }, name)),
      );
      picker.addEventListener('change', () => {
        if (!picker.value) return;
        const rest = note.value.replace(/^Missed: [^·]*(· )?/, '').trim();
        note.value = rest ? `Missed: ${picker.value} · ${rest}` : `Missed: ${picker.value}`;
        save();
      });
    }

    function paint() {
      opts.values.forEach((verdict, i) => buttons[i].setAttribute('aria-pressed', String(st.verdict === verdict)));
      if (picker) picker.hidden = st.verdict !== 'missed';
      status.className = `save-status${st.status === 'saved' ? ' ok-text' : st.status === 'error' ? ' bad-text' : ''}`;
      status.textContent = st.message || '';
      if (opts.mark) paintMark(opts.mark, st);
    }

    async function save() {
      if (!opts.values.includes(st.verdict)) {
        st.status = 'error';
        st.message = 'Pick a verdict first.';
        paint();
        return;
      }
      st.note = note.value.trim();
      st.seq += 1;
      const seq = st.seq;
      st.status = 'saving';
      st.message = 'Saving…';
      paint();
      try {
        await opts.post(st.verdict, st.note);
        if (seq !== st.seq) return;
        st.status = 'saved';
        st.message = `Saved ${fmtClock(new Date())}`;
      } catch (err) {
        if (seq !== st.seq) return;
        st.status = 'error';
        st.message = `Couldn't save: ${err.message}`;
      }
      paint();
    }

    paint();
    return h(
      'div',
      { class: 'label-ctl' },
      h('div', { class: 'seg', role: 'group', 'aria-label': opts.aria }, buttons),
      picker,
      note,
      saveNote,
      status,
    );
  }

  /** The whole-answer verdict. "Missed a document" can name a file that was left out. */
  function overallControl(ctx, docs, rows, initial) {
    if (!ctx.post) return h('span', { class: 'hint' }, 'This answer has no id, so it cannot be judged.');
    const missedFiles = uniq(
      docs
        .filter((d) => d.selected !== true)
        .map((d) => d.file_name)
        .concat(rows.filter((r) => r.kept === false).map((r) => r.file_name))
        .filter((name) => typeof name === 'string' && name),
    ).slice(0, 500);
    return verdictControl({
      values: REQUEST_VERDICT_VALUES,
      texts: OVERALL_TEXT,
      state: labelState(ctx, null, initial),
      post: (verdict, note) => ctx.post(null, verdict, note),
      aria: 'Whole answer',
      missedFiles,
    });
  }

  // ---- The 13 Oct mistake ------------------------------------------------------------
  // On 13 Oct a file-name rule dropped most Drive rows, and a 2014-2016 history was
  // picked because it was edited in Oct 2026. These checks look for both, every time.

  const EDIT_DATE = /modif|edit(?:ed)?[\s_-]*(?:date|time)|mtime|drive[\s_-]*(?:date|time)|file[\s_-]*(?:date|time)/i;
  const BENIGN = /ignored|not[\s_-]*used|disregard|rejected/i;
  const FILE_NAME_RULE = /file[\s_-]*name|filename|name[\s_-]*(?:rule|filter|pattern|match)|title[\s_-]*(?:rule|filter)/i;
  const CODE = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/i;
  const EDIT_DATE_TEXT = 'Picked only by its edit date. This was the 13 Oct mistake.';

  function flagCodes(doc) {
    return asList(doc.flags)
      .map((f) => (typeof f === 'string' ? f : f && typeof f === 'object' ? String(f.code || f.flag || f.name || '') : ''))
      .filter(Boolean);
  }

  function pickedByEditDate(doc) {
    const hit = (text) => EDIT_DATE.test(text) && !BENIGN.test(text);
    if (flagCodes(doc).some(hit)) return true;
    if (doc.period_role && hit(String(doc.period_role))) return true;
    const reason = String(doc.reason || '');
    return CODE.test(reason) && hit(reason);
  }

  function droppedByFileName(row) {
    return row.kept === false && FILE_NAME_RULE.test(`${row.drop_stage || ''} ${row.drop_reason || ''}`);
  }

  function periodWindow(start, end) {
    const s = parseDay(start);
    const e = parseDay(end);
    if (!s && !e) return null;
    return { start: s ? s.key : null, end: e ? e.key : null };
  }

  /** True when a document's proven dates sit wholly outside the asked period. */
  function outsideWindow(doc, win) {
    if (!win) return false;
    const s = parseDay(doc.period_start) || parseDay(doc.period_end);
    const e = parseDay(doc.period_end) || parseDay(doc.period_start);
    if (!s || !e) return false;
    return Boolean((win.start && e.key < win.start) || (win.end && s.key > win.end));
  }

  function mistakeChecks(docs, rows, win, driveRecorded) {
    const picked = docs.filter((d) => d.selected === true);
    const names = (list) => list.map((item) => item.file_name || 'Untitled file');
    return [
      {
        title: 'Drive files dropped by file name alone',
        files: driveRecorded ? names(rows.filter(droppedByFileName)) : [],
        skipped: driveRecorded ? '' : 'Drive results not recorded',
      },
      { title: 'Picked only by edit date', files: names(picked.filter(pickedByEditDate)), skipped: '' },
      {
        title: 'Picked with dates outside the asked period',
        files: win ? names(picked.filter((d) => outsideWindow(d, win))) : [],
        skipped: win ? '' : 'No asked dates to compare with',
      },
      { title: 'Picked with no quote proving its dates', files: names(picked.filter((d) => !d.evidence_quote)), skipped: '' },
    ];
  }

  function listNames(names) {
    const shown = names.slice(0, 4).join(', ');
    return names.length > 4 ? `${shown} and ${fmtInt(names.length - 4)} more` : shown;
  }

  function mistakeCard(checks) {
    const failed = checks.filter((c) => !c.skipped && c.files.length).length;
    return h(
      'section',
      { class: `card audit ${failed ? 'audit-bad' : 'audit-ok'}`, 'aria-label': '13 Oct mistake check' },
      h(
        'div',
        { class: 'audit-head' },
        h('h3', null, failed ? 'The 13 Oct mistake shows up here' : 'No sign of the 13 Oct mistake'),
        tag(failed ? `${failed} of ${checks.length} checks failed` : 'All checks passed', failed ? 'bad' : 'ok'),
      ),
      h(
        'p',
        { class: 'hint' },
        'On 13 Oct a file-name rule dropped most Drive results, and a 2014–2016 history was picked because it was edited in Oct 2026. Every line below should be 0.',
      ),
      h(
        'ul',
        { class: 'audit-list' },
        checks.map((c) =>
          h(
            'li',
            { class: 'audit-row' },
            c.skipped ? tag('–', 'outline') : tag(fmtInt(c.files.length), c.files.length ? 'bad' : 'ok'),
            h('span', { class: 'audit-title' }, c.title),
            c.skipped
              ? h('span', { class: 'audit-note hint' }, c.skipped)
              : c.files.length
                ? h('span', { class: 'audit-note bad-text' }, listNames(c.files))
                : null,
          ),
        ),
      ),
    );
  }

  // ---- 1 What Agent One understood -------------------------------------------------

  function understoodBody(u, typed, src) {
    if (isNotRecorded(u)) return notRecorded(src);
    if (typeof u !== 'object' || Array.isArray(u)) return h('p', { class: 'pad' }, valueText(u));
    const kinds = asList(u.kinds);
    const terms = asList(u.terms);
    const period = fmtRange(u.period_start, u.period_end);
    const typedText = typed ? fmtRange(typed.start, typed.end) : '';
    const differs = Boolean(typedText && period && typedText !== period);
    const known = new Set(['summary', 'kinds', 'terms', 'period_start', 'period_end']);
    const extra = Object.keys(u).filter((key) => !known.has(key));
    return h(
      'div',
      { class: 'pad stack' },
      h('p', { class: 'lead' }, u.summary ? readable(u.summary) : 'No summary.'),
      h(
        'dl',
        { class: 'facts' },
        fact('Kinds', kinds.length ? h('span', { class: 'chips' }, kinds.map((k) => tag(humanize(k), 'neutral'))) : '–'),
        fact('Period', period || 'No dates'),
        typedText ? fact('Dates typed', typedText) : null,
        fact(
          'Search terms',
          terms.length ? h('span', { class: 'chips' }, terms.map((term) => h('code', { class: 'term' }, String(term)))) : '–',
        ),
        extra.map((key) => fact(humanize(key), valueText(u[key]))),
      ),
      differs ? h('p', { class: 'flag flag-warn' }, `Agent One used ${period}, not the dates typed (${typedText}).`) : null,
    );
  }

  // ---- 2 Google Drive search ---------------------------------------------------------

  const ROW_STEP = 100;

  function drivePanel(api, src) {
    if (isNotRecorded(api) || typeof api !== 'object' || Array.isArray(api)) return notRecorded(src);
    const calls = isNotRecorded(api.calls) ? null : objects(api.calls);
    const rows = isNotRecorded(api.rows) ? null : objects(api.rows);
    const returned =
      calls && calls.length && calls.every((c) => isNum(c.rows)) ? sum(calls.map((c) => c.rows)) : rows ? rows.length : null;
    const kept = rows ? rows.filter((r) => r.kept === true).length : 0;
    const dropped = rows ? rows.filter((r) => r.kept === false).length : 0;
    return [
      h(
        'p',
        { class: 'pad lead' },
        `Google Drive API: ${calls ? plural(calls.length, 'search', 'searches') : 'searches not recorded'}, ` +
          `${isNum(returned) ? plural(returned, 'file') : 'files not recorded'} returned.`,
        rows ? ` ${fmtInt(kept)} kept, ${fmtInt(dropped)} dropped.` : null,
      ),
      calls ? callsTable(calls) : notRecorded(src),
      rows ? rowsTable(rows) : notRecorded(src),
    ];
  }

  function callsTable(calls) {
    if (!calls.length) return h('p', { class: 'pad hint' }, 'No Drive searches.');
    return tableWrap(
      h(
        'table',
        { class: 'table' },
        h('thead', null, h('tr', null, th('#', 'num'), th('Query sent to Drive'), th('Page', 'num'), th('Files', 'num'), th('Time', 'num'))),
        h(
          'tbody',
          null,
          calls.map((c, i) =>
            h(
              'tr',
              null,
              td(String(i + 1), 'num'),
              td(h('code', { class: 'q' }, c.q === null || c.q === undefined ? '–' : String(c.q))),
              td(valueText(c.page), 'num'),
              td(fmtInt(c.rows), 'num'),
              td(fmtMs(c.ms), 'num'),
            ),
          ),
        ),
      ),
    );
  }

  function dropText(row) {
    return [humanize(row.drop_stage), readable(row.drop_reason)].filter(Boolean).join(': ') || 'No reason given';
  }

  function driveRow(r) {
    let result;
    if (r.kept === true) result = tag('Kept', 'ok');
    else if (r.kept === false) result = [tag('Dropped', droppedByFileName(r) ? 'bad' : 'neutral'), h('span', { class: 'drop-why' }, dropText(r))];
    else result = tag('Unknown', 'outline');
    return h(
      'tr',
      { class: r.kept === false ? 'row-dropped' : null },
      td(h('span', { class: 'cell-name', title: r.file_name || '' }, r.file_name || 'Untitled file')),
      td(h('span', { title: r.mime || '' }, mimeLabel(r.mime)), 'nowrap'),
      td(h('span', { title: r.modified_time || '' }, fmtDayValue(r.modified_time) || '–'), 'nowrap'),
      td(h('span', { title: r.created_time || '' }, fmtDayValue(r.created_time) || '–'), 'nowrap'),
      td(result, 'cell-result'),
    );
  }

  /** Every row Drive returned, filterable by kept, dropped, drop reason and name. */
  function rowsTable(rows) {
    if (!rows.length) return h('p', { class: 'pad hint' }, 'Drive returned no files.');
    const st = { mode: 'all', reason: null, query: '', limit: ROW_STEP };
    const kept = rows.filter((r) => r.kept === true).length;
    const dropped = rows.filter((r) => r.kept === false).length;
    const reasons = sortedEntries(countBy(rows.filter((r) => r.kept === false), dropText));
    const tbody = h('tbody');
    const foot = h('div', { class: 'table-foot' });
    const search = h('input', {
      type: 'search',
      class: 'search',
      placeholder: 'Filter by file name',
      'aria-label': 'Filter Drive files by name',
    });
    search.addEventListener('input', () => {
      st.query = search.value.trim().toLowerCase();
      st.limit = ROW_STEP;
      paint();
    });
    const modes = [
      ['all', `All ${fmtInt(rows.length)}`],
      ['kept', `Kept ${fmtInt(kept)}`],
      ['dropped', `Dropped ${fmtInt(dropped)}`],
    ].map(([value, text]) => ({
      value,
      button: h(
        'button',
        {
          type: 'button',
          class: 'seg-btn',
          'aria-pressed': 'false',
          onclick: () => {
            st.mode = value;
            st.reason = null;
            st.limit = ROW_STEP;
            paint();
          },
        },
        text,
      ),
    }));
    const reasonChips = reasons.map(([text, n]) => ({
      text,
      button: h(
        'button',
        {
          type: 'button',
          class: `chip chip-small${FILE_NAME_RULE.test(text) ? ' chip-bad' : ''}`,
          'aria-pressed': 'false',
          onclick: () => {
            st.reason = st.reason === text ? null : text;
            if (st.reason) st.mode = 'dropped';
            st.limit = ROW_STEP;
            paint();
          },
        },
        `${text} · ${fmtInt(n)}`,
      ),
    }));

    function visible() {
      return rows.filter((r) => {
        if (st.mode === 'kept' && r.kept !== true) return false;
        if (st.mode === 'dropped' && r.kept !== false) return false;
        if (st.reason && dropText(r) !== st.reason) return false;
        return !st.query || String(r.file_name || '').toLowerCase().includes(st.query);
      });
    }

    function paint() {
      for (const m of modes) m.button.setAttribute('aria-pressed', String(st.mode === m.value));
      for (const c of reasonChips) c.button.setAttribute('aria-pressed', String(st.reason === c.text));
      const list = visible();
      fill(tbody, list.slice(0, st.limit).map(driveRow));
      const more = list.length - st.limit;
      fill(
        foot,
        h(
          'span',
          { class: 'hint' },
          list.length ? `Showing ${fmtInt(Math.min(st.limit, list.length))} of ${fmtInt(list.length)}` : 'No files match.',
        ),
        more > 0
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn btn-small',
                onclick: () => {
                  st.limit += ROW_STEP;
                  paint();
                },
              },
              `Show ${fmtInt(Math.min(ROW_STEP, more))} more`,
            )
          : null,
        more > ROW_STEP
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn btn-small',
                onclick: () => {
                  st.limit = list.length;
                  paint();
                },
              },
              'Show all',
            )
          : null,
      );
    }

    paint();
    return h(
      'div',
      { class: 'rows-block' },
      h(
        'div',
        { class: 'table-tools' },
        h('div', { class: 'seg', role: 'group', 'aria-label': 'Show Drive files' }, modes.map((m) => m.button)),
        search,
      ),
      reasonChips.length
        ? h(
            'div',
            { class: 'table-tools' },
            h('span', { class: 'row-label' }, 'Dropped because'),
            h('div', { class: 'chips' }, reasonChips.map((c) => c.button)),
          )
        : null,
      tableWrap(
        h(
          'table',
          { class: 'table table-rows' },
          h('thead', null, h('tr', null, th('File name'), th('Type'), th('Modified'), th('Created'), th('Result'))),
          tbody,
        ),
      ),
      foot,
    );
  }

  // ---- 3 Funnel and steps ---------------------------------------------------------------

  const FUNNEL = [
    ['drive_rows', 'Drive files'],
    ['candidates', 'Candidates'],
    ['indexed', 'Indexed'],
    ['period_proven', 'Dates proven in the document'],
    ['selected', 'Selected'],
  ];
  const TIMING_NAMES = { plan: 'Plan', drive: 'Drive', filter: 'Filter', select: 'Select' };

  function funnelBars(c) {
    const values = FUNNEL.map(([key]) => (isNum(c[key]) ? c[key] : null));
    const top = Math.max(1, ...values.filter(isNum));
    let previous = null;
    const rows = FUNNEL.map(([key, label], i) => {
      const n = values[i];
      const dropped = isNum(previous) && isNum(n) && previous > n ? previous - n : 0;
      if (isNum(n)) previous = n;
      const level = h('span', { class: `bar-fill${key === 'selected' ? ' bar-final' : ''}` });
      level.style.width = `${isNum(n) && n > 0 ? Math.max(0.8, (n / top) * 100) : 0}%`;
      return h(
        'li',
        { class: 'funnel-row' },
        h('span', { class: 'funnel-label' }, label),
        h('span', { class: 'bar', 'aria-hidden': 'true' }, level),
        h('span', { class: 'funnel-num' }, fmtInt(n)),
        h('span', { class: 'funnel-drop' }, dropped ? `−${fmtInt(dropped)}` : ''),
      );
    });
    return [
      h('ol', { class: 'funnel' }, rows),
      isNum(c.not_indexed) && c.not_indexed > 0
        ? h(
            'p',
            { class: 'pad hint' },
            `${plural(c.not_indexed, 'candidate is', 'candidates are')} not indexed yet, so their dates can't be proven.`,
          )
        : null,
    ];
  }

  function notesText(notes) {
    if (notes === null || notes === undefined || notes === '') return '';
    if (typeof notes === 'string') return readable(notes);
    if (Array.isArray(notes)) return notes.map(notesText).filter(Boolean).join('; ');
    if (typeof notes === 'object') {
      return Object.keys(notes)
        .map((key) => `${humanize(key)}: ${valueText(notes[key])}`)
        .join('; ');
    }
    return String(notes);
  }

  function stepsTable(steps, src) {
    if (isNotRecorded(steps)) return notRecorded(src);
    const list = objects(steps);
    if (!list.length) return h('p', { class: 'pad hint' }, 'No steps recorded.');
    return tableWrap(
      h(
        'table',
        { class: 'table' },
        h(
          'thead',
          null,
          h('tr', null, th('Step'), th('In', 'num'), th('Kept', 'num'), th('Dropped', 'num'), th('Time', 'num'), th('Notes')),
        ),
        h(
          'tbody',
          null,
          list.map((s) =>
            h(
              'tr',
              null,
              td(readable(s.name) || '–'),
              td(fmtInt(s.in), 'num'),
              td(fmtInt(s.kept), 'num'),
              td(fmtInt(s.dropped), isNum(s.dropped) && s.dropped > 0 ? 'num bad-text' : 'num'),
              td(fmtMs(s.ms), 'num'),
              td(notesText(s.notes) || '–', 'notes'),
            ),
          ),
        ),
      ),
    );
  }

  function timingLine(t) {
    const parts = Object.keys(TIMING_NAMES)
      .filter((key) => isNum(t[key]))
      .map((key) => `${TIMING_NAMES[key]} ${fmtMs(t[key])}`);
    if (isNum(t.total)) parts.push(`Total ${fmtSeconds(t.total)}`);
    return parts.length ? `Time: ${parts.join(' · ')}` : '';
  }

  function funnelBody(counts, steps, rejected, timings, src) {
    const parts = [];
    if (counts && typeof counts === 'object' && !Array.isArray(counts)) parts.push(funnelBars(counts));
    const reasons = sortedEntries(rejected);
    if (reasons.length) {
      parts.push(
        h(
          'div',
          { class: 'pad reason-row' },
          h('span', { class: 'row-label' }, 'Dropped because'),
          reasons.map(([code, n]) => tag(`${humanize(code)} · ${fmtInt(n)}`, FILE_NAME_RULE.test(code) ? 'bad' : 'neutral')),
        ),
      );
    }
    parts.push(stepsTable(steps, src));
    const time = timings && typeof timings === 'object' ? timingLine(timings) : '';
    if (time) parts.push(h('p', { class: 'pad hint' }, time));
    return parts;
  }

  // ---- 4 Documents -------------------------------------------------------------------

  const GROUP_LIMIT = 100;

  function notIndexed(doc) {
    const s = doc.indexed_state;
    if (s === false) return true;
    if (s === null || s === undefined || s === '' || s === true) return false;
    return /not[\s_-]*(yet[\s_-]*)?indexed|unindexed|not[\s_-]*extracted|pending|queued|waiting/i.test(String(s));
  }

  function indexText(doc) {
    const parts = [];
    const s = doc.indexed_state;
    if (typeof s === 'boolean') parts.push(s ? 'indexed' : 'not indexed');
    else if (s !== null && s !== undefined && s !== '') parts.push(words(s));
    if (doc.extraction_state) parts.push(`read ${words(doc.extraction_state)}`);
    if (doc.facts_state) parts.push(`facts ${words(doc.facts_state)}`);
    return parts.join(' · ');
  }

  function flagText(code, selected) {
    if (EDIT_DATE.test(code) && !BENIGN.test(code)) {
      return selected ? { text: EDIT_DATE_TEXT, tone: 'bad' } : { text: readable(code), tone: 'warn' };
    }
    if (/outside|out[\s_-]*of[\s_-]*(range|window|period)|period[\s_-]*mismatch|wrong[\s_-]*period/i.test(code)) {
      return { text: 'Its dates are outside the asked period.', tone: selected ? 'bad' : 'warn' };
    }
    if (/no[\s_-]*(quote|evidence)|unproven|unverified|missing[\s_-]*evidence/i.test(code)) {
      return { text: 'No quote proves its dates.', tone: selected ? 'bad' : 'warn' };
    }
    if (/duplicate/i.test(code)) return { text: 'Duplicate of another file.', tone: 'warn' };
    if (/partial|overlap/i.test(code)) return { text: 'Covers the asked period only in part.', tone: 'warn' };
    return { text: readable(code), tone: 'warn' };
  }

  /** The engine's flags plus the checks this page makes itself, without repeats. */
  function docFlags(doc, win) {
    const out = [];
    const seen = new Set();
    const add = (f) => {
      if (f.text && !seen.has(f.text)) {
        seen.add(f.text);
        out.push(f);
      }
    };
    const selected = doc.selected === true;
    for (const item of asList(doc.flags)) {
      if (typeof item === 'string') add(flagText(item, selected));
      else if (item && typeof item === 'object') {
        const code = item.code || item.flag || item.name;
        if (code) add(flagText(String(code), selected));
        else if (item.text || item.msg) add({ text: String(item.text || item.msg), tone: 'warn' });
      }
    }
    if (selected) {
      if (pickedByEditDate(doc)) add({ text: EDIT_DATE_TEXT, tone: 'bad' });
      if (win && outsideWindow(doc, win)) {
        add({ text: `Its dates are outside the asked period (${fmtRange(win.start, win.end)}).`, tone: 'bad' });
      }
      if (!fmtRange(doc.period_start, doc.period_end)) add({ text: 'No dates were proven for it.', tone: 'bad' });
      if (!doc.evidence_quote) add({ text: 'No quote proves its dates.', tone: 'bad' });
    }
    return out;
  }

  function docId(doc) {
    return typeof doc.document_id === 'string' && doc.document_id ? doc.document_id : null;
  }

  function docLabel(doc, id, ctx, mark, initial) {
    if (!ctx.post) return null;
    if (!id) {
      return h('p', { class: 'hint' }, 'This file has no document id. Judge it in the whole answer above (Missed a document).');
    }
    const st = labelState(ctx, id, (initial && initial[id]) || doc.human_label);
    let ask = 'Is it right?';
    let values = REQUEST_VERDICT_VALUES;
    let texts = UNKNOWN_TEXT;
    if (doc.selected === true) [ask, values, texts] = ['Is this pick right?', PICKED_VERDICTS, PICKED_TEXT];
    else if (doc.selected === false) [ask, values, texts] = ['Should it be in?', LEFT_OUT_VERDICTS, LEFT_OUT_TEXT];
    return h(
      'div',
      { class: 'row-label-line' },
      h('span', { class: 'row-label' }, ask),
      verdictControl({ values, texts, state: st, post: (verdict, note) => ctx.post(id, verdict, note), mark, aria: ask }),
      h('span', { class: 'mono' }, id),
    );
  }

  const DOC_STATUS = {
    selected: ['Selected', 'ok'],
    pending: ['Not indexed yet', 'warn'],
    left: ['Left out', 'neutral'],
    unknown: ['Picked? Not recorded', 'outline'],
  };

  /** Picked, left out, not indexed yet, or not recorded (a stored request may lack the flag). */
  function docGroup(doc) {
    if (doc.selected === true) return 'selected';
    if (doc.selected !== false) return 'unknown';
    return notIndexed(doc) ? 'pending' : 'left';
  }

  function docRow(doc, index, ctx, win, initial) {
    const id = docId(doc);
    const group = docGroup(doc);
    const selected = group === 'selected';
    const dates = fmtRange(doc.period_start, doc.period_end);
    const flags = docFlags(doc, win);
    const worst = flags.some((f) => f.tone === 'bad') ? 'bad' : flags.length ? 'warn' : null;
    const mark = h('span', { class: 'row-mark' });
    if (id && ctx.post) paintMark(mark, labelState(ctx, id, (initial && initial[id]) || doc.human_label));
    const detailId = `${ctx.kind}-doc-${index}`;
    const key = String(index);
    const sub = [humanize(doc.kind) || 'Unknown kind', indexText(doc)].filter(Boolean).join(' · ');
    const status = tag(...DOC_STATUS[group]);
    const head = h(
      'button',
      { type: 'button', class: 'row-main', 'aria-expanded': 'false', 'aria-controls': detailId },
      icon('doc', selected ? worst || 'ok' : 'neutral'),
      h(
        'span',
        { class: 'row-text' },
        h('span', { class: 'row-title', title: doc.file_name || '' }, doc.file_name || 'Untitled file'),
        h('span', { class: 'row-sub' }, sub),
      ),
      h(
        'span',
        { class: 'row-trail' },
        mark,
        flags.length ? tag(plural(flags.length, 'flag'), worst) : null,
        h('span', { class: `row-dates${selected && !dates ? ' bad-text' : ''}` }, dates || 'No dates'),
        status,
      ),
      chevron(),
    );

    // The detail is built on first open, so long lists stay light.
    const detail = h('div', { class: 'row-detail', id: detailId });
    let built = false;
    const build = () => {
      if (built) return;
      built = true;
      fill(
        detail,
        flags.length ? h('div', { class: 'flags' }, flags.map((f) => h('p', { class: `flag flag-${f.tone}` }, f.text))) : null,
        h(
          'dl',
          { class: 'facts' },
          fact('Dates covered', dates || 'No dates proven', doc.period_role ? h('span', { class: 'hint' }, ` (${words(doc.period_role)})`) : null),
          fact('Index', indexText(doc) || '–'),
        ),
        h('div', { class: 'detail-label' }, 'Quote proving the dates'),
        doc.evidence_quote ? quoteBlock(doc.evidence_quote, doc.page) : h('p', { class: 'hint' }, 'No quote.'),
        h('div', { class: 'detail-label' }, selected ? 'Why selected' : group === 'unknown' ? 'Reason' : 'Why left out'),
        h('p', { class: 'reason-text' }, readable(doc.reason) || 'No reason given.'),
        docLabel(doc, id, ctx, mark, initial),
      );
    };
    const setOpen = (on) => {
      if (on) build();
      detail.hidden = !on;
      head.setAttribute('aria-expanded', String(on));
      if (on) ctx.expanded.add(key);
      else ctx.expanded.delete(key);
    };
    setOpen(ctx.expanded.has(key));
    head.addEventListener('click', () => setOpen(detail.hidden));
    return h('li', { class: 'row' }, head, detail);
  }

  /** The first GROUP_LIMIT rows of a group, then one button for the rest. */
  function groupRows(entries, toRow) {
    const list = h('ul', { class: 'list' }, entries.slice(0, GROUP_LIMIT).map(toRow));
    if (entries.length <= GROUP_LIMIT) return list;
    const more = h('div', { class: 'more' });
    more.append(
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-small',
          onclick: () => {
            appendAll(list, entries.slice(GROUP_LIMIT).map(toRow));
            more.remove();
          },
        },
        `Show ${fmtInt(entries.length - GROUP_LIMIT)} more`,
      ),
    );
    return [list, more];
  }

  function documentsBody(value, ctx, win, src, initial) {
    if (isNotRecorded(value)) return notRecorded(src);
    const list = objects(value).map((doc, index) => ({ doc, index }));
    if (!list.length) return h('p', { class: 'pad hint' }, 'No documents.');
    const groups = [
      ['selected', 'Selected'],
      ['left', 'Left out'],
      ['pending', 'Not indexed yet'],
      ['unknown', 'Picked or not: not recorded'],
    ]
      .map(([key, title]) => ({ title, rows: list.filter((e) => docGroup(e.doc) === key) }))
      .filter((g) => g.rows.length);
    return groups.map((g) => [
      h('h4', { class: 'group-head' }, g.title, h('span', { class: 'group-count' }, fmtInt(g.rows.length))),
      groupRows(g.rows, (e) => docRow(e.doc, e.index, ctx, win, initial)),
    ]);
  }

  function docCounts(docs) {
    const count = countBy(docs, docGroup);
    return { selected: count.selected || 0, leftOut: count.left || 0, pending: count.pending || 0, unknown: count.unknown || 0 };
  }

  function docsAside(docs) {
    if (!docs.length) return null;
    const c = docCounts(docs);
    const parts = [`${fmtInt(c.selected)} selected`, `${fmtInt(c.leftOut)} left out`, `${fmtInt(c.pending)} not indexed yet`];
    if (c.unknown) parts.push(`${fmtInt(c.unknown)} not recorded`);
    return parts.join(' · ');
  }

  // ---- 5 What Manish would approve ------------------------------------------------------

  function whyNotText(value) {
    if (Array.isArray(value)) return value.map(readable).filter(Boolean).join('; ');
    if (typeof value === 'string') return readable(value);
    return value ? valueText(value) : '';
  }

  function ownerReviewBody(rv, src, who) {
    if (isNotRecorded(rv)) return notRecorded(src);
    if (typeof rv !== 'object' || Array.isArray(rv)) return h('p', { class: 'pad' }, valueText(rv));
    const files = isNotRecorded(rv.files) ? null : objects(rv.files);
    const allow = rv.would_allow_now;
    const whyNot = whyNotText(rv.why_not);
    const known = new Set(['files', 'coverage_text', 'price_cents', 'would_allow_now', 'why_not']);
    const extra = Object.keys(rv).filter((key) => !known.has(key));
    let allowTag;
    if (allow === true) allowTag = tag('Yes, Manish could tap Allow now', 'ok');
    else if (allow === false) allowTag = tag('No', 'bad');
    else allowTag = tag('Not recorded', 'outline');
    return h(
      'div',
      { class: 'pad stack' },
      h(
        'div',
        { class: 'review-sheet' },
        h(
          'div',
          { class: 'review-top' },
          h('span', null, files ? `${plural(files.length, 'file')} for ${who}` : `Files for ${who}: not recorded`),
          h('span', { class: 'review-price' }, isNotRecorded(rv.price_cents) ? 'Price not recorded' : fmtPrice(rv.price_cents)),
        ),
        rv.coverage_text ? h('p', { class: 'review-coverage' }, String(rv.coverage_text)) : h('p', { class: 'hint' }, 'No coverage line.'),
        files && files.length
          ? h(
              'ul',
              { class: 'review-files' },
              files.map((f) =>
                h(
                  'li',
                  null,
                  h('span', { class: 'review-file' }, f.file_name || 'Untitled file'),
                  h('span', { class: 'review-dates' }, fmtRange(f.period_start, f.period_end) || 'No dates'),
                ),
              ),
            )
          : null,
      ),
      h('div', { class: 'allow-line' }, h('span', { class: 'row-label' }, 'Allow now?'), allowTag, whyNot ? h('span', { class: 'hint' }, whyNot) : null),
      extra.length ? h('dl', { class: 'facts' }, extra.map((key) => fact(humanize(key), valueText(rv[key])))) : null,
    );
  }

  // ---- 6 Packets Chris could buy instead --------------------------------------------------

  function matchingPacketsBody(value, src) {
    if (isNotRecorded(value)) return notRecorded(src);
    const rows = objects(value);
    if (!rows.length) return h('p', { class: 'pad hint' }, 'No ready-made packet matches this request.');
    return h(
      'ul',
      { class: 'list' },
      rows.map((p) =>
        h(
          'li',
          { class: 'row' },
          rowMain(
            p.packet_id ? `#/packets/${enc(p.packet_id)}` : null,
            icon('stack', toneFor(p.status)),
            h(
              'span',
              { class: 'row-text' },
              h('span', { class: 'row-title', title: p.title || '' }, p.title || 'Untitled packet'),
              h(
                'span',
                { class: 'row-sub' },
                [plural(p.member_count, 'document'), p.period_label || 'No period', p.why_matched ? readable(p.why_matched) : null]
                  .filter(Boolean)
                  .join(' · '),
              ),
            ),
            h(
              'span',
              { class: 'row-trail' },
              h('span', { class: 'row-amount' }, fmtPrice(p.price_cents)),
              p.listed ? tag('Listed', 'info') : tag('Not listed', 'outline'),
              tag(humanize(p.status) || 'No status', toneFor(p.status)),
            ),
            p.packet_id ? chevron() : null,
          ),
        ),
      ),
    );
  }

  // ---- 7 Buyer checks ---------------------------------------------------------------------

  function buyerChecksBody(value, src) {
    if (isNotRecorded(value)) return notRecorded(src);
    const rows = objects(value);
    if (!rows.length) return h('p', { class: 'pad hint' }, 'No buyer checks.');
    return h(
      'ul',
      { class: 'kv' },
      rows.map((c) =>
        h(
          'li',
          { class: 'kv-row' },
          h('span', { class: 'kv-key' }, readable(c.name) || 'Check'),
          tag(/skip/i.test(String(c.status || '')) ? 'Skipped in dry run' : humanize(c.status) || 'Unknown', toneFor(c.status)),
          c.note ? h('span', { class: 'kv-note' }, readable(c.note)) : null,
        ),
      ),
    );
  }

  // ---- 8 Logs -------------------------------------------------------------------------------

  function levelTone(level) {
    const s = String(level || '').toLowerCase();
    if (/error|critical|fatal|exception/.test(s)) return 'bad';
    if (/warn/.test(s)) return 'warn';
    return 'plain';
  }

  function fmtLogTime(t) {
    if (isNum(t)) {
      if (t > 1e12) return fmtClock(new Date(t), true);
      if (t > 1e9) return fmtClock(new Date(t * 1000), true);
      return Number.isInteger(t) ? `+${t} ms` : `+${t.toFixed(3)} s`;
    }
    const d = typeof t === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(t) ? toDate(t) : null;
    return d ? fmtClock(d, true) : String(t === null || t === undefined ? '' : t);
  }

  function logsBody(value, src) {
    if (isNotRecorded(value)) return notRecorded(src);
    const lines = objects(value);
    if (!lines.length) return h('p', { class: 'pad hint' }, 'No log lines.');
    const loud = lines.filter((l) => levelTone(l.level) !== 'plain').length;
    return h(
      'details',
      { class: 'logs' },
      h('summary', null, `Show ${plural(lines.length, 'line')}${loud ? ` · ${plural(loud, 'warning or error', 'warnings or errors')}` : ''}`),
      h(
        'div',
        { class: 'log' },
        lines.map((l) =>
          h(
            'div',
            { class: `log-line log-${levelTone(l.level)}` },
            h('span', { class: 'log-t' }, fmtLogTime(l.t)),
            h('span', { class: 'log-level' }, String(l.level || '').toUpperCase() || '–'),
            h('span', { class: 'log-logger' }, l.logger ? String(l.logger) : ''),
            h('span', { class: 'log-msg' }, typeof l.msg === 'string' ? l.msg : valueText(l.msg)),
          ),
        ),
      ),
    );
  }

  // ---- Payment and delivery (real requests) ---------------------------------------------------

  const OUTCOMES = {
    shared: ['Shared', 'ok'],
    already_had_access: ['Already had access', 'warn'],
    failed: ['Failed', 'bad'],
  };

  function paymentBody(p, src) {
    if (isNotRecorded(p)) return notRecorded(src);
    if (typeof p !== 'object' || Array.isArray(p)) return h('p', { class: 'pad' }, valueText(p));
    let refund;
    if (p.refunded === true) refund = 'Refunded';
    else if (p.refunded === false) refund = 'Not refunded';
    else if (isNum(p.refunded)) refund = p.refunded > 0 ? `Refunded ${fmtPrice(p.refunded)}` : 'Not refunded';
    else refund = isNotRecorded(p.refunded) ? 'Not recorded' : valueText(p.refunded);
    return h(
      'dl',
      { class: 'pad facts' },
      fact('Status', isNotRecorded(p.status) ? 'Not recorded' : tag(humanize(p.status), toneFor(p.status))),
      fact('Amount', isNotRecorded(p.amount_cents) ? 'Not recorded' : fmtPrice(p.amount_cents)),
      fact('Refund', refund),
    );
  }

  function deliveryBody(value, payment, src, who) {
    if (isNotRecorded(value)) return notRecorded(src);
    const rows = objects(value);
    if (!rows.length) return h('p', { class: 'pad hint' }, 'No files delivered.');
    const counts = countBy(rows, (r) => r.outcome);
    const already = counts.already_had_access || 0;
    const paid =
      payment && typeof payment === 'object' && /paid|succeeded|complete|captured|settled/i.test(String(payment.status || ''));
    return [
      h(
        'p',
        { class: 'pad lead' },
        [
          `${fmtInt(counts.shared || 0)} shared`,
          `${fmtInt(already)} already had access`,
          `${fmtInt(counts.failed || 0)} failed`,
        ].join(' · '),
      ),
      paid && already
        ? h(
            'p',
            { class: 'flag flag-bad pad-x' },
            `Paid, but ${plural(already, 'file was', 'files were')} already open to ${who}. Check the refund.`,
          )
        : null,
      h(
        'ul',
        { class: 'list' },
        rows.map((r) => {
          const [text, tone] = OUTCOMES[r.outcome] || [humanize(r.outcome) || 'Unknown', 'neutral'];
          return h(
            'li',
            { class: 'row' },
            h(
              'div',
              { class: 'row-main row-static' },
              icon('doc', tone),
              h('span', { class: 'row-text' }, h('span', { class: 'row-title', title: r.file_name || '' }, r.file_name || 'Untitled file')),
              h('span', { class: 'row-trail' }, tag(text, tone)),
            ),
          );
        }),
      ),
    ];
  }

  // ---- Theme -----------------------------------------------------------------------------------

  const THEME_KEY = 'drive-check-theme';
  const THEMES = ['auto', 'light', 'dark'];

  function readTheme() {
    try {
      const value = window.localStorage.getItem(THEME_KEY);
      return THEMES.includes(value) ? value : 'auto';
    } catch (err) {
      return 'auto';
    }
  }

  function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }

  function initTheme() {
    const button = $('theme-toggle');
    let theme = readTheme();
    const paint = () => {
      button.textContent = `Theme: ${humanize(theme)}`;
    };
    paint();
    button.addEventListener('click', () => {
      theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
      applyTheme(theme);
      paint();
      try {
        window.localStorage.setItem(THEME_KEY, theme);
      } catch (err) {
        /* storage blocked: the choice lasts for this visit */
      }
    });
  }

  applyTheme(readTheme());

  // ---- Which code UAT runs ---------------------------------------------------------------------

  const engineState = { data: null, error: null, loading: false };

  async function loadEngine() {
    if (engineState.loading) return;
    engineState.loading = true;
    paintEngine();
    try {
      engineState.data = (await API.engine()) || {};
      engineState.error = null;
    } catch (err) {
      engineState.error = err;
    } finally {
      engineState.loading = false;
    }
    paintEngine();
  }

  function paintEngine() {
    const strip = $('engine-strip');
    const d = engineState.data;
    const recheck = h(
      'button',
      { type: 'button', class: 'engine-recheck', disabled: engineState.loading, onclick: () => loadEngine() },
      engineState.loading ? 'Checking…' : 'Recheck',
    );
    if (!d) {
      if (!engineState.error) {
        strip.className = 'engine-strip engine-wait';
        fill(strip, h('span', { class: 'engine-text' }, 'Testing deployed UAT: reading which code it runs…'));
        return;
      }
      strip.className = 'engine-strip engine-bad';
      fill(
        strip,
        h(
          'span',
          { class: 'engine-text' },
          h('strong', null, 'Testing deployed UAT: not confirmed'),
          ` · Couldn't read which code UAT runs (${engineState.error.message}). Treat every result as unverified.`,
        ),
        recheck,
      );
      return;
    }
    const match = d.match === true;
    let note;
    if (match) note = ' · the local engine runs this exact code';
    else if (d.match === false) {
      note = ` · The local engine runs ${shortSha(d.engine_sha)}, not the deployed code. Results may not match UAT.`;
    } else note = ' · Couldn’t compare the local engine with the deployed code. Results may not match UAT.';
    strip.className = `engine-strip ${match ? 'engine-ok' : 'engine-bad'}`;
    fill(
      strip,
      h(
        'span',
        { class: 'engine-text' },
        h(
          'strong',
          { title: [d.deployed_revision, d.deployed_sha].filter(Boolean).join(' @ ') },
          `Testing deployed UAT: ${d.deployed_revision || 'unknown revision'} @ ${shortSha(d.deployed_sha)}`,
        ),
        note,
        d.checked_at ? h('span', { class: 'engine-time' }, ` · checked ${fmtStamp(d.checked_at)}`) : null,
      ),
      recheck,
    );
  }

  async function loadOwner() {
    const line = $('owner-line');
    try {
      const o = (await API.owner()) || {};
      line.textContent = [
        o.display_name || 'Manish',
        `${fmtInt(o.files_found)} files found`,
        plural(o.packets, 'packet'),
        `${fmtInt(o.ready)} ready`,
        `${fmtInt(o.listed)} listed`,
      ].join(' · ');
      line.classList.remove('bad-text');
    } catch (err) {
      line.textContent = `Couldn't reach the local server: ${err.message}`;
      line.classList.add('bad-text');
    }
  }

  // ---- Routing ---------------------------------------------------------------------------------

  const VIEWS = ['request', 'real', 'real-detail', 'packets', 'packet', 'accuracy', 'health', 'eval'];
  const TABS = ['request', 'real', 'packets', 'accuracy', 'health', 'eval'];
  const TITLES = {
    request: 'Request',
    real: 'Real requests',
    'real-detail': 'Real request',
    packets: 'Packets',
    packet: 'Packet',
    accuracy: 'Accuracy',
    health: 'Index health',
    eval: 'Eval',
  };
  let previousHash = '';

  function decodeId(text) {
    try {
      return decodeURIComponent(text);
    } catch (err) {
      return text;
    }
  }

  function parseRoute(hash) {
    const raw = String(hash || '').replace(/^#\/?/, '');
    const cut = raw.indexOf('/');
    const head = cut === -1 ? raw : raw.slice(0, cut);
    const id = cut === -1 ? '' : decodeId(raw.slice(cut + 1));
    if (head === 'real') return id ? { view: 'real-detail', tab: 'real', id } : { view: 'real', tab: 'real' };
    if (head === 'packets') return id ? { view: 'packet', tab: 'packets', id } : { view: 'packets', tab: 'packets' };
    if (head === 'accuracy' || head === 'health' || head === 'eval') return { view: head, tab: head };
    return { view: 'request', tab: 'request' };
  }

  function route() {
    const r = parseRoute(window.location.hash);
    for (const name of VIEWS) $(`view-${name}`).hidden = name !== r.view;
    for (const name of TABS) {
      const tab = $(`tab-${name}`);
      if (name === r.tab) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    }
    document.title = `${TITLES[r.view]} · Manish's Drive check`;
    if (r.view === 'real') showRealList(false);
    else if (r.view === 'real-detail') showRealDetail(r.id);
    else if (r.view === 'packets') showPackets(false);
    else if (r.view === 'packet') showPacket(r.id);
    else if (r.view === 'accuracy') showAccuracy();
    else if (r.view === 'health') showHealth(false);
    else if (r.view === 'eval') showEval(false);
  }

  function onHashChange(event) {
    let from = '';
    try {
      from = new URL(event.oldURL).hash;
    } catch (err) {
      from = '';
    }
    previousHash = from;
    route();
  }

  /** Back to where the founder came from (a request, Accuracy, Eval), else to the list. */
  function backLink(listHash, listText, detailPrefix) {
    const usable = previousHash && previousHash !== window.location.hash && !previousHash.startsWith(detailPrefix);
    const target = usable ? previousHash : listHash;
    const text = target === listHash ? listText : TITLES[parseRoute(target).view];
    return h('a', { class: 'back', href: target }, `← ${text}`);
  }

  // ---- Request (dry run): Chris asks Manish ----------------------------------------------------

  const askState = { running: false, response: null, request: null, ctx: null, timer: null };

  function localDay(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** The last n months up to yesterday: on Oct 16, six months is Apr 16 to Oct 15. */
  function setLastMonths(n) {
    const today = new Date();
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    const month = today.getMonth() - n;
    const lastDay = new Date(today.getFullYear(), month + 1, 0).getDate();
    const start = new Date(today.getFullYear(), month, Math.min(today.getDate(), lastDay));
    $('ask-start').value = localDay(start);
    $('ask-end').value = localDay(end);
  }

  function initAsk() {
    $('ask-form').addEventListener('submit', (event) => {
      event.preventDefault();
      runAsk();
    });
    $('ask-prompt').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        runAsk();
      }
    });
    $('ask-prompt').addEventListener('input', () => {
      $('ask-preset-note').hidden = true;
    });
    $('range-6').addEventListener('click', () => setLastMonths(6));
    $('range-8').addEventListener('click', () => setLastMonths(8));
    $('range-none').addEventListener('click', () => {
      $('ask-start').value = '';
      $('ask-end').value = '';
    });
  }

  async function loadPresets() {
    const box = $('preset-list');
    fill(box, h('span', { class: 'hint' }, 'Loading…'));
    try {
      const presets = objects(await API.presets());
      fill(box, presets.length ? presets.map(presetChip) : h('span', { class: 'hint' }, 'No replays.'));
    } catch (err) {
      fill(box, h('span', { class: 'hint bad-text' }, `Replays unavailable: ${err.message}`));
    }
  }

  function presetChip(preset) {
    const asOf = fmtDayValue(preset.as_of);
    return h(
      'button',
      {
        type: 'button',
        class: 'chip chip-preset',
        title: [preset.prompt, fmtRange(preset.period_start, preset.period_end)].filter(Boolean).join('\n'),
        onclick: () => usePreset(preset),
      },
      h('span', null, preset.label || preset.prompt || preset.id || 'Replay'),
      asOf ? h('span', { class: 'chip-sub' }, `asked ${asOf}`) : null,
    );
  }

  function usePreset(preset) {
    if (askState.running) return;
    const s = parseDay(preset.period_start);
    const e = parseDay(preset.period_end);
    $('ask-prompt').value = preset.prompt || '';
    $('ask-start').value = s ? s.key : '';
    $('ask-end').value = e ? e.key : '';
    const note = $('ask-preset-note');
    const asOf = fmtDayValue(preset.as_of);
    note.textContent =
      `Replaying “${preset.label || preset.prompt}”${asOf ? `, first asked ${asOf}` : ''}. ` +
      'It runs the deployed code on today’s index.';
    note.hidden = false;
    runAsk();
  }

  function formError(text) {
    const box = $('ask-error');
    box.textContent = text || '';
    box.hidden = !text;
  }

  function setRunning(running, startedAt) {
    const button = $('ask-run');
    askState.running = running;
    button.disabled = running;
    if (askState.timer) {
      window.clearInterval(askState.timer);
      askState.timer = null;
    }
    if (!running) {
      button.textContent = 'Send';
      return;
    }
    const paint = () => {
      button.textContent = `Sending… ${((Date.now() - startedAt) / 1000).toFixed(1)} s`;
    };
    paint();
    askState.timer = window.setInterval(paint, 100);
  }

  async function runAsk() {
    if (askState.running) return;
    const prompt = $('ask-prompt').value.trim();
    const start = $('ask-start').value || null;
    const end = $('ask-end').value || null;
    if (!prompt) {
      formError('Type what Chris asks for.');
      return;
    }
    if (Boolean(start) !== Boolean(end)) {
      formError('Pick both dates, or neither.');
      return;
    }
    if (start && end && start > end) {
      formError('The start date is after the end date.');
      return;
    }
    formError('');
    const result = $('ask-result');
    setRunning(true, Date.now());
    fill(
      result,
      loadingBlock('Agent One is reading the request, searching Manish’s Drive and picking files. The deployed engine can take a minute.'),
    );
    try {
      const response = (await API.ask(prompt, start, end)) || {};
      const askId = typeof response.ask_id === 'string' && response.ask_id ? response.ask_id : null;
      askState.response = response;
      askState.request = { prompt, start, end };
      askState.ctx = labelCtx('ask', askId, askId ? (documentId, verdict, note) => API.labelAsk(askId, documentId, verdict, note) : null);
      renderAskResult();
    } catch (err) {
      fill(result, errorBlock(`The request failed: ${err.message}`, () => runAsk()));
    } finally {
      setRunning(false, 0);
    }
  }

  function askSummary(r, docs, rows, ctx) {
    const u = r.understood && typeof r.understood === 'object' ? r.understood : {};
    const c = r.counts && typeof r.counts === 'object' ? r.counts : {};
    const t = r.timings_ms && typeof r.timings_ms === 'object' ? r.timings_ms : {};
    const e = r.engine && typeof r.engine === 'object' ? r.engine : {};
    const what = u.summary ? readable(u.summary) : asList(u.kinds).map(humanize).join(', ') || 'the request';
    const leftOut = docCounts(docs).leftOut;
    const line = [
      `Understood: ${what}, ${fmtRange(u.period_start, u.period_end) || 'no dates'}`,
      `${fmtInt(c.drive_rows)} Drive rows`,
      `${fmtInt(c.selected)} matched`,
      `${fmtInt(leftOut)} left out`,
      `${fmtInt(c.not_indexed)} not indexed yet`,
      fmtSeconds(t.total),
      fmtCost(r.est_cost_usd),
    ].join(' · ');
    const match = e.match === true;
    const meta = [
      `${r.as_buyer || 'Chris (simulated)'} asked ${r.owner || 'Manish'}`,
      `engine ${e.entry_point || 'unknown entry point'} @ ${shortSha(e.engine_sha)}`,
      match ? `same as deployed ${shortSha(e.deployed_sha)}` : `deployed is ${shortSha(e.deployed_sha)}`,
      e.dry_run === true ? 'dry run' : null,
      isNum(r.model_calls) ? plural(r.model_calls, 'model call') : 'model calls unknown',
      `est. ${fmtCost(r.est_cost_usd)}`,
    ]
      .filter(Boolean)
      .join(' · ');
    return h(
      'section',
      { class: 'card summary' },
      h('p', { class: 'summary-line' }, line),
      h('p', { class: 'summary-detail' }, meta),
      match ? null : h('p', { class: 'flag flag-bad' }, 'This answer did not come from the deployed code. Do not judge UAT by it.'),
      e.dry_run === true ? null : h('p', { class: 'flag flag-bad' }, 'This answer is not marked as a dry run.'),
      h('div', { class: 'overall' }, h('span', { class: 'row-label' }, 'Is this answer right?'), overallControl(ctx, docs, rows, null)),
      ctx.id ? h('p', { class: 'mono' }, `Ask ${ctx.id}`) : null,
    );
  }

  function renderAskResult() {
    const r = askState.response || {};
    const typed = askState.request || {};
    const ctx = askState.ctx;
    const docs = isNotRecorded(r.documents) ? [] : objects(r.documents);
    const drive = r.drive_api && typeof r.drive_api === 'object' && !Array.isArray(r.drive_api) ? r.drive_api : null;
    const rows = drive && !isNotRecorded(drive.rows) ? objects(drive.rows) : [];
    const u = r.understood && typeof r.understood === 'object' ? r.understood : {};
    const win = periodWindow(typed.start, typed.end) || periodWindow(u.period_start, u.period_end);
    fill(
      $('ask-result'),
      askSummary(r, docs, rows, ctx),
      mistakeCard(mistakeChecks(docs, rows, win, Boolean(drive && !isNotRecorded(drive.rows)))),
      section(1, 'What Agent One understood', understoodBody(r.understood, typed, DRY)),
      section(2, 'Google Drive search', drivePanel(r.drive_api, DRY)),
      section(3, 'Funnel', funnelBody(r.counts, r.steps, r.rejected_by_reason, r.timings_ms, DRY)),
      section(4, 'Documents', documentsBody(r.documents, ctx, win, DRY, null), docsAside(docs)),
      section(5, 'What Manish would approve', ownerReviewBody(r.owner_review, DRY, 'Chris')),
      section(6, 'Packets Chris could buy instead', matchingPacketsBody(r.matching_packets, DRY)),
      section(7, 'Buyer checks', buyerChecksBody(r.buyer_checks, DRY)),
      section(8, 'Logs', logsBody(r.logs, DRY)),
    );
  }

  // ---- Real requests ------------------------------------------------------------------------------

  function stripeBanner() {
    return h(
      'p',
      { class: 'banner banner-money', role: 'note' },
      h('strong', null, 'UAT checkout uses live Stripe keys:'),
      ' a real request you pay for in the app charges real money.',
    );
  }

  function yesNoTag(value, yes, no) {
    if (value === true) return tag(yes, 'ok');
    if (value === false) return tag(no, 'neutral');
    return tag(`${yes}: not recorded`, 'outline');
  }

  /** Status, paid and delivered, without saying "Delivered" twice. */
  function requestTags(r) {
    const status = humanize(r.status) || 'No status';
    const repeats = (status === 'Paid' && r.paid === true) || (status === 'Delivered' && r.delivered === true);
    return [
      repeats ? null : tag(status, toneFor(r.status)),
      yesNoTag(r.paid, 'Paid', 'Not paid'),
      yesNoTag(r.delivered, 'Delivered', 'Not delivered'),
    ];
  }

  const realState = { data: null, error: null, loading: false };

  async function showRealList(force) {
    if (realState.loading) return;
    if (realState.data && !force) {
      renderRealList();
      return;
    }
    realState.loading = true;
    renderRealList();
    try {
      realState.data = objects(await API.requests());
      realState.error = null;
    } catch (err) {
      realState.error = err;
    } finally {
      realState.loading = false;
    }
    renderRealList();
  }

  function realRow(r) {
    const sub = [
      r.requester_display_name || 'Unknown requester',
      r.created_at ? fmtStamp(r.created_at) : null,
      fmtRange(r.period_start, r.period_end) || 'No dates',
    ]
      .filter(Boolean)
      .join(' · ');
    return h(
      'li',
      { class: 'row' },
      rowMain(
        r.request_id ? `#/real/${enc(r.request_id)}` : null,
        icon('doc', toneFor(r.status)),
        h(
          'span',
          { class: 'row-text' },
          h('span', { class: 'row-title', title: r.purpose_text || '' }, r.purpose_text || 'No request text'),
          h('span', { class: 'row-sub' }, sub),
        ),
        h(
          'span',
          { class: 'row-trail' },
          h('span', { class: 'row-amount' }, `${plural(r.selected_count, 'file')} picked`),
          requestTags(r),
          labelTag(normalizeLabel(requestLabels(r.human_label).overall), 'You'),
        ),
        r.request_id ? chevron() : null,
      ),
    );
  }

  function renderRealList() {
    const st = realState;
    const rows = asList(st.data)
      .slice()
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    let body;
    if (st.error && !st.data) body = errorBlock(`Couldn't load real requests: ${st.error.message}`, () => showRealList(true));
    else if (!st.data) body = loadingBlock('Loading real requests…');
    else if (!rows.length) body = emptyBlock('No real requests to Manish yet. Make one in the UAT app with a test buyer account.');
    else body = h('section', { class: 'card list-card' }, h('ul', { class: 'list' }, rows.map(realRow)));
    fill(
      $('view-real'),
      sectionHead(
        'Real requests to Manish',
        st.data ? `${plural(rows.length, 'request')}, newest first. Read from UAT, read-only.` : st.loading ? 'Loading…' : '',
        refreshButton(st.loading, () => showRealList(true)),
      ),
      stripeBanner(),
      st.error && st.data ? h('p', { class: 'flag flag-warn' }, `Couldn't refresh: ${st.error.message}`) : null,
      body,
    );
  }

  const realDetail = { seq: 0, ctxs: new Map() };

  /** A request's saved labels: one overall label and, maybe, one per document. */
  function requestLabels(label) {
    if (!label || typeof label !== 'object' || Array.isArray(label) || label.verdict) {
      return { overall: label || null, documents: {} };
    }
    const documents = {};
    const docs = label.documents;
    if (Array.isArray(docs)) {
      for (const item of objects(docs)) if (item.document_id) documents[item.document_id] = item;
    } else if (docs && typeof docs === 'object') {
      Object.assign(documents, docs);
    }
    return { overall: label.overall || null, documents };
  }

  async function showRealDetail(requestId) {
    const view = $('view-real-detail');
    const seq = ++realDetail.seq;
    const back = backLink('#/real', 'All real requests', '#/real/');
    fill(view, back, stripeBanner(), loadingBlock('Loading the request…'));
    try {
      const d = (await API.realRequest(requestId)) || {};
      if (seq !== realDetail.seq) return;
      renderRealDetail(d, requestId, back);
    } catch (err) {
      if (seq !== realDetail.seq) return;
      const text =
        err.status === 404
          ? 'Not found: this is not a request to Manish, or it no longer exists.'
          : `Couldn't load the request: ${err.message}`;
      fill(view, back, stripeBanner(), errorBlock(text, err.status === 404 ? null : () => showRealDetail(requestId)));
    }
  }

  function renderRealDetail(d, requestId, back) {
    const id = typeof d.request_id === 'string' && d.request_id ? d.request_id : requestId;
    let ctx = realDetail.ctxs.get(id);
    if (!ctx) {
      ctx = labelCtx('real', id, (documentId, verdict, note) => API.labelRequest(id, documentId, verdict, note));
      realDetail.ctxs.set(id, ctx);
    }
    const docs = isNotRecorded(d.documents) ? [] : objects(d.documents);
    const drive = d.drive_api && typeof d.drive_api === 'object' && !Array.isArray(d.drive_api) ? d.drive_api : null;
    const rows = drive && !isNotRecorded(drive.rows) ? objects(drive.rows) : [];
    const win = periodWindow(d.period_start, d.period_end);
    const who = d.requester_display_name || 'the requester';
    const labels = requestLabels(d.human_label);
    const header = h(
      'section',
      { class: 'card summary' },
      h(
        'div',
        { class: 'title-row' },
        h('h2', null, d.purpose_text || 'No request text'),
        h('div', { class: 'tags' }, requestTags(d)),
      ),
      h(
        'p',
        { class: 'summary-detail' },
        [
          `${who} asked Manish`,
          d.created_at ? fmtStamp(d.created_at) : null,
          fmtRange(d.period_start, d.period_end) || 'No dates',
          `${plural(d.selected_count, 'file')} picked`,
        ]
          .filter(Boolean)
          .join(' · '),
      ),
      h(
        'div',
        { class: 'overall' },
        h('span', { class: 'row-label' }, 'Did the deployed backend get this right?'),
        overallControl(ctx, docs, rows, labels.overall),
      ),
      h('p', { class: 'mono' }, `Request ${id}`),
    );
    fill(
      $('view-real-detail'),
      back,
      stripeBanner(),
      header,
      docs.length || rows.length ? mistakeCard(mistakeChecks(docs, rows, win, Boolean(drive && !isNotRecorded(drive.rows)))) : null,
      section(1, 'What Agent One understood', understoodBody(d.plan, null, REAL)),
      section(2, 'Google Drive search', drivePanel(d.drive_api, REAL)),
      section(3, 'Steps', funnelBody(null, d.steps, null, null, REAL)),
      section(4, 'Documents', documentsBody(d.documents, ctx, win, REAL, labels.documents), docsAside(docs)),
      section(5, 'What Manish saw', ownerReviewBody(d.owner_review, REAL, who)),
      section(6, 'Payment', paymentBody(d.payment, REAL)),
      section(7, 'Delivery', deliveryBody(d.delivery, d.payment, REAL, who)),
      section(8, 'Logs', logsBody(d.logs, REAL)),
    );
  }

  // ---- Packets ----------------------------------------------------------------------------------

  const packetsState = { data: null, error: null, loading: false, filter: 'all' };

  async function showPackets(force) {
    if (packetsState.loading) return;
    if (packetsState.data && !force) {
      renderPackets();
      return;
    }
    packetsState.loading = true;
    renderPackets();
    try {
      packetsState.data = objects(await API.packets());
      packetsState.error = null;
    } catch (err) {
      packetsState.error = err;
    } finally {
      packetsState.loading = false;
    }
    renderPackets();
  }

  function packetRowById(packetId) {
    return asList(packetsState.data).find((p) => p.packet_id === packetId) || null;
  }

  function disagrees(p) {
    const ai = normalizeAi(p.ai_verdict);
    const you = normalizeLabel(p.human_label);
    return Boolean(ai && ai !== 'undecided' && you && (you.verdict === 'correct' || you.verdict === 'wrong') && ai !== you.verdict);
  }

  function renderPackets() {
    const st = packetsState;
    const all = asList(st.data);
    const checked = all.filter((p) => normalizeLabel(p.human_label)).length;
    const filters = [
      ['all', 'All', () => true],
      ['unchecked', 'To check', (p) => !normalizeLabel(p.human_label)],
      ['checked', 'Checked', (p) => Boolean(normalizeLabel(p.human_label))],
      ['disagree', 'You and AI disagree', disagrees],
    ];
    const seg = h(
      'div',
      { class: 'seg', role: 'group', 'aria-label': 'Show' },
      filters.map(([value, text]) =>
        h(
          'button',
          {
            type: 'button',
            class: 'seg-btn',
            'aria-pressed': String(st.filter === value),
            onclick: () => {
              st.filter = value;
              renderPackets();
            },
          },
          text,
        ),
      ),
    );
    let body;
    if (st.error && !st.data) body = errorBlock(`Couldn't load packets: ${st.error.message}`, () => showPackets(true));
    else if (!st.data) body = loadingBlock('Loading packets…');
    else {
      const keep = (filters.find((f) => f[0] === st.filter) || filters[0])[2];
      const rows = all.filter(keep);
      body = rows.length
        ? h('section', { class: 'card list-card' }, h('ul', { class: 'list' }, rows.map(packetRow)))
        : emptyBlock(all.length ? 'Nothing here.' : 'No packets yet.');
    }
    fill(
      $('view-packets'),
      sectionHead(
        'Manish’s packets',
        st.data
          ? `${plural(all.length, 'packet')} · ${fmtInt(checked)} checked by you · ${fmtInt(all.length - checked)} to check`
          : st.loading
            ? 'Loading…'
            : '',
        seg,
        refreshButton(st.loading, () => showPackets(true)),
      ),
      st.error && st.data ? h('p', { class: 'flag flag-warn' }, `Couldn't refresh: ${st.error.message}`) : null,
      body,
    );
  }

  function packetRow(p) {
    const sub = [
      plural(p.member_count, 'document'),
      p.period_label || 'No period',
      p.updated_at ? `updated ${fmtStamp(p.updated_at)}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return h(
      'li',
      { class: 'row' },
      rowMain(
        p.packet_id ? `#/packets/${enc(p.packet_id)}` : null,
        icon('stack', toneFor(p.status)),
        h(
          'span',
          { class: 'row-text' },
          h('span', { class: 'row-title', title: p.title || '' }, p.title || 'Untitled packet'),
          h('span', { class: 'row-sub' }, sub),
        ),
        h(
          'span',
          { class: 'row-trail' },
          h('span', { class: 'row-amount' }, fmtPrice(p.price_cents)),
          p.listed ? tag('Listed', 'info') : null,
          tag(humanize(p.status) || 'No status', toneFor(p.status)),
          aiTag(p.ai_verdict),
          labelTag(normalizeLabel(p.human_label), 'You'),
        ),
        p.packet_id ? chevron() : null,
      ),
    );
  }

  let packetSeq = 0;

  async function showPacket(packetId) {
    const view = $('view-packet');
    const seq = ++packetSeq;
    const back = backLink('#/packets', 'All packets', '#/packets/');
    fill(view, back, loadingBlock('Loading packet…'));
    try {
      const detail = (await API.packet(packetId)) || {};
      if (seq !== packetSeq) return;
      renderPacket(detail, packetId, back);
    } catch (err) {
      if (seq !== packetSeq) return;
      const text =
        err.status === 404
          ? 'Not found: this packet is not one of Manish’s packets, or it no longer exists.'
          : `Couldn't load the packet: ${err.message}`;
      fill(view, back, errorBlock(text, err.status === 404 ? null : () => showPacket(packetId)));
    }
  }

  /** One verdict from a packet's eval rows: any fail is wrong, all pass is correct. */
  function aiFromVerdicts(verdicts) {
    const values = verdicts.map((v) => normalizeAi(v.verdict)).filter(Boolean);
    if (!values.length) return null;
    if (values.includes('wrong')) return 'wrong';
    return values.every((v) => v === 'correct') ? 'correct' : 'undecided';
  }

  function renderPacket(d, requestedId, back) {
    const packetId = d.packet_id || requestedId;
    const members = objects(d.members);
    const checks = objects(d.checks);
    const verdicts = objects(d.eval_verdicts);
    const listRow = packetRowById(packetId);
    const ai = listRow && listRow.ai_verdict !== undefined ? listRow.ai_verdict : aiFromVerdicts(verdicts);
    const headLabel = h('span', { class: 'head-label' }, labelTag(normalizeLabel(d.human_label), 'You'));
    const head = h(
      'section',
      { class: 'card packet-head' },
      h(
        'div',
        { class: 'title-row' },
        h('h2', null, d.title || 'Untitled packet'),
        h(
          'div',
          { class: 'tags' },
          tag(humanize(d.status) || 'No status', toneFor(d.status)),
          d.listed ? tag('Listed', 'info') : tag('Not listed', 'outline'),
          aiTag(ai),
          headLabel,
        ),
      ),
      d.status_reason ? h('p', { class: 'status-reason' }, readable(d.status_reason)) : null,
      h(
        'p',
        { class: 'meta' },
        [plural(members.length, 'document'), fmtPrice(d.price_cents)].join(' · '),
        d.version_id ? h('span', { class: 'mono' }, ` · version ${d.version_id}`) : null,
      ),
    );
    const main = h(
      'div',
      { class: 'packet-main' },
      h(
        'section',
        { class: 'card' },
        cardHead('Documents', fmtInt(members.length)),
        members.length ? h('ol', { class: 'members' }, members.map(memberItem)) : h('p', { class: 'hint pad' }, 'No documents.'),
      ),
    );
    const side = h(
      'aside',
      { class: 'packet-side' },
      packetLabelCard(d, packetId, headLabel),
      buyerCard(d),
      checksCard(checks),
      evalCard(verdicts),
    );
    fill($('view-packet'), back, head, h('div', { class: 'packet-grid' }, main, side));
  }

  function memberItem(m) {
    const period = fmtRange(m.period_start, m.period_end);
    const who = [m.issuer, maskAccount(m.account_mask), m.holder_name].filter(Boolean).join(' · ');
    const quotes = objects(m.quotes).filter((q) => q.text);
    return h(
      'li',
      { class: 'member' },
      h(
        'div',
        { class: 'member-head' },
        icon('doc', period ? 'ok' : 'warn'),
        h(
          'div',
          { class: 'member-text' },
          h('div', { class: 'member-name', title: m.file_name || '' }, m.file_name || 'Untitled document'),
          h(
            'div',
            { class: 'member-sub' },
            [humanize(m.kind) || 'Unknown kind', isNum(m.pages) ? plural(m.pages, 'page') : 'pages unknown'].join(' · '),
          ),
        ),
        h(
          'div',
          { class: 'member-period' },
          h('div', { class: period ? 'period' : 'period warn-text' }, period || 'No period'),
          m.period_role ? h('div', { class: 'hint' }, humanize(m.period_role)) : null,
        ),
      ),
      who ? h('p', { class: 'member-who' }, who) : null,
      quotes.length
        ? h('div', { class: 'quotes' }, quotes.map((q) => quoteBlock(q.text, q.page)))
        : h('p', { class: 'flag flag-warn' }, 'No quote proves this period.'),
      m.document_id ? h('p', { class: 'mono' }, m.document_id) : null,
    );
  }

  function packetLabelCard(d, packetId, headLabel) {
    const saved = normalizeLabel(d.human_label);
    const st = { verdict: saved ? saved.verdict : null, saving: false };
    const status = h('p', { class: 'save-status', role: 'status' }, labelText(saved));
    const buttons = PACKET_VERDICT_VALUES.map((verdict) =>
      h(
        'button',
        {
          type: 'button',
          class: `seg-btn v-${verdict}`,
          'aria-pressed': 'false',
          onclick: () => {
            st.verdict = verdict;
            paint();
          },
        },
        VERDICT_LABELS[verdict],
      ),
    );
    const reason = h(
      'select',
      { class: 'select', id: 'packet-reason' },
      h('option', { value: '' }, 'Pick a reason'),
      WRONG_REASON_VALUES.map((code) => h('option', { value: code }, REASON_LABELS[code])),
    );
    reason.value = saved && saved.reason && WRONG_REASON_VALUES.includes(saved.reason) ? saved.reason : '';
    reason.addEventListener('change', () => paint());
    const reasonField = h(
      'div',
      { class: 'field' },
      h('label', { class: 'field-label', for: 'packet-reason' }, 'Why is it wrong?'),
      reason,
    );
    const note = h('textarea', { class: 'note', id: 'packet-note', rows: '3', maxlength: '2000', placeholder: 'Note (optional)' });
    note.value = saved ? saved.note : '';
    const save = h('button', { type: 'button', class: 'btn-primary', onclick: () => submit() }, 'Save check');

    function ready() {
      return PACKET_VERDICT_VALUES.includes(st.verdict) && (st.verdict !== 'wrong' || WRONG_REASON_VALUES.includes(reason.value));
    }

    function paint() {
      PACKET_VERDICT_VALUES.forEach((verdict, i) => buttons[i].setAttribute('aria-pressed', String(st.verdict === verdict)));
      reasonField.hidden = st.verdict !== 'wrong';
      save.disabled = st.saving || !ready();
    }

    async function submit() {
      if (st.saving || !ready()) return;
      const verdict = st.verdict;
      const why = verdict === 'wrong' ? reason.value : null;
      const text = note.value.trim();
      st.saving = true;
      paint();
      status.className = 'save-status';
      status.textContent = 'Saving…';
      try {
        await API.labelPacket(packetId, verdict, why, text);
        const label = { verdict, reason: why, note: text, at: new Date().toISOString() };
        d.human_label = label;
        const row = packetRowById(packetId);
        if (row) row.human_label = label;
        status.className = 'save-status ok-text';
        status.textContent = labelText(normalizeLabel(label));
        fill(headLabel, labelTag(normalizeLabel(label), 'You'));
      } catch (err) {
        status.className = 'save-status bad-text';
        status.textContent = `Couldn't save: ${err.message}`;
      } finally {
        st.saving = false;
        paint();
      }
    }

    paint();
    return h(
      'section',
      { class: 'card label-card' },
      cardHead('Your check'),
      h('div', { class: 'seg seg-wide', role: 'group', 'aria-label': 'Your verdict' }, buttons),
      reasonField,
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'packet-note' }, 'Note'), note),
      h('div', { class: 'label-actions' }, save),
      status,
    );
  }

  function buyerCard(d) {
    return h(
      'section',
      { class: 'card' },
      cardHead('What a buyer sees'),
      h(
        'div',
        { class: 'pad' },
        h('p', { class: 'buyer-title' }, d.buyer_title || 'No buyer title'),
        d.buyer_summary ? h('p', { class: 'buyer-summary' }, d.buyer_summary) : h('p', { class: 'hint' }, 'No buyer summary.'),
        h('p', { class: 'meta' }, `${fmtPrice(d.price_cents)} · ${d.listed ? 'Listed' : 'Not listed'}`),
      ),
    );
  }

  function checksCard(checks) {
    const failed = checks.filter((c) => c.ok === false);
    const ordered = failed.concat(checks.filter((c) => c.ok !== false));
    return h(
      'section',
      { class: 'card' },
      cardHead('Runtime checks', checks.length ? `${fmtInt(checks.length - failed.length)} passed · ${fmtInt(failed.length)} failed` : null),
      checks.length
        ? h(
            'ul',
            { class: 'kv' },
            ordered.map((c) =>
              h(
                'li',
                { class: 'kv-row' },
                h('span', { class: 'kv-key', title: c.name || '' }, readable(c.name) || 'Unnamed check'),
                c.ok === true ? tag('Passed', 'ok') : c.ok === false ? tag('Failed', 'bad') : tag('Unknown', 'neutral'),
                c.reason ? h('span', { class: 'kv-note' }, readable(c.reason)) : null,
              ),
            ),
          )
        : h('p', { class: 'hint pad' }, 'No checks recorded.'),
    );
  }

  function evalCard(verdicts) {
    return h(
      'section',
      { class: 'card' },
      cardHead('Eval judges'),
      verdicts.length
        ? h(
            'ul',
            { class: 'kv' },
            verdicts.map((v) =>
              h(
                'li',
                { class: 'kv-row' },
                h('span', { class: 'kv-key' }, [readable(v.judge) || 'Judge', v.batch ? `batch ${v.batch}` : null].filter(Boolean).join(' · ')),
                tag(humanize(v.verdict) || 'No verdict', toneFor(v.verdict)),
                v.severity ? h('span', { class: 'kv-note' }, `Severity: ${readable(v.severity)}`) : null,
              ),
            ),
          )
        : h('p', { class: 'hint pad' }, 'No eval judge looked at this packet.'),
    );
  }

  // ---- Accuracy ----------------------------------------------------------------------------------

  const accuracyState = { data: null, error: null, loading: false };

  async function showAccuracy() {
    if (accuracyState.loading) return;
    accuracyState.loading = true;
    renderAccuracy();
    try {
      accuracyState.data = (await API.accuracy()) || {};
      accuracyState.error = null;
    } catch (err) {
      accuracyState.error = err;
    } finally {
      accuracyState.loading = false;
    }
    renderAccuracy();
  }

  function errorTone(wrong, judged) {
    if (!judged) return 'neutral';
    return wrong > 0 ? 'bad' : 'ok';
  }

  function bigNumber(title, value, lines, tone) {
    return h(
      'div',
      { class: `big big-${tone || 'neutral'}` },
      h('div', { class: 'big-title' }, title),
      h('div', { class: 'big-num' }, value),
      lines.map((line) => h('div', { class: 'big-sub' }, line)),
    );
  }

  function barStatus(side, need) {
    if (!isNum(need)) return '–';
    if (side.wrong > 0) return tag(`Not met: ${plural(side.wrong, 'wrong')}`, 'bad');
    if (side.judged >= need) return tag(`Met: ${fmtInt(side.judged)} with 0 wrong`, 'ok');
    return tag(`${fmtInt(side.judged)} of ${fmtInt(need)} so far, 0 wrong`, 'warn');
  }

  function barsBlock(bars, ai, you) {
    const rows = [
      ['At least 95% right', bars.n95],
      ['At least 99.9% right', bars.n999],
    ];
    return h(
      'div',
      { class: 'bars' },
      h(
        'p',
        { class: 'hint pad' },
        `The eval’s bars: to say at least 95% are right takes ${fmtInt(bars.n95)} checked with 0 wrong. ` +
          `To say at least 99.9%, ${fmtInt(bars.n999)} checked with 0 wrong.`,
      ),
      tableWrap(
        h(
          'table',
          { class: 'table' },
          h('thead', null, h('tr', null, th('Bar'), th('Needs'), th('AI'), th('You'))),
          h(
            'tbody',
            null,
            rows.map(([label, need]) =>
              h(
                'tr',
                null,
                td(label),
                td(isNum(need) ? `0 wrong of ${fmtInt(need)}` : '–'),
                td(barStatus(ai, need)),
                td(barStatus(you, need)),
              ),
            ),
          ),
        ),
      ),
    );
  }

  function agreementBlock(ag) {
    const list = objects(ag.disagreements);
    const both = num(ag.both);
    return h(
      'div',
      { class: 'agree' },
      h(
        'p',
        { class: 'pad agree-line' },
        both
          ? `Agreement: you and the AI both judged ${fmtInt(both)}. You agree on ${fmtInt(ag.agree)} (${fmtPct(ratio(ag.agree, both))}) and disagree on ${fmtInt(ag.disagree)}.`
          : 'Agreement: no packet has both an AI verdict and your check yet.',
      ),
      list.length
        ? h(
            'ul',
            { class: 'list' },
            list.map((x) => {
              const row = x.packet_id ? packetRowById(x.packet_id) : null;
              return h(
                'li',
                { class: 'row' },
                rowMain(
                  x.packet_id ? `#/packets/${enc(x.packet_id)}` : null,
                  icon('stack', 'bad'),
                  h(
                    'span',
                    { class: 'row-text' },
                    h('span', { class: 'row-title' }, (row && row.title) || x.packet_id || 'Packet'),
                    h('span', { class: 'row-sub' }, 'You and the AI disagree. Open it to look again.'),
                  ),
                  h('span', { class: 'row-trail' }, aiTag(x.ai), labelTag(normalizeLabel(x.human), 'You')),
                  x.packet_id ? chevron() : null,
                ),
              );
            }),
          )
        : null,
    );
  }

  function packetAccuracy(p) {
    const ai = p.ai && typeof p.ai === 'object' ? p.ai : {};
    const you = p.human && typeof p.human === 'object' ? p.human : {};
    const aiJudged = num(ai.correct) + num(ai.wrong);
    const youJudged = num(you.correct) + num(you.wrong);
    return h(
      'section',
      { class: 'card acc' },
      cardHead('Packets', 'Manish’s Ready packets'),
      h(
        'div',
        { class: 'big-pair' },
        bigNumber(
          'AI says',
          fmtPct(ratio(ai.correct, aiJudged)),
          [
            `${fmtInt(ai.correct)} right, ${fmtInt(ai.wrong)} wrong of ${fmtInt(aiJudged)} judged`,
            `${fmtInt(ai.undecided)} undecided · n = ${fmtInt(ai.n)}`,
          ],
          errorTone(num(ai.wrong), aiJudged),
        ),
        bigNumber(
          'You found',
          fmtPct(ratio(you.correct, youJudged)),
          [
            `${fmtInt(you.correct)} right, ${fmtInt(you.wrong)} wrong of ${fmtInt(youJudged)} checked`,
            `${fmtInt(you.unsure)} not sure · n = ${fmtInt(you.n)}`,
          ],
          errorTone(num(you.wrong), youJudged),
        ),
      ),
      agreementBlock(p.agreement && typeof p.agreement === 'object' ? p.agreement : {}),
      barsBlock(
        p.bars && typeof p.bars === 'object' ? p.bars : {},
        { judged: aiJudged, wrong: num(ai.wrong) },
        { judged: youJudged, wrong: num(you.wrong) },
      ),
    );
  }

  const SOURCE_NAMES = { dry_run: 'Dry runs', real: 'Real requests' };

  function sourcesTable(sources) {
    const keys = Object.keys(sources);
    if (!keys.length) return null;
    return tableWrap(
      h(
        'table',
        { class: 'table' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            th('Source'),
            th('Picked', 'num'),
            th('Right', 'num'),
            th('Wrong', 'num'),
            th('Not sure', 'num'),
            th('Missed', 'num'),
            th('Your labels', 'num'),
            th('You found right', 'num'),
          ),
        ),
        h(
          'tbody',
          null,
          keys.map((key) => {
            const s = sources[key] && typeof sources[key] === 'object' ? sources[key] : {};
            const judged = num(s.right) + num(s.wrong);
            const precision = isNum(s.precision) ? s.precision : ratio(s.right, judged);
            return h(
              'tr',
              null,
              td(SOURCE_NAMES[key] || humanize(key)),
              td(fmtInt(s.system_selected), 'num'),
              td(fmtInt(s.right), 'num'),
              td(fmtInt(s.wrong), 'num'),
              td(fmtInt(s.unsure), 'num'),
              td(fmtInt(s.missed), 'num'),
              td(fmtInt(s.n), 'num'),
              td(`${fmtPct(precision)}${judged ? ` of ${fmtInt(judged)}` : ''}`, 'num'),
            );
          }),
        ),
      ),
    );
  }

  function requestAccuracy(q) {
    const you = q.human && typeof q.human === 'object' ? q.human : {};
    const judged = num(you.right) + num(you.wrong);
    const precision = isNum(you.precision) ? you.precision : ratio(you.right, judged);
    const sources = q.by_source && typeof q.by_source === 'object' && !Array.isArray(q.by_source) ? q.by_source : {};
    return h(
      'section',
      { class: 'card acc' },
      cardHead('Requests', 'Dry runs and real requests'),
      h(
        'div',
        { class: 'big-pair' },
        bigNumber(
          'AI says',
          fmtInt(q.system_selected),
          ['documents picked as matching, with dates proven.', 'It claims every one of them is right.'],
          'neutral',
        ),
        bigNumber(
          'You found',
          fmtPct(precision),
          [
            `${fmtInt(you.right)} right, ${fmtInt(you.wrong)} wrong of ${fmtInt(judged)} picked documents you checked`,
            `${fmtInt(you.unsure)} not sure · ${fmtInt(you.missed)} missed · n = ${fmtInt(you.n)}`,
          ],
          errorTone(num(you.wrong), judged),
        ),
      ),
      h(
        'div',
        { class: 'agree' },
        h(
          'p',
          { class: 'pad agree-line' },
          judged
            ? `Agreement: of the ${fmtInt(judged)} picked documents you checked, you agree with the AI on ${fmtInt(you.right)} (${fmtPct(ratio(you.right, judged))}).`
            : 'Agreement: you have not checked a picked document yet.',
        ),
        num(you.missed)
          ? h('p', { class: 'pad agree-line' }, `You reported ${plural(you.missed, 'document')} it should have picked (missed).`)
          : null,
      ),
      sourcesTable(sources),
    );
  }

  function renderAccuracy() {
    const st = accuracyState;
    const head = sectionHead(
      'Accuracy',
      'What the AI claims next to what you found. Each number shows how many it rests on.',
      refreshButton(st.loading, () => showAccuracy()),
    );
    if (!st.data) {
      fill(
        $('view-accuracy'),
        head,
        st.error ? errorBlock(`Couldn't load accuracy: ${st.error.message}`, () => showAccuracy()) : loadingBlock('Counting…'),
      );
      return;
    }
    const d = st.data;
    fill(
      $('view-accuracy'),
      head,
      st.error ? h('p', { class: 'flag flag-warn' }, `Couldn't refresh: ${st.error.message}`) : null,
      packetAccuracy(d.packets && typeof d.packets === 'object' ? d.packets : {}),
      requestAccuracy(d.requests && typeof d.requests === 'object' ? d.requests : {}),
    );
  }

  // ---- Index health --------------------------------------------------------------------------------

  const healthState = { data: null, error: null, loading: false };

  async function showHealth(force) {
    if (healthState.loading) return;
    if (healthState.data && !force) {
      renderHealth();
      return;
    }
    healthState.loading = true;
    renderHealth();
    try {
      healthState.data = (await API.health()) || {};
      healthState.error = null;
    } catch (err) {
      healthState.error = err;
    } finally {
      healthState.loading = false;
    }
    renderHealth();
  }

  function pctOf(n, total) {
    if (!isNum(n) || !isNum(total) || total <= 0) return null;
    return `${Math.round((n / total) * 100)}% of files found`;
  }

  function tile(label, value, note, tone) {
    return h(
      'div',
      { class: `tile${tone ? ` tile-${tone}` : ''}` },
      h('div', { class: 'tile-num' }, fmtInt(value)),
      h('div', { class: 'tile-label' }, label),
      note ? h('div', { class: 'tile-note' }, note) : null,
    );
  }

  function countList(title, entries, emptyText, tone) {
    return h(
      'section',
      { class: 'card' },
      cardHead(title, entries.length ? fmtInt(sum(entries.map((e) => e[1]))) : null),
      entries.length
        ? h(
            'ul',
            { class: 'kv' },
            entries.map(([code, n]) =>
              h(
                'li',
                { class: 'kv-row' },
                h('span', { class: 'kv-key', title: code }, humanize(code)),
                h('span', { class: `kv-num${tone ? ` ${tone(code)}` : ''}` }, fmtInt(n)),
              ),
            ),
          )
        : h('p', { class: 'hint pad' }, emptyText),
    );
  }

  function renderHealth() {
    const st = healthState;
    const d = st.data;
    const head = sectionHead(
      'Index health',
      d && d.as_of ? `As of ${fmtStamp(d.as_of)} (${fmtAgo(d.as_of)}). Refresh in an hour to see progress.` : st.loading ? 'Loading…' : '',
      refreshButton(st.loading, () => showHealth(true)),
    );
    if (!d) {
      fill(
        $('view-health'),
        head,
        st.error ? errorBlock(`Couldn't load index health: ${st.error.message}`, () => showHealth(true)) : loadingBlock('Counting…'),
      );
      return;
    }
    const failedEntries = sortedEntries(d.failed_by_reason);
    const failed = sum(failedEntries.map((e) => e[1]));
    fill(
      $('view-health'),
      head,
      st.error ? h('p', { class: 'flag flag-warn' }, `Couldn't refresh: ${st.error.message}. Showing the last counts.`) : null,
      h(
        'div',
        { class: 'tiles' },
        tile('Files found', d.files_found, null),
        tile('Files read', d.extracted, pctOf(d.extracted, d.files_found)),
        tile('Facts done', d.facts_complete, pctOf(d.facts_complete, d.files_found)),
        tile('Waiting for facts', d.facts_waiting, null, isNum(d.facts_waiting) && d.facts_waiting > 0 ? 'warn' : null),
        tile('Failed', failed, failedEntries.length ? plural(failedEntries.length, 'reason') : null, failed > 0 ? 'bad' : null),
      ),
      h(
        'section',
        { class: 'card hour' },
        cardHead('Last hour'),
        h(
          'div',
          { class: 'hour-nums' },
          h('div', null, h('span', { class: 'hour-num' }, fmtInt(d.extracted_last_hour)), h('span', { class: 'hint' }, 'files read')),
          h('div', null, h('span', { class: 'hour-num' }, fmtInt(d.facts_last_hour)), h('span', { class: 'hint' }, 'facts done')),
        ),
      ),
      h(
        'div',
        { class: 'two-col' },
        countList('Failed by reason', failedEntries, 'No failures.', () => 'bad-text'),
        countList('Packets by status', sortedEntries(d.packets_by_status), 'No packets.', null),
      ),
    );
  }

  // ---- Eval --------------------------------------------------------------------------------------

  const evalState = { data: null, error: null, loading: false };
  const GATE_NAMES = { listing: 'Safe to list', ready: 'Ready packets', deploy: 'Deploy' };
  const QUEUES = [
    ['wrong', 'Wrong'],
    ['undecided', 'Undecided'],
    ['high_risk', 'High risk'],
  ];

  async function showEval(force) {
    if (evalState.loading) return;
    if (evalState.data && !force) {
      renderEval();
      return;
    }
    evalState.loading = true;
    renderEval();
    try {
      evalState.data = (await API.evalBatches()) || {};
      evalState.error = null;
    } catch (err) {
      evalState.error = err;
    } finally {
      evalState.loading = false;
    }
    renderEval();
  }

  function gateReason(code) {
    const m = /^needs_(\d+)_independent_ready_has_(\d+)$/.exec(String(code));
    if (m) return `${fmtInt(Number(m[2]))} of ${fmtInt(Number(m[1]))} independent Ready packets checked`;
    return readable(code);
  }

  function sameSha(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return null;
    const x = a.trim().toLowerCase();
    const y = b.trim().toLowerCase();
    if (x.length < 7 || y.length < 7) return null;
    return x.startsWith(y) || y.startsWith(x);
  }

  function gateChip(name, value) {
    let status = value;
    let reasons = [];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      status = value.status || value.state || value.verdict || null;
      reasons = asList(value.reasons).map(gateReason).filter(Boolean);
    }
    if (status === true) status = 'pass';
    if (status === false) status = 'fail';
    return h(
      'span',
      { class: 'gate' },
      h('span', { class: 'gate-name' }, GATE_NAMES[name] || humanize(name)),
      tag(status ? humanize(status) : 'Not run', status ? toneFor(status) : 'outline'),
      reasons.length ? h('span', { class: 'hint' }, reasons.join('; ')) : null,
    );
  }

  function miniTile(label, value, tone) {
    return h('div', { class: `mini${tone ? ` mini-${tone}` : ''}` }, h('div', { class: 'mini-num' }, value), h('div', { class: 'mini-label' }, label));
  }

  function batchCard(b) {
    const gates = b.gates && typeof b.gates === 'object' && !Array.isArray(b.gates) ? b.gates : {};
    const lines = asList(b.founder_report_lines).map((line) => String(line));
    const same = sameSha(b.code_sha, engineState.data && engineState.data.deployed_sha);
    return h(
      'section',
      { class: 'card' },
      cardHead(`Batch ${b.batch_id || '?'}`, [
        `code ${shortSha(b.code_sha)} `,
        same === true ? tag('Same code as UAT', 'ok') : same === false ? tag('Not the code UAT runs', 'warn') : null,
      ]),
      h(
        'div',
        { class: 'pad stack' },
        h('div', { class: 'gate-row' }, Object.keys(GATE_NAMES).map((name) => gateChip(name, gates[name]))),
        h(
          'div',
          { class: 'mini-tiles' },
          miniTile('Ready packets wrong', `${fmtInt(b.ready_wrong)} of ${fmtInt(b.ready_total)}`, num(b.ready_wrong) > 0 ? 'bad' : null),
          miniTile('Not decided yet', fmtInt(b.undecided), num(b.undecided) > 0 ? 'warn' : null),
          miniTile('Checked by you', `${fmtInt(b.human_checked)} of ${fmtInt(b.ready_total)}`, null),
        ),
        lines.length
          ? h('ol', { class: 'report-lines' }, lines.map((line) => h('li', null, line)))
          : h('p', { class: 'hint' }, 'No founder report for this batch.'),
      ),
    );
  }

  function queueItems(value) {
    if (isNum(value)) return { count: value, items: [] };
    const items = asList(value)
      .map((item) => {
        if (typeof item === 'string') return { id: item, title: null, note: '' };
        if (item && typeof item === 'object') {
          return {
            id: typeof item.packet_id === 'string' ? item.packet_id : null,
            key: item.packet_key || null,
            title: item.title || null,
            note: [item.reason, item.severity].filter(Boolean).map(readable).join(' · '),
          };
        }
        return null;
      })
      .filter(Boolean);
    return { count: items.length, items };
  }

  function queueCard(q) {
    return h(
      'section',
      { class: 'card' },
      cardHead('Your queue', 'Packets to check by hand'),
      h(
        'div',
        { class: 'queue-grid' },
        QUEUES.map(([key, title]) => {
          const { count, items } = queueItems(q[key]);
          return h(
            'div',
            { class: 'queue-col' },
            h('h4', { class: 'queue-head' }, title, h('span', { class: 'group-count' }, fmtInt(count))),
            items.length
              ? h(
                  'ul',
                  { class: 'queue-list' },
                  items.map((item) => {
                    const row = item.id ? packetRowById(item.id) : null;
                    const name = item.title || (row && row.title) || item.id || item.key || 'Unknown packet';
                    return h(
                      'li',
                      null,
                      item.id ? h('a', { href: `#/packets/${enc(item.id)}` }, name) : h('span', { class: 'mono' }, name),
                      item.note ? h('span', { class: 'hint' }, ` · ${item.note}`) : null,
                    );
                  }),
                )
              : h('p', { class: 'hint' }, count ? 'Not listed one by one.' : 'Nothing here.'),
          );
        }),
      ),
    );
  }

  function renderEval() {
    const st = evalState;
    const d = st.data;
    const head = sectionHead('Eval', 'The offline eval’s batches on Manish’s Drive, and what is left for you to check.', refreshButton(st.loading, () => showEval(true)));
    if (!d) {
      fill($('view-eval'), head, st.error ? errorBlock(`Couldn't load the eval: ${st.error.message}`, () => showEval(true)) : loadingBlock('Loading…'));
      return;
    }
    const batches = objects(d.batches);
    fill(
      $('view-eval'),
      head,
      st.error ? h('p', { class: 'flag flag-warn' }, `Couldn't refresh: ${st.error.message}`) : null,
      queueCard(d.human_queue && typeof d.human_queue === 'object' ? d.human_queue : {}),
      batches.length ? batches.map(batchCard) : emptyBlock('No eval batches found.'),
    );
  }

  // ---- Start ---------------------------------------------------------------------------------------

  function init() {
    initTheme();
    initAsk();
    loadEngine();
    loadOwner();
    loadPresets();
    window.addEventListener('hashchange', onHashChange);
    route();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
