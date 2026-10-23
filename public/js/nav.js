// Hierarchical navigation: Back (button, swipe, gesture) always goes to the parent page, never to "whatever came before".
// The browser history stack is kept equal to the current page's ancestor chain, e.g.
//   #/  →  #/c/<id>  →  #/c/<id>/run/<slot>
// Going down pushes one entry; going up or sideways first rewinds history to the common ancestor.
// The four tabs are children of the first one (My courses, "/"); a course page belongs to the tab it was opened from,
// a course's public page (#/p/<id>) to Public (#/public). Messages (#/messages) also belong to the tab they were opened from.

export const TABS = ['/', '/progress', '/public', '/settings'];
let tabHome = (() => { try { const t = sessionStorage.getItem('exam.tab'); return TABS.includes(t) ? t : '/'; } catch { return '/'; } })();

/** The tab a page sits under (course pages: the tab they were opened from). */
export function tabOf(path) {
  const p = cleanPath(path);
  if (p.startsWith('/c/') || p === '/messages' || p.startsWith('/messages/')) return tabHome;
  if (p === '/import') return '/';
  if (/^\/p\/[^/]+$/.test(p)) return '/public';
  return TABS.find((t) => t !== '/' && (p === t || p.startsWith(`${t}/`))) || '/';
}

/** Called when a tab page is shown: course pages opened from here come back to it. */
function noteTab(path) {
  const p = cleanPath(path);
  if (!TABS.includes(p) || p === tabHome) return;
  tabHome = p;
  try { sessionStorage.setItem('exam.tab', p); } catch { /* private mode */ }
}

let render = () => {};
let lastRendered = null;
let queue = Promise.resolve();
let navigating = false;

/** Path without "#", query or in-page anchor: "#/c/x/settings#exam" → "/c/x/settings". */
export function cleanPath(p) {
  let s = String(p).replace(/^#/, '').split('?')[0];
  const anchor = s.indexOf('#');
  if (anchor >= 0) s = s.slice(0, anchor);
  return s.replace(/\/+$/, '') || '/';
}

export function parentOf(path) {
  const p = cleanPath(path);
  if (p === '/') return null;
  let m;
  if ((m = /^\/c\/([^/]+)\/review(?:-missed)?\/(\w+)\/\d+$/.exec(p))) return `/c/${m[1]}/result/${m[2]}`;
  if ((m = /^\/c\/([^/]+)\/.+$/.exec(p))) return `/c/${m[1]}`;
  if (/^\/c\/[^/]+$/.test(p) || p === '/messages') return tabHome;
  if (p.startsWith('/messages/')) return '/messages';
  if (/^\/p\/[^/]+$/.test(p)) return '/public'; // a course's public page belongs to the Public tab
  if (p === '/import') return '/';
  if ((m = /^(\/settings\/c\/[^/]+)\/history$/.exec(p))) return m[1];
  if (p.startsWith('/settings/')) return '/settings';
  return '/';
}

/** Ancestor chain, root first: "/c/x/run/practice" → ["/", "/c/x", "/c/x/run/practice"]. */
export function chain(path) {
  const out = [];
  for (let p = cleanPath(path); p; p = parentOf(p)) out.unshift(p);
  return out;
}

const current = () => location.hash.replace(/^#/, '') || '/';
const href = (p) => `#${p}`;
const popped = () => new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));

function show() {
  lastRendered = current();
  noteTab(lastRendered);
  render();
}

/** Go to a page (e.g. "#/c/x/run/practice"). Calls are queued so quick double taps can't tangle the history. */
export function navigate(target) {
  queue = queue.then(() => go(String(target).replace(/^#/, '') || '/')).catch((e) => console.error(e));
  return queue;
}

async function go(target) {
  const from = chain(current());
  const to = chain(target);
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  const up = from.length - common;
  const down = to.slice(common);
  navigating = true;
  try {
    if (up > 0) {
      const done = popped();
      history.go(-up);
      await done;
    }
    if (down.length) {
      for (const p of down.slice(0, -1)) history.pushState({ path: p }, '', href(p));
      history.pushState({ path: target }, '', href(target));
    } else {
      history.replaceState({ path: target }, '', href(target)); // ancestor (or same page): keep any #anchor/query
    }
  } finally {
    navigating = false;
  }
  show();
}

/** Install handlers and render the first page. A deep link gets its ancestors inserted beneath it. */
export function startNav(renderFn) {
  render = renderFn;
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; // pages redraw themselves; no scroll jumps
  const cur = current();
  if (!history.state?.path) {
    const ch = chain(cur);
    history.replaceState({ path: ch[0] }, '', href(ch[0]));
    for (const p of ch.slice(1, -1)) history.pushState({ path: p }, '', href(p));
    if (ch.length > 1) history.pushState({ path: cur }, '', href(cur));
    else history.replaceState({ path: cur }, '', href(cur));
  }
  const onExternal = () => {
    if (navigating || current() === lastRendered) return; // our own history moves are rendered by go()
    if (!history.state?.path) history.replaceState({ path: current() }, '', location.href); // hand-edited URL
    show();
  };
  window.addEventListener('popstate', onExternal);
  window.addEventListener('hashchange', onExternal);
  // plain in-app links take the same route
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#/"]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target) return;
    e.preventDefault();
    navigate(a.getAttribute('href'));
  });
  show();
}
