// Small DOM + API helpers shared by all views.
import { escapeHtml } from './render.js';
import { tabOf } from './nav.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = escapeHtml;

/** The signed-in user ({ id, username, isAdmin }), null when signed out, undefined until asked. */
export const auth = { user: undefined, firstUser: false };

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/auth/')) { // signed out elsewhere (or the sign-in expired)
    auth.user = null;
    if (!location.hash.startsWith('#/login')) location.hash = `#/login?next=${encodeURIComponent(location.hash.slice(1) || '/')}`;
  }
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

const TOAST_ICONS = { info: 'i', ok: '✓', warn: '!', error: '✕' };

/** A short notice in the middle of the screen. Taps go through it; it goes away by itself. */
export function toast(msg, kind = 'info', ms = 2600) {
  let host = $('#toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    host.setAttribute('aria-live', 'polite');
    if ('popover' in host) host.popover = 'manual'; // the top layer: shows above an open dialog too
    document.body.append(host);
  }
  // the same message already showing: keep that one up a little longer instead of stacking another
  const same = [...host.children].find((x) => x.dataset.msg === msg && !x.classList.contains('out'));
  if (same) { clearTimeout(same._timer); same._timer = setTimeout(() => dismiss(same), ms); return; }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.dataset.msg = msg;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.innerHTML = `<span class="toast-ico" aria-hidden="true">${TOAST_ICONS[kind] || TOAST_ICONS.info}</span><span class="toast-msg">${esc(msg)}</span>`;
  host.append(el);
  if (host.popover) { if (host.matches(':popover-open')) host.hidePopover(); host.showPopover(); } // re-shown so it lands above a dialog opened since
  el._timer = setTimeout(() => dismiss(el), ms);
}

function dismiss(el) {
  el.classList.add('out');
  setTimeout(() => {
    const host = el.parentElement;
    el.remove();
    if (host?.popover && !host.children.length && host.matches(':popover-open')) host.hidePopover();
  }, 250);
}

/**
 * Modal dialog; resolves with the value of the clicked button (or null on dismiss).
 * withForm: resolve with { value, form } where form holds the dialog's input values.
 */
export function dialog({ title, body = '', buttons = [{ label: 'OK', value: true, primary: true }], withForm = false }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'dialog';
    d.innerHTML = `<form method="dialog"><h3>${esc(title)}</h3><div class="dialog-body">${body}</div>
      <div class="dialog-actions">${buttons.map((b, i) => `<button class="btn ${b.primary ? 'primary' : b.danger ? 'danger' : 'ghost'}" value="${i}" ${b.primary || b.danger ? '' : 'formnovalidate'}>${esc(b.label)}</button>`).join('')}</div></form>`;
    document.body.append(d);
    d.addEventListener('close', () => {
      const i = d.returnValue;
      const form = Object.fromEntries(new FormData(d.querySelector('form')));
      d.remove();
      // the dialog's own buttons are numbered; a button in the body may close it with a value of its own
      const value = i === '' || i == null || i === 'cancel' ? null : /^\d+$/.test(i) ? buttons[Number(i)]?.value ?? null : i;
      resolve(withForm ? { value, form } : value);
    });
    d.showModal();
  });
}

export const confirmDialog = (title, body, label = 'Confirm', danger = false) =>
  dialog({ title, body: `<p>${esc(body)}</p>`, buttons: [{ label: 'Cancel', value: null }, { label, value: true, primary: !danger, danger }] });

export function pct(n, d) {
  return d ? Math.round((n / d) * 100) : 0;
}

export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function relTime(iso) {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

export function daysUntil(dateStr) {
  if (!dateStr) return null;
  const t = new Date(dateStr + 'T00:00:00');
  if (Number.isNaN(t.getTime())) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((t - today) / 86400000);
}

export const storage = {
  get(k, fallback = null) { try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------- appearance settings (theme, text size) + shared top bar ----------
export const settings = { theme: storage.get('exam.settings', {})?.theme || 'auto' };

export function applySettings() {
  if (settings.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
  storage.set('exam.settings', settings);
}

export function themeIcon() {
  const paths = {
    light: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/>',
    dark: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
    auto: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor"/>',
  };
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">${paths[settings.theme]}</svg>`;
}

// the four main tabs: a bar along the bottom on phones, a sidebar on the left on wide screens
const TAB_ITEMS = [
  ['/', 'Public', '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5a13 13 0 0 1 0 17M12 3.5a13 13 0 0 0 0 17"/>'],
  ['/progress', 'In progress', '<circle cx="12" cy="12" r="8.5"/><path d="M10 8.5v7l5.5-3.5z"/>'],
  ['/courses', 'My courses', '<path d="M5 4.5h10.5a3 3 0 0 1 3 3v12H8a3 3 0 0 1-3-3z"/><path d="M5 16.5a3 3 0 0 1 3-3h10.5M9 8.5h6"/>'],
  ['/settings', 'Settings', '<path d="M4 7h9m4 0h3M4 12h3m4 0h9M4 17h11m4 0h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>'],
];

export function tabbar() {
  const active = tabOf(location.hash);
  return `<nav class="tabbar" aria-label="Main"><a class="brand tab-brand" href="#/"><span class="logo" aria-hidden="true">✎</span><span>Exam Assistant</span></a>${TAB_ITEMS.map(([path, label, ico]) => `<a href="#${path}" class="tab" ${path === active ? 'aria-current="page"' : ''}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ico}</svg><span>${label}</span></a>`).join('')}</nav>`;
}

export function topbar(crumbs = '') {
  return `<header class="topbar has-tabs">
    <a class="brand" href="#/"><span class="logo" aria-hidden="true">✎</span><span>Exam Assistant</span></a>
    <div class="crumbs">${crumbs}</div>
    <div class="topbar-tools">
      <button class="icon-btn" data-setting="theme" title="Theme: ${settings.theme}" aria-label="Toggle theme">${themeIcon()}</button>
      ${auth.user ? `<button class="icon-btn avatar" data-act="account" title="Signed in as ${esc(auth.user.username)}" aria-label="Account: ${esc(auth.user.username)}">${esc([...auth.user.username][0].toUpperCase())}</button>` : ''}
    </div>
  </header>
  ${tabbar()}`; // outside the header: its backdrop blur would pin a fixed bar to the header
}

applySettings();
