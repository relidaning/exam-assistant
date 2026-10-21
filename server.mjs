// Exam Assistant server: JSON API + static SPA. No framework; Node >= 20.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as store from './lib/store.mjs';
import { detectFormat, parsePayload, localizeMedia, mediaDirsFor, findInSourceFile } from './lib/importer.mjs';
import { normalizeAll, normalizeQuestion } from './lib/normalize.mjs';
import { toMarkdown } from './lib/tomd.mjs';
import * as oauth from './lib/oauth.mjs';
import crypto from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8710);
const HOST = process.env.HOST || '0.0.0.0';

const STATIC = [
  ['/vendor/katex/', path.join(ROOT, 'node_modules/katex/dist/')],
  ['/vendor/marked/', path.join(ROOT, 'node_modules/marked/lib/')],
  ['/vendor/dompurify/', path.join(ROOT, 'node_modules/dompurify/dist/')],
  ['/media/', null], // resolved at request time (DATA_DIR may be overridden)
  ['/', path.join(ROOT, 'public/')],
];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.opus': 'audio/opus',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.ogv': 'video/ogg',
  '.pdf': 'application/pdf', '.map': 'application/json',
};

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'content-type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}

async function readBody(req, limit = 20 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw store.httpError(413, 'Body too large');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw store.httpError(400, 'Invalid JSON body'); }
}

function serveStatic(req, res, pathname) {
  for (const [prefix, dir0] of STATIC) {
    if (!pathname.startsWith(prefix)) continue;
    const dir = dir0 ?? store.MEDIA_DIR() + path.sep;
    let rel;
    try { rel = decodeURIComponent(pathname.slice(prefix.length)); } catch { return send(res, 400, 'Bad path'); }
    const file = path.resolve(dir, rel || 'index.html');
    if (!file.startsWith(path.resolve(dir))) return send(res, 403, 'Forbidden');
    let stat;
    try { stat = fs.statSync(file); } catch { stat = null; }
    if (!stat || !stat.isFile()) {
      if (prefix === '/' && !path.extname(rel)) return serveFile(req, res, path.join(ROOT, 'public/index.html')); // SPA fallback
      return send(res, 404, 'Not found');
    }
    return serveFile(req, res, file, stat);
  }
  send(res, 404, 'Not found');
}

function serveFile(req, res, file, stat = fs.statSync(file)) {
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': file.includes('node_modules') ? 'max-age=86400' : 'no-cache' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) { // audio/video seeking on mobile Safari needs ranges
    const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (start > end || start >= stat.size) return send(res, 416, 'Range not satisfiable', { 'content-range': `bytes */${stat.size}` });
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'content-length': stat.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function preparseImport(body, courseId) {
  const content = String(body.content ?? '');
  if (!content.trim()) throw store.httpError(400, 'Nothing to import');
  const format = body.format && body.format !== 'auto' ? body.format : detectFormat(content, body.filename);
  const parsed = parsePayload(content, format);
  const warnings = [...parsed.warnings];
  if (courseId) warnings.push(...localizeMedia(parsed.questions, courseId, []));
  const defaults = { chapter: body.chapter || parsed.meta.chapter, tags: body.tags || parsed.meta.tags, source: body.source || parsed.meta.source, type: body.type || parsed.meta.type };
  return { format, parsed, warnings, defaults };
}

// ---------- accounts: a cookie holds the sign-in token ----------
const COOKIE = 'ea_sid';

function cookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) { try { return decodeURIComponent(v.join('=')); } catch { return null; } }
  }
  return null;
}
const cookieToken = (req) => cookie(req, COOKIE);

function setLoginCookie(res, token) {
  // no Secure flag: the app is served over plain http on the LAN
  const maxAge = token ? store.LOGIN_DAYS * 86400 : 0;
  res.setHeader('set-cookie', `${COOKIE}=${token ? encodeURIComponent(token) : ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
}

// wrong passwords per address: 10 in 15 minutes, then a pause
const failures = new Map();
function throttle(req) {
  const f = failures.get(req.socket.remoteAddress);
  if (f && f.n >= 10 && Date.now() - f.since < 15 * 60000) throw store.httpError(429, 'Too many failed sign-ins. Try again in 15 minutes.');
}
function failed(req) {
  const ip = req.socket.remoteAddress;
  const f = failures.get(ip);
  if (!f || Date.now() - f.since > 15 * 60000) failures.set(ip, { n: 1, since: Date.now() });
  else f.n++;
}

const originHost = (origin) => { try { return new URL(origin).host; } catch { return null; } };

const signIn = (res, user) => { setLoginCookie(res, store.createLogin(user.id)); return { user }; };

function redirect(res, location, headers = {}) {
  res.writeHead(302, { location, 'cache-control': 'no-store', ...headers });
  res.end();
}

// ---------- Google / GitHub: start → provider → callback ----------
// The state (with where to go afterwards, and whether this links to the signed-in account) rides in a short-lived
// cookie on this address; the callback must bring the same state back.
const OAUTH_COOKIE = 'ea_oauth';
const safeNext = (n) => (/^\/[^\s\\]*$/.test(String(n || '')) && !String(n).startsWith('//') ? String(n) : '/');
const baseUrl = (req, provider) => oauth.config()[provider]?.publicUrl || `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}`;
const callbackUrl = (req, provider) => `${baseUrl(req, provider)}/api/auth/oauth/${provider}/callback`;
const loginError = (res, msg) => redirect(res, `/#/login?error=${encodeURIComponent(msg)}`, { 'set-cookie': `${OAUTH_COOKIE}=; Path=/api/auth/oauth; HttpOnly; SameSite=Lax; Max-Age=0` });

function oauthStart(req, res, user, provider) {
  const url = new URL(req.url, 'http://x');
  if (!oauth.config()[provider]) return loginError(res, 'That sign-in method is not set up');
  // the providers only know one address: go there first, so the cookies live where the callback lands
  const pub = oauth.config()[provider].publicUrl;
  if (pub && new URL(pub).host !== req.headers.host) return redirect(res, `${pub}${url.pathname}${url.search}`);
  const link = url.searchParams.get('link') === '1';
  const next = safeNext(url.searchParams.get('next'));
  if (link && !user) return loginError(res, 'Sign in first, then link the account');
  const state = crypto.randomBytes(24).toString('base64url');
  const data = Buffer.from(JSON.stringify({ state, provider, next, link })).toString('base64url');
  redirect(res, oauth.authorizeUrl(provider, { redirectUri: callbackUrl(req, provider), state }), {
    'set-cookie': `${OAUTH_COOKIE}=${data}; Path=/api/auth/oauth; HttpOnly; SameSite=Lax; Max-Age=600`,
  });
}

async function oauthCallback(req, res, user, provider) {
  const q = new URL(req.url, 'http://x').searchParams;
  let saved = null;
  try { saved = JSON.parse(Buffer.from(cookie(req, OAUTH_COOKIE) || '', 'base64url').toString()); } catch { /* none */ }
  const clear = `${OAUTH_COOKIE}=; Path=/api/auth/oauth; HttpOnly; SameSite=Lax; Max-Age=0`;
  const fail = (msg) => (saved?.link ? redirect(res, `/#/account?error=${encodeURIComponent(msg)}`, { 'set-cookie': clear }) : loginError(res, msg));
  const label = oauth.PROVIDERS[provider]?.label || provider;
  if (!saved || saved.provider !== provider || !q.get('state') || q.get('state') !== saved.state) return fail('The sign-in expired or came from somewhere else. Try again');
  if (q.get('error')) return fail(q.get('error') === 'access_denied' ? `${label} sign-in was cancelled` : `${label}: ${q.get('error_description') || q.get('error')}`);
  if (!oauth.config()[provider]) return fail('That sign-in method is not set up');
  let profile;
  try { profile = await oauth.fetchProfile(provider, { code: q.get('code') || '', redirectUri: callbackUrl(req, provider) }); } catch (e) { return fail(e.message); }
  if (saved.link) {
    if (!user) return loginError(res, 'Sign in first, then link the account');
    try { store.linkIdentity(user.id, provider, profile); } catch (e) { return fail(e.message); }
    return redirect(res, `/#/account?linked=${provider}`, { 'set-cookie': clear });
  }
  const who = store.userForIdentity(provider, profile.subject) || store.createIdentityUser(provider, profile);
  store.linkIdentity(who.id, provider, profile); // refresh the stored email/login
  redirect(res, `/#${saved.next}`, { 'set-cookie': [clear, `${COOKIE}=${encodeURIComponent(store.createLogin(who.id))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${store.LOGIN_DAYS * 86400}`] });
}

const authRoutes = [
  ['GET', /^\/api\/auth\/me$/, (req, res, user) => ({
    user, firstUser: !user && store.userCount() === 0, providers: oauth.enabledProviders(req.headers.host),
    ...(user ? { identities: store.identitiesOf(user.id) } : {}),
  })],
  ['GET', /^\/api\/auth\/oauth\/(google|github)\/start$/, (req, res, user) => oauthStart(req, res, user, /\/oauth\/(\w+)\//.exec(req.url)[1])],
  ['GET', /^\/api\/auth\/oauth\/(google|github)\/callback$/, (req, res, user) => oauthCallback(req, res, user, /\/oauth\/(\w+)\//.exec(req.url)[1])],
  ['DELETE', /^\/api\/auth\/identities\/(google|github)$/, (req, res, user) => {
    if (!user) throw store.httpError(401, 'Sign in first');
    store.unlinkIdentity(user.id, req.url.split('/').pop().split('?')[0]);
    return { ok: true, identities: store.identitiesOf(user.id) };
  }],
  ['POST', /^\/api\/auth\/register$/, async (req, res) => {
    const body = await readBody(req);
    return signIn(res, store.createUser({ username: body.username, password: body.password }));
  }],
  ['POST', /^\/api\/auth\/login$/, async (req, res) => {
    throttle(req);
    const body = await readBody(req);
    const user = store.verifyUser(body.username, body.password);
    if (!user) { failed(req); throw store.httpError(401, 'Wrong username or password'); }
    return signIn(res, user);
  }],
  ['POST', /^\/api\/auth\/logout$/, (req, res) => { store.deleteLogin(cookieToken(req)); setLoginCookie(res, null); return { ok: true }; }],
  ['POST', /^\/api\/auth\/password$/, async (req, res, user) => {
    if (!user) throw store.httpError(401, 'Sign in first');
    const body = await readBody(req);
    store.changePassword(user.id, body.current, body.password);
    return { ok: true };
  }],
];

// ---------- course permissions ----------
const view = (id, user) => store.courseAccess(id, user);
function edit(id, user) {
  const a = store.courseAccess(id, user);
  if (!a.canEdit) throw store.httpError(403, 'Only the owner can change this course. Fork it to make your own copy.');
  return a;
}
function manage(id, user) {
  const a = store.courseAccess(id, user);
  if (!a.canManage) throw store.httpError(403, 'Only the owner can do this');
  return a;
}

function courseOut(id, user) {
  const a = view(id, user);
  return { ...store.getCourse(id), access: { isOwner: a.isOwner, canEdit: a.canEdit, canManage: a.canManage } };
}

const routes = [
  ['GET', /^\/api\/courses$/, (req, user) => store.listCourses(user.id)],
  ['POST', /^\/api\/courses$/, async (req, user) => store.createCourse({ ...(await readBody(req)), id: undefined, ownerId: user.id })],
  ['GET', /^\/api\/courses\/([^/]+)$/, (req, user, [id]) => {
    const course = courseOut(id, user);
    const progress = store.getProgress(id, user.id);
    return {
      course, progress, stats: store.courseStats(course, progress), masteryStreak: store.MASTERY_STREAK, sessions: store.getSessions(id, user.id),
      ...(course.access.canManage ? { learners: store.learnerCount(id, user.id) } : {}),
    };
  }],
  // unfinished rounds, shared by every browser and device of the user
  ['GET', /^\/api\/sessions$/, (req, user) => store.listSessions(user.id)],
  ['GET', /^\/api\/courses\/([^/]+)\/sessions$/, (req, user, [id]) => { view(id, user); return store.getSessions(id, user.id); }],
  ['PUT', /^\/api\/courses\/([^/]+)\/sessions\/([^/]+)$/, async (req, user, [id, slot]) => { view(id, user); return store.saveSession(id, user.id, slot, await readBody(req)); }],
  ['DELETE', /^\/api\/courses\/([^/]+)\/sessions\/([^/]+)$/, (req, user, [id, slot]) => { view(id, user); store.deleteSession(id, user.id, slot); return { ok: true }; }],
  ['DELETE', /^\/api\/courses\/([^/]+)\/sessions$/, (req, user, [id]) => { view(id, user); store.deleteSession(id, user.id); return { ok: true }; }],
  ['PATCH', /^\/api\/courses\/([^/]+)$/, async (req, user, [id]) => {
    const patch = await readBody(req);
    const a = view(id, user);
    if (['name', 'description', 'examDate'].some((k) => patch[k] !== undefined)) edit(id, user);
    // publishing and unpublishing are the admin's: their own courses up or down, anyone's public course down
    if (patch.visibility !== undefined && !(user.isAdmin && (patch.visibility === 'public' ? a.isOwner : a.canManage))) throw store.httpError(403, 'Only an admin can publish or unpublish courses');
    return store.updateCourse(id, patch);
  }],
  ['DELETE', /^\/api\/courses\/([^/]+)$/, (req, user, [id]) => { manage(id, user); store.deleteCourse(id); return { ok: true }; }],
  ['POST', /^\/api\/courses\/([^/]+)\/fork$/, async (req, user, [id]) => { view(id, user); return store.forkCourse(id, user, await readBody(req)); }],
  ['GET', /^\/api\/courses\/([^/]+)\/export$/, (req, user, [id]) => { view(id, user); return store.getCourse(id); }],
  ['GET', /^\/api\/courses\/([^/]+)\/activity$/, (req, user, [id]) => {
    view(id, user);
    const q = new URL(req.url, 'http://x').searchParams;
    return store.getActivity(id, user.id, { days: Number(q.get('days')) || 30, tzMinutes: Number(q.get('tz')) || 0 });
  }],
  ['POST', /^\/api\/import\/preview$/, async (req) => {
    const body = await readBody(req);
    const { format, parsed, warnings, defaults } = preparseImport(body, null);
    const { questions, errors } = normalizeAll(parsed.questions, defaults);
    return { format, meta: parsed.meta, questions, errors, warnings };
  }],
  ['POST', /^\/api\/courses\/([^/]+)\/import$/, async (req, user, [id]) => {
    edit(id, user);
    const body = await readBody(req);
    const { format, parsed, warnings, defaults } = preparseImport(body, id);
    const result = store.importQuestions(id, parsed.questions, {
      mode: body.mode, defaults, source: { kind: body.sourceKind || 'paste', name: body.filename || body.source || format },
    });
    return { ...result, warnings };
  }],
  // where a question came from: its stored source text (or one rebuilt from the question) and, if its note
  // still exists, the note's current version of it
  ['GET', /^\/api\/courses\/([^/]+)\/questions\/([^/]+)\/source$/, (req, user, [id, qid]) => {
    edit(id, user);
    const src = store.getQuestionSource(id, qid);
    const fromFile = src.file ? findInSourceFile(src.file, src.question.stem, src.line) : null;
    return {
      question: src.question, raw: src.raw || toMarkdown(src.question), generated: !src.raw,
      file: src.file, fileName: src.file ? path.basename(src.file) : null, line: src.line,
      fileExists: src.file ? fs.existsSync(src.file) : false, fromFile,
    };
  }],
  // re-parse edited source text: preview (save: false) or replace the question (save: true), keeping its progress
  ['POST', /^\/api\/courses\/([^/]+)\/questions\/([^/]+)\/reparse$/, async (req, user, [id, qid]) => {
    edit(id, user);
    const body = await readBody(req);
    const old = store.getQuestionSource(id, qid);
    const content = String(body.content ?? '');
    if (!content.trim()) throw store.httpError(400, 'The source text is empty');
    const parsed = parsePayload(content, detectFormat(content));
    const raw = parsed.questions[0];
    if (!raw) throw store.httpError(400, 'No question found in the text');
    const warnings = parsed.questions.length > 1 ? [`Found ${parsed.questions.length} questions; only the first is used`] : [];
    // resolve images for the preview too (copies are content-addressed, so this is idempotent)
    warnings.push(...localizeMedia([raw], id, mediaDirsFor(old.file)));
    const defaults = { type: body.type || undefined, chapter: old.question.chapter, tags: old.question.tags, source: old.question.source };
    let q;
    try { q = normalizeQuestion(raw, defaults); } catch (e) {
      if (body.save) throw store.httpError(400, e.message);
      return { error: e.message, warnings };
    }
    if (old.question.difficulty && !q.difficulty) q.difficulty = old.question.difficulty;
    if (!body.save) return { question: q, warnings };
    const saved = store.replaceQuestion(id, qid, q, { raw: content, line: body.line ?? null });
    return { question: saved, oldId: qid, warnings };
  }],
  ['DELETE', /^\/api\/courses\/([^/]+)\/questions\/([^/]+)$/, (req, user, [id, qid]) => { edit(id, user); store.deleteQuestion(id, qid); return { ok: true }; }],
  // progress: anyone who can see the course, each into their own records
  ['POST', /^\/api\/courses\/([^/]+)\/attempt$/, async (req, user, [id]) => { view(id, user); return store.recordAttempt(id, user.id, await readBody(req)); }],
  ['POST', /^\/api\/courses\/([^/]+)\/flag$/, async (req, user, [id]) => { view(id, user); return store.setFlags(id, user.id, await readBody(req)); }],
  ['POST', /^\/api\/courses\/([^/]+)\/exam$/, async (req, user, [id]) => { view(id, user); return store.recordExam(id, user.id, await readBody(req)); }],
  ['GET', /^\/api\/courses\/([^/]+)\/exams\/(\d+)$/, (req, user, [id, eid]) => { view(id, user); return store.examDetail(id, user.id, eid); }],
  ['PUT', /^\/api\/courses\/([^/]+)\/settings$/, async (req, user, [id]) => { view(id, user); return store.setSettings(id, user.id, await readBody(req)); }],
  ['POST', /^\/api\/courses\/([^/]+)\/reset-progress$/, (req, user, [id]) => { view(id, user); store.resetProgress(id, user.id); return { ok: true }; }],
];

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const pathname = url.pathname;
    try {
      if (pathname.startsWith('/api/')) {
        // writes only from this app's own pages (the cookie is SameSite=Lax, but other ports of this host count as same-site)
        if (req.method !== 'GET' && req.headers.origin && originHost(req.headers.origin) !== req.headers.host) return send(res, 403, { error: 'Cross-origin request refused' });
        const user = store.userForToken(cookieToken(req));
        for (const [method, re, handler] of authRoutes) {
          if (method === req.method && re.test(pathname)) {
            const out = await handler(req, res, user);
            return res.headersSent ? undefined : send(res, 200, out); // redirects answer by themselves
          }
        }
        if (!user) return send(res, 401, { error: 'Sign in first' });
        for (const [method, re, handler] of routes) {
          const m = re.exec(pathname);
          if (m && method === req.method) {
            const out = await handler(req, user, m.slice(1).map(decodeURIComponent));
            return send(res, 200, out);
          }
        }
        return send(res, 404, { error: 'No such endpoint' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      // question images and media: signed-in users only (file names are content hashes, so they can't be guessed)
      if (pathname.startsWith('/media/') && !store.userForToken(cookieToken(req))) return send(res, 401, 'Sign in first');
      serveStatic(req, res, pathname);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      send(res, status, { error: e.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  store.conn(); // open (and migrate) before the first request
  createServer().listen(PORT, HOST, () => {
    console.log(`Exam Assistant on http://localhost:${PORT}`);
    for (const ifs of Object.values(os.networkInterfaces())) {
      for (const a of ifs || []) if (a.family === 'IPv4' && !a.internal) console.log(`  on your network: http://${a.address}:${PORT}`);
    }
    console.log(`  data: ${store.DB_FILE()}`);
  });
}
