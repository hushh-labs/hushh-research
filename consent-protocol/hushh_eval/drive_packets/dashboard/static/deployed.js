// Deployed UAT tab for Manish's Drive check: Chris's real request to Manish, sent to the
// deployed UAT backend as the founder's own test buyer account. Loaded by index.html as a
// module, it adds its own tab and view, talks only to this server's /api/deployed routes and
// keeps the sign-in tokens in memory (never in storage, cookies or the address bar). Google
// sign-in runs in a separate small window (/api/deployed/signin) that has its own policy.

const CHANNEL = 'hushh-dash-deployed-v1';
const POLL_MS = 5000;
const TOKEN_WAIT_MS = 6000;
const CONFIRM_TEXT =
  'This sends a real request to Manish in UAT. He gets a notification. Nothing is charged here.';

const API = Object.freeze({
  config: () => call('GET', '/api/deployed/config', 'none'),
  session: () => call('POST', '/api/deployed/session', 'firebase', {}),
  owner: () => call('GET', '/api/deployed/owner', 'none'),
  quote: () => call('GET', '/api/deployed/quote', 'app'),
  recipient: () => call('GET', '/api/deployed/recipient', 'both'),
  sendFiles: (body) => call('POST', '/api/deployed/file-requests', 'both', body),
  status: (requestId) => call('GET', `/api/deployed/requests/${enc(requestId)}`, 'app'),
  packets: (cursor) => call('GET', `/api/deployed/packets${cursor ? `?cursor=${enc(cursor)}` : ''}`, 'app'),
  requestPacket: (packetId, body) =>
    call('POST', `/api/deployed/packets/${enc(packetId)}/requests`, 'both', body),
});

// Tokens: memory only. idToken comes from the sign-in window; appToken from /session.
const auth = { idToken: null, appToken: null, uid: null, email: null, name: null, lastUid: null };

const state = {
  config: null,
  configError: null,
  connecting: false,
  reconnectedAt: 0,
  accountError: null,
  signinOpen: false,
  ownerName: null,
  quote: null,
  quoteError: null,
  recipient: null,
  sending: false,
  formError: null,
  packets: [],
  packetsCursor: null,
  packetsError: null,
  packetsLoading: false,
  packetBusy: null,
  packetResults: new Map(),
  packetErrors: new Map(),
  packetKeys: new Map(),
  notice: null,
  sent: [],
};

let attempt = null; // the file request's retry key: one per unchanged request and quote
let started = false;
const waiting = new Map();
const channel = 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL) : null;

class DeployedError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 0;
  }
}

// ---- Helpers -----------------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const enc = (value) => encodeURIComponent(String(value));

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'class') node.className = value;
    else if (name.startsWith('on') && typeof value === 'function') node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

function button(label, onclick, tone, disabled) {
  return el('button', {
    type: 'button',
    class: `dpl-btn${tone ? ` dpl-btn-${tone}` : ''}`,
    disabled: Boolean(disabled),
    onclick,
  }, label);
}

async function call(method, path, tokens, body) {
  const headers = { Accept: 'application/json' };
  if ((tokens === 'firebase' || tokens === 'both') && auth.idToken) headers.Authorization = `Bearer ${auth.idToken}`;
  if ((tokens === 'app' || tokens === 'both') && auth.appToken) headers['X-Hushh-Consent'] = auth.appToken;
  const init = { method, headers, cache: 'no-store', credentials: 'same-origin', referrerPolicy: 'no-referrer' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch (err) {
    throw new DeployedError('offline', 'The dashboard server is not answering.');
  }
  let data = null;
  try {
    data = await response.json();
  } catch (err) {
    data = null;
  }
  if (!response.ok) {
    const code = data && typeof data.error === 'string' ? data.error : `http_${response.status}`;
    const message = data && typeof data.message === 'string' ? data.message : 'Something went wrong. Try again.';
    throw new DeployedError(code, message, response.status);
  }
  return data;
}

function localDay(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The last n months up to yesterday, like the Request tab: on Oct 16, six months is Apr 16 to Oct 15. */
function setLastMonths(n) {
  const today = new Date();
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const month = today.getMonth() - n;
  const lastDay = new Date(today.getFullYear(), month + 1, 0).getDate();
  const start = new Date(today.getFullYear(), month, Math.min(today.getDate(), lastDay));
  $('dpl-start').value = localDay(start);
  $('dpl-end').value = localDay(end);
  renderForm();
}

function validDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const DAY_YEAR = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function dayRange(start, end) {
  if (!start || !end) return null;
  const first = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  if (start === end) return DAY_YEAR.format(first);
  return first.getUTCFullYear() === last.getUTCFullYear()
    ? `${DAY.format(first)} – ${DAY_YEAR.format(last)}`
    : `${DAY_YEAR.format(first)} – ${DAY_YEAR.format(last)}`;
}

function clock(date) {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function timeZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && /^[A-Za-z0-9_+\-/]{1,64}$/.test(zone) ? zone : null;
  } catch (err) {
    return null;
  }
}

function appLink(requestId, label) {
  if (!state.config || !state.config.app_origin) return null;
  const url = new URL('/one/consent', state.config.app_origin);
  url.searchParams.set('tab', 'pending');
  url.searchParams.set('requestView', 'sent');
  url.searchParams.set('requestId', `document_share_request:${requestId}`);
  return el('a', { class: 'dpl-btn', href: url.href, target: '_blank', rel: 'noopener noreferrer' }, label);
}

// ---- Sign-in window and tokens --------------------------------------------------------------

function openSignin() {
  state.accountError = null;
  const url = new URL('/api/deployed/signin', window.location.href);
  const opened = window.open(url.href, 'hushh-deployed-signin', 'popup=yes,width=460,height=640');
  if (!opened) state.accountError = 'The browser blocked the sign-in window. Allow pop-ups for this page, then try again.';
  else state.signinOpen = true;
  renderAccount();
}

/** A token from the sign-in window; force asks Firebase for a new one, as the app does before sending. */
function freshToken(force) {
  return new Promise((resolve, reject) => {
    if (!channel) {
      reject(new DeployedError('no_channel', 'This browser can’t talk to the sign-in window.'));
      return;
    }
    const nonce = crypto.randomUUID();
    const timer = setTimeout(() => {
      waiting.delete(nonce);
      reject(new DeployedError('signin_closed', 'The sign-in window is closed. Sign in again.'));
    }, TOKEN_WAIT_MS);
    waiting.set(nonce, (ok) => {
      clearTimeout(timer);
      waiting.delete(nonce);
      if (ok) resolve();
      else reject(new DeployedError('signin_failed', 'Couldn’t refresh your sign-in. Sign in again.'));
    });
    channel.postMessage({ kind: 'need-token', force: Boolean(force), nonce });
  });
}

function settle(nonce, ok) {
  if (typeof nonce === 'string' && waiting.has(nonce)) waiting.get(nonce)(ok);
}

function onChannel(event) {
  const message = event.data && typeof event.data === 'object' ? event.data : {};
  if (message.kind === 'session') acceptSession(message);
  else if (message.kind === 'signed-out') {
    settle(message.nonce, false);
    clearSession(null);
  } else if (message.kind === 'token-error') settle(message.nonce, false);
  else if (message.kind === 'window-closed') {
    state.signinOpen = false;
    renderAccount();
  }
}

function acceptSession(message) {
  if (typeof message.idToken !== 'string' || typeof message.uid !== 'string') return;
  const changed = auth.lastUid !== message.uid;
  auth.idToken = message.idToken;
  auth.uid = message.uid;
  auth.lastUid = message.uid;
  auth.email = typeof message.email === 'string' ? message.email : null;
  auth.name = typeof message.name === 'string' ? message.name : null;
  state.signinOpen = true;
  if (changed) {
    auth.appToken = null;
    forgetAccount();
  }
  settle(message.nonce, true);
  if (!auth.appToken && !state.connecting) void connect(true);
  renderAll();
}

function forgetAccount() {
  for (const item of state.sent) clearTimeout(item.timer);
  state.sent = [];
  state.quote = null;
  state.recipient = null;
  state.packets = [];
  state.packetsCursor = null;
  state.packetResults.clear();
  state.packetErrors.clear();
  state.packetKeys.clear();
  state.notice = null;
  attempt = null;
}

/** Signed out: tokens are dropped; sent requests stay on screen but stop being checked. */
function clearSession(message) {
  auth.idToken = null;
  auth.appToken = null;
  auth.uid = null;
  auth.email = null;
  auth.name = null;
  for (const item of state.sent) clearTimeout(item.timer);
  state.quote = null;
  state.recipient = null;
  state.accountError = message;
  renderAll();
}

function signOutEverywhere() {
  if (channel) channel.postMessage({ kind: 'sign-out' });
  clearSession(null);
}

async function connect(initial) {
  state.connecting = true;
  state.accountError = null;
  renderAccount();
  try {
    const session = await API.session();
    auth.appToken = session.appToken;
  } catch (err) {
    auth.appToken = null;
    state.accountError = err.message;
  } finally {
    state.connecting = false;
  }
  renderAll();
  if (auth.appToken && initial) {
    void loadOwner();
    void loadQuote();
    void loadRecipient();
    void loadPackets(true);
    for (const item of state.sent) schedule(item, 0);
  }
}

/** One retry after a 401 (the UAT app session expired), at most once every 30 seconds. */
async function withSession(run) {
  try {
    return await run();
  } catch (err) {
    if (err.status !== 401 || !auth.idToken || Date.now() - state.reconnectedAt < 30000) throw err;
    state.reconnectedAt = Date.now();
    await freshToken(false);
    await connect(false);
    if (!auth.appToken) throw err;
    return run();
  }
}

// ---- Loads -------------------------------------------------------------------------------------

async function loadConfig() {
  try {
    state.config = await API.config();
  } catch (err) {
    state.configError = err.message;
  }
  renderTop();
  renderAccount();
}

async function loadOwner() {
  try {
    const owner = await API.owner();
    state.ownerName = owner.uat_display_name || null;
  } catch (err) {
    state.ownerName = null;
  }
  renderForm();
}

async function loadQuote() {
  state.quote = null;
  state.quoteError = null;
  renderForm();
  try {
    state.quote = await withSession(() => API.quote());
  } catch (err) {
    state.quoteError = err.message;
  }
  renderForm();
}

async function loadRecipient() {
  try {
    const result = await withSession(() => API.recipient());
    state.recipient = { email: result.email, error: null };
  } catch (err) {
    state.recipient = { email: null, error: err.message };
  }
  renderForm();
}

async function loadPackets(fresh) {
  if (!auth.appToken || state.packetsLoading) return;
  state.packetsLoading = true;
  state.packetsError = null;
  if (fresh) {
    state.packets = [];
    state.packetsCursor = null;
  }
  renderPackets();
  try {
    const page = await withSession(() => API.packets(fresh ? null : state.packetsCursor));
    state.packets = fresh ? page.packets : state.packets.concat(page.packets);
    state.packetsCursor = page.nextCursor || null;
  } catch (err) {
    state.packetsError = err.message;
  } finally {
    state.packetsLoading = false;
  }
  renderPackets();
}

// ---- Sending: the only way a real request leaves this page --------------------------------

function askConfirm() {
  return new Promise((resolve) => {
    let answer = false;
    const dialog = el('dialog', { class: 'dpl-dialog', 'aria-labelledby': 'dpl-confirm-title' },
      el('h2', { class: 'dpl-title', id: 'dpl-confirm-title' }, 'Send to deployed UAT?'),
      el('p', { class: 'dpl-confirm-text' }, CONFIRM_TEXT),
      el('div', { class: 'dpl-actions dpl-actions-end' },
        button('Cancel', () => dialog.close()),
        button('Send', () => {
          answer = true;
          dialog.close();
        }, 'primary')));
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(answer);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

/** Asks first, then gets a fresh sign-in token (as the app does), then sends with the confirm flag. */
async function sendToUat(request) {
  if (!(await askConfirm())) return null;
  await freshToken(true);
  const body = { ...request.payload, confirm: true };
  return withSession(() =>
    request.kind === 'packet' ? API.requestPacket(request.packetId, body) : API.sendFiles(body));
}

function readTerms() {
  return {
    purpose: $('dpl-purpose').value.trim(),
    periodStart: $('dpl-start').value || null,
    periodEnd: $('dpl-end').value || null,
  };
}

function termsProblem(terms) {
  if (!terms.purpose) return 'Say what you need.';
  if (terms.purpose.length > 2000) return 'Keep it under 2,000 characters.';
  if (!terms.periodStart || !terms.periodEnd) return 'Choose a start and end date.';
  if (!validDay(terms.periodStart) || !validDay(terms.periodEnd)) return 'Choose real dates.';
  if (terms.periodEnd < terms.periodStart) return 'The end date must be on or after the start date.';
  return null;
}

/** The app's retry rule: an unchanged request and quote reuse their key, so UAT never records it twice. */
function retryKey(terms, quoteVersion) {
  const fingerprint = JSON.stringify(terms);
  if (!attempt || attempt.fingerprint !== fingerprint || attempt.quoteVersion !== quoteVersion) {
    attempt = { fingerprint, quoteVersion, id: crypto.randomUUID() };
  }
  return attempt.id;
}

async function sendFiles() {
  const terms = readTerms();
  if (state.sending || termsProblem(terms) || !state.quote || !auth.appToken) {
    renderForm();
    return;
  }
  state.sending = true;
  state.formError = null;
  renderForm();
  try {
    const result = await sendToUat({
      kind: 'files',
      payload: {
        ...terms,
        clientRequestId: retryKey(terms, state.quote.version),
        expectedQuoteVersion: state.quote.version,
        timeZone: timeZone(),
      },
    });
    if (result) {
      attempt = null;
      addSent({
        requestId: result.requestId,
        title: terms.purpose,
        kind: 'Files',
        line: ['Files', dayRange(terms.periodStart, terms.periodEnd)].filter(Boolean).join(' · '),
      });
      $('dpl-purpose').value = '';
      $('dpl-start').value = '';
      $('dpl-end').value = '';
    }
  } catch (err) {
    state.formError = err.message;
    if (err.code === 'price_changed') void loadQuote();
  } finally {
    state.sending = false;
    renderForm();
  }
}

const revisionOf = (packet) => `${packet.packetId}:${packet.version}:${packet.listingRevision}`;

function packetKey(packet) {
  const revision = revisionOf(packet);
  if (!state.packetKeys.has(revision)) state.packetKeys.set(revision, crypto.randomUUID());
  return state.packetKeys.get(revision);
}

async function requestPacket(packet) {
  if (state.packetBusy) return;
  state.packetBusy = packet.packetId;
  state.packetErrors.delete(packet.packetId);
  state.notice = null;
  renderPackets();
  try {
    const result = await sendToUat({
      kind: 'packet',
      packetId: packet.packetId,
      payload: { version: packet.version, clientRequestId: packetKey(packet) },
    });
    if (result) {
      state.packetResults.set(revisionOf(packet), result);
      if (result.existingAccess) state.notice = 'You already have these files. Nothing was charged.';
      else addSent({ requestId: result.requestId, title: packet.title, kind: 'Packet', line: `Packet · ${packet.documents}` });
    }
  } catch (err) {
    state.packetErrors.set(packet.packetId, err.message);
    if (['packet_changed', 'listing_changed', 'price_changed', 'packet_unavailable', 'packet_not_manish'].includes(err.code)) {
      void loadPackets(true);
    }
  } finally {
    state.packetBusy = null;
    renderPackets();
  }
}

// ---- Following a request ----------------------------------------------------------------------

function addSent(item) {
  const entry = { ...item, view: null, error: null, checkedAt: null, timer: null };
  state.sent.unshift(entry);
  renderSent();
  schedule(entry, 0);
}

function schedule(item, delay) {
  clearTimeout(item.timer);
  if (item.view && item.view.terminal) return;
  item.timer = setTimeout(() => void poll(item), delay);
}

async function poll(item) {
  if (!state.sent.includes(item)) return;
  if (!auth.appToken) {
    item.error = 'Sign in to keep checking.';
    renderSent();
    return;
  }
  if (document.hidden) {
    schedule(item, POLL_MS);
    return;
  }
  try {
    item.view = await withSession(() => API.status(item.requestId));
    item.error = null;
    item.checkedAt = new Date();
  } catch (err) {
    item.error = err.message;
  }
  renderSent();
  schedule(item, POLL_MS);
}

function tone(view) {
  if (!view) return 'wait';
  if (view.payInApp) return 'act';
  if (['completed', 'partial'].includes(view.status)) return 'done';
  if (['declined', 'cancelled', 'expired', 'no_files_shared'].includes(view.status)) return 'stop';
  return 'wait';
}

function setText(node, text) {
  const value = text || '';
  if (node.textContent !== value) node.textContent = value;
  node.hidden = !value;
}

function cardNodes(item) {
  if (item.nodes) return item.nodes;
  const nodes = {
    word: el('p', { class: 'dpl-status-word', 'aria-live': 'polite' }),
    detail: el('p', { class: 'dpl-hint' }),
    payment: el('p', { class: 'dpl-hint' }),
    price: el('p', { class: 'dpl-hint' }),
    error: el('p', { class: 'dpl-error', role: 'alert' }),
    checked: el('p', { class: 'dpl-small' }),
    app: el('span', { class: 'dpl-app-link' }),
  };
  nodes.root = el('article', { class: 'dpl-card dpl-status' },
    el('div', { class: 'dpl-head' },
      el('h3', { class: 'dpl-status-title' }, item.title),
      el('span', { class: 'dpl-tag' }, item.kind)),
    el('p', { class: 'dpl-hint' }, item.line),
    nodes.word, nodes.detail, nodes.payment, nodes.price, nodes.error, nodes.checked,
    el('div', { class: 'dpl-actions' },
      el('a', { class: 'dpl-btn dpl-btn-primary', href: `#/real/${enc(item.requestId)}` }, 'See what the backend did'),
      nodes.app),
    el('p', { class: 'dpl-id' }, `Request ${item.requestId}`));
  item.nodes = nodes;
  return nodes;
}

function updateCard(item) {
  const nodes = cardNodes(item);
  const view = item.view;
  nodes.root.className = `dpl-card dpl-status dpl-tone-${tone(view)}`;
  setText(nodes.word, view ? view.word : 'Sent. Checking UAT…');
  setText(nodes.detail, view && view.detail);
  setText(nodes.payment, view && view.payment);
  setText(nodes.price, view && view.price ? `Price: ${view.price}` : '');
  setText(nodes.error, item.error);
  setText(nodes.checked, item.checkedAt
    ? `Checked ${clock(item.checkedAt)}${view && view.terminal ? ' · final' : ' · every 5 seconds'}`
    : 'Checking every 5 seconds');
  const label = view && view.payInApp ? 'Pay in the UAT app' : 'Open in the UAT app';
  if (nodes.app.dataset.label !== label) {
    const link = appLink(item.requestId, label);
    nodes.app.replaceChildren(...(link ? [link] : []));
    nodes.app.dataset.label = label;
  }
  return nodes.root;
}

// ---- Rendering ---------------------------------------------------------------------------------

function renderTop() {
  const host = state.config && state.config.api_host ? state.config.api_host : 'api.uat.hushh.ai';
  $('dpl-banner').textContent = `Using the deployed UAT backend (${host})`;
  const problems = state.config && Array.isArray(state.config.problems) ? state.config.problems : [];
  $('dpl-problems').replaceChildren(
    ...(state.configError ? [el('p', { class: 'dpl-error', role: 'alert' }, state.configError)] : []),
    ...problems.map((item) => el('div', { class: 'dpl-flag dpl-flag-warn' },
      el('p', { class: 'dpl-flag-title' }, item.message),
      el('p', { class: 'dpl-flag-fix' }, item.fix))));
}

function sessionLine() {
  if (state.connecting) return 'Connecting to UAT…';
  if (auth.appToken) return 'Connected to UAT.';
  return 'Not connected to UAT yet.';
}

function renderAccount() {
  const parts = [el('h2', { class: 'dpl-title' }, 'Buyer account')];
  if (window.location.hostname !== 'localhost') {
    const url = new URL(window.location.href);
    url.hostname = 'localhost';
    parts.push(el('p', { class: 'dpl-flag dpl-flag-warn' },
      'Google sign-in works on localhost. ', el('a', { href: url.href }, 'Open this page on localhost')));
  }
  if (auth.idToken) {
    parts.push(
      el('p', { class: 'dpl-line' }, 'Signed in as ', el('strong', {}, auth.email || auth.name || 'your test account')),
      el('p', { class: 'dpl-hint' }, sessionLine()),
      el('div', { class: 'dpl-actions' },
        button('Sign out', signOutEverywhere),
        state.signinOpen ? null : button('Open sign-in window', openSignin, 'quiet')));
  } else {
    parts.push(
      el('p', { class: 'dpl-hint' }, 'Sign in as your test buyer account. A small window opens. Keep it open while you test.'),
      el('div', { class: 'dpl-actions' },
        button('Sign in with Google', openSignin, 'primary', !(state.config && state.config.firebase))));
  }
  if (state.accountError) parts.push(el('p', { class: 'dpl-error', role: 'alert' }, state.accountError));
  $('dpl-account').replaceChildren(...parts);
}

function renderForm() {
  const ready = Boolean(auth.appToken);
  const terms = readTerms();
  const problem = termsProblem(terms);
  $('dpl-to').textContent = state.ownerName ? `To Manish (${state.ownerName} in UAT)` : 'To Manish';
  let quoteLine = '';
  if (!ready) quoteLine = 'Sign in to see the price.';
  else if (state.quoteError) quoteLine = state.quoteError;
  else if (!state.quote) quoteLine = 'Checking price…';
  else quoteLine = [state.quote.line, state.quote.note].filter(Boolean).join(' ');
  $('dpl-quote').textContent = quoteLine;
  const recipient = state.recipient;
  $('dpl-recipient').textContent = !ready || !recipient
    ? ''
    : recipient.email ? `Files will be shared with ${recipient.email}` : recipient.error;
  const hint = $('dpl-form-hint');
  const showHint = Boolean(problem) && (terms.purpose || terms.periodStart || terms.periodEnd);
  hint.textContent = showHint ? problem : '';
  hint.hidden = !showHint;
  const error = $('dpl-form-error');
  error.textContent = state.formError || '';
  error.hidden = !state.formError;
  const send = $('dpl-send');
  send.disabled = !ready || Boolean(problem) || !state.quote || state.sending;
  send.textContent = state.sending ? 'Sending…' : 'Send to deployed UAT';
}

function packetRow(packet) {
  const result = state.packetResults.get(revisionOf(packet));
  const line = result
    ? (result.existingAccess ? 'You have these files' : 'Requested · Waiting for Manish')
    : packet.line;
  let action = null;
  if (result) action = el('a', { class: 'dpl-btn', href: `#/real/${enc(result.requestId)}` }, 'See what the backend did');
  else if (packet.canRequest) {
    action = button(state.packetBusy === packet.packetId ? 'Sending…' : 'Request this packet',
      () => void requestPacket(packet), 'primary', Boolean(state.packetBusy));
  }
  const failure = state.packetErrors.get(packet.packetId);
  return el('li', { class: 'dpl-row-item' },
    el('div', { class: 'dpl-row-main' },
      el('p', { class: 'dpl-row-title' }, packet.title),
      el('p', { class: 'dpl-row-line' }, line),
      ...packet.notes.map((note) => el('p', { class: 'dpl-row-line' }, note)),
      failure ? el('p', { class: 'dpl-error', role: 'alert' }, failure) : null),
    el('div', { class: 'dpl-row-side' },
      packet.price && !result ? el('span', { class: 'dpl-price' }, packet.price) : null,
      action));
}

function renderPackets() {
  const parts = [
    el('div', { class: 'dpl-head' },
      el('h2', { class: 'dpl-title' }, 'Manish’s packets'),
      auth.appToken ? button('Refresh', () => void loadPackets(true), 'quiet', state.packetsLoading) : null),
    el('p', { class: 'dpl-hint' }, 'What Manish listed for you, as his profile shows it. Requesting one sends him a real request. You pay later, in the app, after he approves.'),
  ];
  if (state.notice) parts.push(el('p', { class: 'dpl-flag dpl-flag-ok', role: 'status' }, state.notice));
  if (!auth.appToken) parts.push(el('p', { class: 'dpl-muted' }, 'Sign in to see them.'));
  else if (state.packetsError) {
    parts.push(el('p', { class: 'dpl-error', role: 'alert' }, state.packetsError),
      el('div', { class: 'dpl-actions' }, button('Try again', () => void loadPackets(true))));
  } else if (state.packetsLoading && !state.packets.length) parts.push(el('p', { class: 'dpl-muted' }, 'Loading…'));
  else if (!state.packets.length) parts.push(el('p', { class: 'dpl-muted' }, 'Manish has no packets listed for you right now.'));
  else parts.push(el('ul', { class: 'dpl-rows' }, state.packets.map(packetRow)));
  if (auth.appToken && state.packetsCursor && !state.packetsError) {
    parts.push(el('div', { class: 'dpl-actions' }, button('Show more', () => void loadPackets(false), 'quiet', state.packetsLoading)));
  }
  $('dpl-packets').replaceChildren(...parts);
}

function renderSent() {
  const box = $('dpl-sent');
  box.hidden = !state.sent.length;
  if (!state.sent.length) {
    box.replaceChildren();
    return;
  }
  const title = box.querySelector('.dpl-section-title') || el('h2', { class: 'dpl-section-title' }, 'Sent from this page');
  const wanted = [title, ...state.sent.map(updateCard)];
  const current = Array.from(box.children);
  if (current.length !== wanted.length || current.some((node, index) => node !== wanted[index])) {
    box.replaceChildren(...wanted);
  }
}

function renderAll() {
  renderAccount();
  renderForm();
  renderSent();
  renderPackets();
}

function buildForm() {
  const form = el('form', { class: 'dpl-card', id: 'dpl-form', autocomplete: 'off', novalidate: true },
    el('div', { class: 'dpl-head' },
      el('h2', { class: 'dpl-title' }, 'Request files'),
      el('span', { class: 'dpl-tag' }, 'Real request')),
    el('p', { class: 'dpl-hint', id: 'dpl-to' }, 'To Manish'),
    el('label', { class: 'dpl-label', for: 'dpl-purpose' }, 'What do you need?'),
    el('textarea', { id: 'dpl-purpose', rows: '2', maxlength: '2000', placeholder: 'I need six months of financial statements' }),
    el('div', { class: 'dpl-row' },
      el('label', { class: 'dpl-date' }, el('span', {}, 'Start date'), el('input', { type: 'date', id: 'dpl-start' })),
      el('label', { class: 'dpl-date' }, el('span', {}, 'End date'), el('input', { type: 'date', id: 'dpl-end' })),
      el('div', { class: 'dpl-chips' },
        el('button', { type: 'button', class: 'dpl-chip', onclick: () => setLastMonths(6) }, 'Last 6 months'),
        el('button', { type: 'button', class: 'dpl-chip', onclick: () => setLastMonths(8) }, 'Last 8 months'))),
    el('p', { class: 'dpl-hint', id: 'dpl-form-hint', role: 'status', hidden: true }),
    el('p', { class: 'dpl-hint', id: 'dpl-quote', 'aria-live': 'polite' }),
    el('p', { class: 'dpl-hint', id: 'dpl-recipient' }),
    el('p', { class: 'dpl-error', id: 'dpl-form-error', role: 'alert', hidden: true }),
    el('div', { class: 'dpl-actions dpl-actions-end' },
      el('button', { type: 'submit', class: 'dpl-btn dpl-btn-primary', id: 'dpl-send', disabled: true }, 'Send to deployed UAT')));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void sendFiles();
  });
  form.addEventListener('input', () => renderForm());
  return form;
}

function buildView() {
  return el('div', { class: 'dpl' },
    el('p', { class: 'dpl-banner', id: 'dpl-banner' }, 'Using the deployed UAT backend'),
    el('p', { class: 'dpl-hint dpl-lead' }, 'You are the buyer here. Requests are real: Manish gets a notification. This page never pays, approves, shares or lists anything.'),
    el('div', { id: 'dpl-problems' }),
    el('section', { class: 'dpl-card', id: 'dpl-account', 'aria-label': 'Buyer account' }),
    buildForm(),
    el('section', { class: 'dpl-sent', id: 'dpl-sent', 'aria-label': 'Sent from this page', hidden: true }),
    el('section', { class: 'dpl-card', id: 'dpl-packets', 'aria-label': 'Manish’s packets' }));
}

// ---- Tab -----------------------------------------------------------------------------------------

function isDeployedHash() {
  return /^#\/?deployed\/?$/.test(window.location.hash);
}

function route(tab, view) {
  const on = isDeployedHash();
  view.hidden = !on;
  if (!on) {
    tab.removeAttribute('aria-current');
    return;
  }
  for (const other of view.parentElement.querySelectorAll(':scope > .view')) {
    if (other !== view) other.hidden = true;
  }
  for (const other of tab.parentElement.querySelectorAll('.tab')) {
    if (other !== tab) other.removeAttribute('aria-current');
  }
  tab.setAttribute('aria-current', 'page');
  document.title = 'Deployed UAT · Manish’s Drive check';
  if (!started) {
    started = true;
    void loadConfig();
    if (channel) channel.postMessage({ kind: 'ping', nonce: null });
  }
}

function mount() {
  const nav = document.querySelector('nav.tabs');
  const main = document.querySelector('main');
  if (!nav || !main || $('tab-deployed')) return;
  const tab = el('a', { class: 'tab', href: '#/deployed', id: 'tab-deployed' }, 'Deployed UAT');
  nav.append(tab);
  const view = el('section', { class: 'view', id: 'view-deployed', 'aria-label': 'Deployed UAT', hidden: true }, buildView());
  main.append(view);
  if (channel) channel.addEventListener('message', onChannel);
  renderAll();
  // Registered after the dashboard's own router, so this runs last on every hash change.
  window.addEventListener('hashchange', () => route(tab, view));
  route(tab, view);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
else mount();
