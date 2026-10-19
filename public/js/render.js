// Markdown + KaTeX rendering. Math is cut out before Markdown (so `_` and `*` inside formulas survive),
// the Markdown HTML is sanitized, then KaTeX output (trusted) is put back.
import { marked } from '/vendor/marked/marked.esm.js';
import DOMPurify from '/vendor/dompurify/purify.es.mjs';
import katex from 'katex';
import 'katex/contrib/mhchem';

marked.setOptions({ gfm: true, breaks: true });

const BLANK_RE = /_{3,}/g;

/**
 * Render markdown+math to an HTML string.
 * opts.blanks: replace "____" runs with <span data-blank="i"> placeholders (fill-in questions).
 * opts.inline: render without wrapping <p>.
 */
export function md(src, opts = {}) {
  if (src == null) return '';
  let text = String(src);
  const math = [];
  const stash = (tex, display) => `@@M${math.push({ tex, display }) - 1}@@`;

  // protect code spans/blocks from math extraction
  const code = [];
  text = text.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => `@@C${code.push(m) - 1}@@`);
  text = text
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => stash(t, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => stash(t, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => stash(t, false))
    .replace(/(^|[^\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g, (_, pre, t) => pre + stash(t, false));
  let blankCount = 0;
  if (opts.blanks) text = text.replace(BLANK_RE, () => `@@B${blankCount++}@@`);
  text = text.replace(/@@C(\d+)@@/g, (_, i) => code[i]);

  let html = opts.inline ? marked.parseInline(text) : marked.parse(text);
  html = DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'controls', 'playsinline'], ADD_TAGS: ['audio', 'video', 'source'] });
  html = html.replace(/@@M(\d+)@@/g, (_, i) => {
    const { tex, display } = math[i];
    try {
      return katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore', output: 'htmlAndMathml' });
    } catch {
      return escapeHtml(tex);
    }
  });
  html = html.replace(/@@B(\d+)@@/g, (_, i) => `<span class="blank-slot" data-blank="${i}"></span>`);
  // images are lazy and zoomable; links open outside the app
  html = html.replace(/<img /g, '<img loading="lazy" data-zoom="1" ').replace(/<a href="http/g, '<a target="_blank" rel="noopener" href="http');
  return html;
}

export const mdInline = (s) => md(s, { inline: true });

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Render the attached media list of a question. */
export function mediaHtml(media = []) {
  return media.map((m) => {
    const src = escapeHtml(m.src);
    const cap = m.caption ? `<figcaption>${mdInline(m.caption)}</figcaption>` : '';
    switch (m.type) {
      case 'audio': return `<figure class="media media-audio"><audio controls preload="metadata" src="${src}"></audio>${cap}</figure>`;
      case 'video': return `<figure class="media media-video"><video controls playsinline preload="metadata" src="${src}"></video>${cap}</figure>`;
      case 'pdf': return `<figure class="media media-pdf"><a class="btn ghost" target="_blank" rel="noopener" href="${src}">📄 Open PDF</a>${cap}</figure>`;
      default: return `<figure class="media media-image"><img loading="lazy" data-zoom="1" src="${src}" alt="${escapeHtml(m.caption || '')}">${cap}</figure>`;
    }
  }).join('');
}
