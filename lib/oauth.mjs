// Sign in with Google / GitHub (OAuth 2.0 authorization-code flow, server side).
// A provider is offered once its client id and secret are configured, either as environment variables
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, EXAM_PUBLIC_URL
//   (and GOOGLE_PUBLIC_URL / GITHUB_PUBLIC_URL for one provider only)
// or in data/oauth.json (read on every use, so edits need no restart):
//   { "publicUrl": "http://192.168.1.7:8710",
//     "google": { "clientId": "…", "clientSecret": "…", "publicUrl": "http://localhost:8710" },
//     "github": { "clientId": "…", "clientSecret": "…" } }
// publicUrl is the address registered with the provider (a provider's own one wins); the callback is
// <publicUrl>/api/auth/oauth/<provider>/callback. Without one, the address the page was opened at is used.
// Google accepts only localhost or a real domain there, not a LAN IP; GitHub accepts a LAN IP.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.mjs';

/** Endpoints per provider (exported so tests can point them at a local fake). */
export const PROVIDERS = {
  google: {
    label: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    profile: (u) => ({ subject: u.sub, email: u.email_verified === false ? null : u.email ?? null, login: null, name: u.name ?? null }),
  },
  github: {
    label: 'GitHub',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userUrl: 'https://api.github.com/user',
    scope: 'read:user',
    profile: (u) => ({ subject: u.id, email: u.email ?? null, login: u.login ?? null, name: u.name ?? null }),
  },
};

function fileConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'oauth.json'), 'utf8')); } catch { return {}; }
}

/** { publicUrl, google: {clientId, clientSecret, publicUrl}?, github: {…}? } from the environment and data/oauth.json. */
export function config() {
  const file = fileConfig();
  const out = { publicUrl: (process.env.EXAM_PUBLIC_URL || file.publicUrl || '').replace(/\/+$/, '') };
  for (const p of Object.keys(PROVIDERS)) {
    const env = p.toUpperCase();
    const clientId = process.env[`${env}_CLIENT_ID`] || file[p]?.clientId;
    const clientSecret = process.env[`${env}_CLIENT_SECRET`] || file[p]?.clientSecret;
    const publicUrl = (process.env[`${env}_PUBLIC_URL`] || file[p]?.publicUrl || out.publicUrl).replace(/\/+$/, '');
    if (clientId && clientSecret) out[p] = { clientId, clientSecret, publicUrl };
  }
  return out;
}

/** The configured providers: [{ id, label }]. */
export function enabledProviders() {
  const c = config();
  return Object.keys(PROVIDERS).filter((p) => c[p]).map((id) => ({ id, label: PROVIDERS[id].label }));
}

export function authorizeUrl(provider, { redirectUri, state }) {
  const p = PROVIDERS[provider];
  const { clientId } = config()[provider];
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: p.scope, state });
  if (provider === 'google') q.set('prompt', 'select_account');
  if (provider === 'github') q.set('allow_signup', 'true');
  return `${p.authorizeUrl}?${q}`;
}

/** Trade the callback's code for the user's profile: { subject, email, login, name }. */
export async function fetchProfile(provider, { code, redirectUri }) {
  const p = PROVIDERS[provider];
  const { clientId, clientSecret } = config()[provider];
  const tokenRes = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
    signal: AbortSignal.timeout(15000),
  });
  const token = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !token.access_token) throw new Error(`${p.label} refused the sign-in: ${token.error_description || token.error || tokenRes.status}`);
  const userRes = await fetch(p.userUrl, {
    headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/json', 'user-agent': 'exam-assistant' },
    signal: AbortSignal.timeout(15000),
  });
  if (!userRes.ok) throw new Error(`Could not read your ${p.label} profile (${userRes.status})`);
  const profile = p.profile(await userRes.json());
  if (profile.subject == null || profile.subject === '') throw new Error(`${p.label} sent no user id`);
  return { ...profile, subject: String(profile.subject) };
}
