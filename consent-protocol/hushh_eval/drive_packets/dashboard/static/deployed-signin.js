// Sign-in window for the Deployed UAT tab: Google sign-in to the UAT Firebase project with the
// founder's own test buyer account. The session lives in this window's memory only (in-memory
// persistence); fresh ID tokens go to the dashboard tab over a same-origin BroadcastChannel.

import { initializeApp } from './vendor/firebase/firebase-app.js';
import {
  GoogleAuthProvider,
  browserPopupRedirectResolver,
  inMemoryPersistence,
  initializeAuth,
  onIdTokenChanged,
  signInWithPopup,
  signOut,
} from './vendor/firebase/firebase-auth.js';

const CHANNEL = 'hushh-dash-deployed-v1';
const channel = new BroadcastChannel(CHANNEL);
const $ = (id) => document.getElementById(id);
let auth = null;
let projectId = 'the Firebase project';

function status(text) {
  $('signin-status').textContent = text;
}

function fail(text) {
  const box = $('signin-error');
  box.textContent = text;
  box.hidden = !text;
}

function onLocalhost() {
  return window.location.hostname === 'localhost';
}

function localhostHref() {
  const url = new URL(window.location.href);
  url.hostname = 'localhost';
  return url.href;
}

/** Plain words and the exact fix for a Firebase sign-in error. */
function explain(error) {
  const code = String((error && error.code) || '');
  if (code === 'auth/unauthorized-domain') {
    return onLocalhost()
      ? `Firebase project ${projectId} does not allow sign-in from localhost. Fix: Firebase console → ${projectId} → Authentication → Settings → Authorized domains → Add domain → localhost.`
      : `Firebase allows sign-in from localhost, not ${window.location.hostname}. Open ${localhostHref()} and sign in there.`;
  }
  if (code.startsWith('auth/requests-from-referer-')) {
    return `The browser key of ${projectId} blocks ${window.location.origin}. Fix: Google Cloud console → ${projectId} → APIs & Services → Credentials → the browser key the web app uses → Website restrictions → add ${window.location.origin}/* (the key is shared with production).`;
  }
  const words = {
    'auth/popup-blocked': 'The browser blocked the Google window. Allow pop-ups for this page, then press Continue with Google again.',
    'auth/popup-closed-by-user': 'The Google window closed before sign-in finished. Try again.',
    'auth/cancelled-popup-request': 'Another Google window was already open. Try again.',
    'auth/network-request-failed': 'Couldn’t reach Google. Check the connection and try again.',
    'auth/operation-not-allowed': `Google sign-in is turned off for ${projectId}.`,
    'auth/invalid-api-key': 'The Firebase key in the UAT env profile was refused. Check NEXT_PUBLIC_FIREBASE_API_KEY.',
    'auth/user-disabled': 'This account is disabled.',
    'auth/internal-error': 'Google sign-in failed inside this window. Reload it and try again.',
  };
  return words[code] || `Sign-in failed (${code || 'unknown error'}).`;
}

async function announce(user, force, nonce) {
  if (!user) {
    channel.postMessage({ kind: 'signed-out', nonce: nonce || null });
    return;
  }
  const result = await user.getIdTokenResult(Boolean(force));
  channel.postMessage({
    kind: 'session',
    nonce: nonce || null,
    uid: user.uid,
    email: user.email || null,
    name: user.displayName || null,
    idToken: result.token,
    expiresAt: Date.parse(result.expirationTime) || 0,
  });
}

function render(user) {
  $('signin-google').hidden = Boolean(user);
  $('signin-out').hidden = !user;
  status(user
    ? `Signed in as ${user.email || user.displayName || 'your test account'}. Go back to the dashboard tab.`
    : 'Not signed in.');
}

channel.addEventListener('message', (event) => {
  const message = event.data && typeof event.data === 'object' ? event.data : {};
  if (!auth) return;
  const nonce = typeof message.nonce === 'string' ? message.nonce : null;
  if (message.kind === 'need-token' || message.kind === 'ping') {
    announce(auth.currentUser, message.kind === 'need-token' && message.force === true, nonce)
      .catch(() => channel.postMessage({ kind: 'token-error', nonce }));
  } else if (message.kind === 'sign-out') {
    void signOut(auth);
  }
});

window.addEventListener('pagehide', () => channel.postMessage({ kind: 'window-closed' }));

async function boot() {
  let config = null;
  try {
    const response = await fetch('/api/deployed/config', { cache: 'no-store' });
    config = await response.json();
  } catch (err) {
    status('The dashboard server is not answering.');
    return;
  }
  if (!config || !config.firebase) {
    const problems = Array.isArray(config && config.problems) ? config.problems : [];
    status('Sign-in is not set up.');
    fail(problems.map((item) => `${item.message} ${item.fix}`).join(' ') || 'The UAT sign-in settings were not found.');
    return;
  }
  projectId = config.firebase.projectId;
  if (!onLocalhost()) {
    const note = $('signin-host');
    note.textContent = `Google sign-in for ${projectId} allows localhost. If it fails here, open ${localhostHref()}.`;
    note.hidden = false;
  }
  const app = initializeApp(config.firebase, 'hushh-dash-deployed');
  auth = initializeAuth(app, {
    persistence: inMemoryPersistence,
    popupRedirectResolver: browserPopupRedirectResolver,
  });
  onIdTokenChanged(auth, (user) => {
    render(user);
    announce(user, false, null).catch(() => fail('Couldn’t read the sign-in token. Sign in again.'));
  });
  $('signin-google').disabled = false;
  $('signin-google').addEventListener('click', async () => {
    fail('');
    status('Waiting for Google…');
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      render(auth.currentUser);
      fail(explain(error));
    }
  });
  $('signin-out').addEventListener('click', () => {
    void signOut(auth);
  });
  render(null);
}

void boot();
