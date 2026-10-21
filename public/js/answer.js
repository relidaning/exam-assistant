// Question card: stem, media, and an answer widget fitted to the question type.
import { md, mdInline, mediaHtml, escapeHtml as esc } from './render.js';
import { LETTERS, TYPE_LABELS, answerText, parseNumeric, fmtNum, isOpen } from './grade.js';

/**
 * @param q   normalized question
 * @param st  session entry { response, result, submitted, scratch }
 * @param ctx {
 *   mode: 'practice'|'exam'|'review',
 *   showFeedback: bool  — show correct answer + explanation now
 *   locked: bool        — answer can no longer be changed
 *   autoSubmit: bool    — single/judge submit on tap
 *   onChange(response), onSubmit(reveal?: bool — Enter, may be blank), onSelfGrade(verdict: 'right'|'partial'|'wrong'),
 *   footer: HTMLElement|null — extra controls appended under the feedback (notes etc.)
 * }
 */
export function questionCard(q, st, ctx) {
  const card = document.createElement('article');
  card.className = `qcard type-${q.type}`;
  const show = ctx.showFeedback;
  const meta = [
    `<span class="badge type">${TYPE_LABELS[q.type]}</span>`,
    q.chapter ? `<span class="badge">${esc(q.chapter)}</span>` : '',
    q.difficulty ? `<span class="badge" title="Difficulty">${'★'.repeat(q.difficulty)}</span>` : '',
    q.source ? `<span class="badge subtle">${esc(q.source)}</span>` : '',
    ctx.points ? `<span class="badge subtle">${ctx.points} pt</span>` : '',
  ].join('');
  card.innerHTML = `<header class="qmeta">${meta}</header>`;

  const stem = document.createElement('div');
  stem.className = 'stem prose';
  if (q.type === 'fill') {
    stem.innerHTML = md(q.stem, { blanks: true });
    fillBlanks(stem, q, st, ctx, show);
  } else {
    stem.innerHTML = md(q.stem);
  }
  card.append(stem);
  if (q.media?.length) card.insertAdjacentHTML('beforeend', `<div class="media-list">${mediaHtml(q.media)}</div>`);

  const area = document.createElement('div');
  area.className = 'answer-area';
  card.append(area);
  const widgets = { single: choice, multi: choice, judge, fill: fillHint, calc, short, essay: short, term: short };
  widgets[q.type](area, q, st, ctx, show);

  if (show) card.append(feedback(q, st, ctx));
  return card;
}

// LaTeX → searchable text: symbols become Unicode, function names stay words, pure formatting commands vanish.
const TEX_WORDS = {
  int: '∫', iint: '∬', oint: '∮', sum: '∑', prod: '∏', infty: '∞', pi: 'π', theta: 'θ', alpha: 'α', beta: 'β', gamma: 'γ',
  delta: 'δ', Delta: 'Δ', epsilon: 'ε', varepsilon: 'ε', lambda: 'λ', mu: 'μ', sigma: 'σ', Sigma: 'Σ', omega: 'ω', Omega: 'Ω',
  phi: 'φ', varphi: 'φ', rho: 'ρ', tau: 'τ', partial: '∂', nabla: '∇', sqrt: '√', cdot: '·', times: '×', div: '÷', pm: '±',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', neq: '≠', ne: '≠', approx: '≈', to: '→', rightarrow: '→', Rightarrow: '⇒',
  leftrightarrow: '↔', Leftrightarrow: '⇔', in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', cup: '∪', cap: '∩', forall: '∀',
  exists: '∃', neg: '¬', land: '∧', lor: '∨', circ: '°', degree: '°', ldots: '…', cdots: '…',
};
const TEX_DROP = new Set(['left', 'right', 'displaystyle', 'textstyle', 'text', 'mathrm', 'mathbf', 'mathbb', 'mathcal', 'mathit',
  'operatorname', 'big', 'Big', 'bigg', 'Bigg', 'quad', 'qquad', 'limits', 'nolimits', 'dfrac', 'tfrac', 'frac', 'Big', 'boxed']);
function texToText(tex) {
  return tex
    .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, ' ($1)/($2) ')
    .replace(/\\[,;:! ]/g, ' ')
    .replace(/\\([a-zA-Z]+)/g, (_, name) => (TEX_WORDS[name] ? TEX_WORDS[name] : TEX_DROP.has(name) ? ' ' : ` ${name} `))
    .replace(/[{}]/g, ' ');
}

/** Plain-text search query: the full stem (markdown, images and LaTeX commands stripped) + all options, lettered. */
export function googleQuery(q) {
  const plain = (s) => String(s ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)|!\[\[[^\]]*\]\]/g, ' ') // images (markdown and Obsidian embeds)
    .replace(/\{\{([^}]*)\}\}/g, ' ')                // cloze answers must not leak into the query
    .replace(/_{3,}/g, ' ')                           // blanks
    .replace(/\$+([^$]*)\$+/g, (_, tex) => texToText(tex))
    // only Markdown formatting goes; symbols that belong to the question stay (switch#, switch>, C#, do~while, a|b)
    .replace(/^ {0,3}(#{1,6} +|> ?|```.*$)/gm, '') // heading marks, quote marks, code fences
    .replace(/\*\*|__|`/g, '')                      // bold and inline code
    .replace(/\s+/g, ' ')
    .trim();
  // the whole question goes to Google: stem plus every option with its letter
  let text = plain(q.stem);
  if (q.options?.length) text += ' ' + q.options.map((o, i) => `${LETTERS[i]}. ${plain(o)}`).join(' ');
  return text.slice(0, 1500); // stays well inside URL length limits even for long CJK questions
}

// udm=50 opens Google's AI Mode, which answers the question instead of listing pages
export const googleUrl = (q) => `https://www.google.com/search?udm=50&q=${encodeURIComponent(googleQuery(q))}`;

function button(label, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.innerHTML = label;
  b.addEventListener('click', onClick);
  return b;
}

/** Like button(), but its text can be selected and copied (browsers block selection inside <button>). */
function selectable(label, cls, onClick) {
  const b = document.createElement('div');
  b.className = cls;
  b.tabIndex = 0;
  b.innerHTML = label;
  b.addEventListener('click', (e) => {
    if (b.getAttribute('aria-disabled') === 'true') return;
    const sel = getSelection();
    if (sel && !sel.isCollapsed && b.contains(sel.anchorNode)) return; // finished selecting text, not a pick
    onClick(e);
  });
  b.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !e.ctrlKey && !e.metaKey) { e.preventDefault(); e.stopPropagation(); b.click(); }
  });
  return b;
}

// ---------- single / multi ----------
function choice(area, q, st, ctx, show) {
  const multi = q.type === 'multi';
  const picked = multi ? new Set(st.response || []) : new Set(st.response == null ? [] : [st.response]);
  const correct = new Set(multi ? q.answer : [q.answer]);
  if (multi && !ctx.locked) area.insertAdjacentHTML('beforeend', '<p class="hint">Select all that apply.</p>');
  const list = document.createElement('div');
  list.className = 'options';
  list.setAttribute('role', multi ? 'group' : 'radiogroup');
  q.options.forEach((opt, i) => {
    const sel = picked.has(i);
    let state = '';
    // 'missed' (dashed) only for multi: a correct option the user did not tick
    if (show) state = correct.has(i) ? (sel || !multi ? 'correct' : 'missed') : (sel ? 'wrong' : '');
    const b = selectable(
      `<span class="opt-key">${LETTERS[i]}</span><span class="opt-text">${mdInline(opt)}</span><span class="opt-mark" aria-hidden="true">${state === 'correct' ? '✓' : state === 'wrong' ? '✗' : state === 'missed' ? '←' : ''}</span>`,
      `opt ${sel ? 'selected' : ''} ${state}`,
      () => {
        if (ctx.locked) return;
        if (multi) {
          const next = new Set(picked);
          next.has(i) ? next.delete(i) : next.add(i);
          ctx.onChange([...next].sort((a, b) => a - b), true);
        } else {
          ctx.onChange(i, true);
          if (ctx.autoSubmit) ctx.onSubmit();
        }
      },
    );
    b.setAttribute(multi ? 'aria-pressed' : 'aria-checked', String(sel));
    if (!multi) b.setAttribute('role', 'radio');
    b.dataset.key = LETTERS[i];
    if (ctx.locked) b.setAttribute('aria-disabled', 'true');
    list.append(b);
  });
  area.append(list);
}

// ---------- true / false ----------
function judge(area, q, st, ctx, show) {
  const row = document.createElement('div');
  row.className = 'judge';
  for (const [val, label, key] of [[true, '✓ True', 'T'], [false, '✗ False', 'F']]) {
    const sel = st.response === val;
    let state = '';
    if (show) state = q.answer === val ? 'correct' : (sel ? 'wrong' : '');
    const b = button(label, `opt judge-btn ${sel ? 'selected' : ''} ${state}`, () => {
      if (ctx.locked) return;
      ctx.onChange(val, true);
      if (ctx.autoSubmit) ctx.onSubmit();
    });
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(sel));
    b.dataset.key = key;
    row.append(b);
  }
  area.append(row);
}

// ---------- fill in the blank ----------
function fillBlanks(stem, q, st, ctx, show) {
  const resp = [...(st.response || [])];
  const slots = [...stem.querySelectorAll('.blank-slot')];
  const blanksOk = st.result?.detail?.blanks || [];
  slots.forEach((slot, i) => {
    const want = st.result?.detail?.keys?.[i] || q.answer[i] || []; // any-order questions: the key this blank was paired with
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'blank-input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('aria-label', `Blank ${i + 1}`);
    input.enterKeyHint = i < slots.length - 1 ? 'next' : 'done';
    const longest = Math.max(4, ...want.map((w) => [...w].length * (/[^\x00-\xff]/.test(w) ? 2 : 1)));
    input.style.width = `${Math.min(longest + 3, 30)}ch`;
    input.value = resp[i] ?? '';
    input.readOnly = !!ctx.locked;
    if (show) input.classList.add(blanksOk[i] ? 'ok' : 'bad');
    input.addEventListener('input', () => { resp[i] = input.value; ctx.onChange([...resp], false); });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      const next = !(e.ctrlKey || e.metaKey) && slots[i + 1]?.querySelector('input');
      if (next) next.focus();
      else ctx.onSubmit?.(true);
    });
    if (input.readOnly) {
      // locked: plain text that wraps, so long answers are never cut off inside an input box
      const span = document.createElement('span');
      span.className = `blank-input blank-text ${input.className.replace('blank-input', '')}`;
      span.textContent = input.value || '\u2003';
      slot.replaceWith(span);
    } else slot.replaceWith(input);
    if (show && !blanksOk[i]) {
      stem.querySelectorAll('.blank-input')[i].insertAdjacentHTML('afterend', `<span class="blank-key" title="Accepted answers">${esc(want.join(' / '))}</span>`);
    }
  });
}

function fillHint(area, q, st, ctx) {
  if (!ctx.locked) area.insertAdjacentHTML('beforeend', `<p class="hint">Type into the blank${q.answer.length > 1 ? 's' : ''} above — Enter moves to the next one${ctx.mode === 'practice' ? ', and on the last one submits (or shows the answer)' : ''}.</p>`);
}

// ---------- calculation ----------
const KEYPAD = ['7', '8', '9', '/', '(', ')', '4', '5', '6', '*', '^', 'sqrt(', '1', '2', '3', '-', 'pi', 'e', '0', '.', 'E', '+', '%', '⌫'];

function calc(area, q, st, ctx, show) {
  const resp = [...(st.response || [])];
  const parts = st.result?.detail?.parts || [];
  const wrap = document.createElement('div');
  wrap.className = 'calc';
  let lastInput = null;
  q.answer.forEach((part, i) => {
    const row = document.createElement('div');
    row.className = 'calc-row';
    const id = `calc-${q.id}-${i}`;
    const label = part.label || (q.answer.length > 1 ? `(${i + 1})` : 'Answer');
    row.innerHTML = `<label for="${id}" class="calc-label">${mdInline(label)}</label>
      <div class="calc-field"><input id="${id}" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="e.g. 3.5, 1/3, 2*sqrt(2)">
      ${part.unit ? `<span class="calc-unit">${mdInline(part.unit)}</span>` : ''}</div>
      <output class="calc-preview" for="${id}"></output>`;
    const input = row.querySelector('input');
    const preview = row.querySelector('output');
    const update = () => {
      const v = parseNumeric(input.value, part.unit);
      const looksExpr = /[^\d.\s-]/.test(input.value.trim());
      preview.textContent = input.value.trim() ? (v === null ? 'not a number' : looksExpr ? `= ${fmtNum(v)}` : '') : '';
      preview.classList.toggle('bad', input.value.trim() !== '' && v === null);
    };
    input.value = resp[i] ?? '';
    input.readOnly = !!ctx.locked;
    update();
    input.addEventListener('focus', () => { lastInput = input; });
    input.addEventListener('input', () => { resp[i] = input.value; update(); ctx.onChange([...resp], false); });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      const next = !(e.ctrlKey || e.metaKey) && wrap.querySelectorAll('.calc-row input')[i + 1];
      if (next) next.focus(); else ctx.onSubmit?.(true);
    });
    if (show) {
      const ok = parts[i]?.ok;
      row.classList.add(ok ? 'ok' : 'bad');
      row.insertAdjacentHTML('beforeend', `<div class="calc-key">${ok ? '✓' : '✗'} correct: <b>${esc(fmtNum(part.value))}</b>${part.unit ? ' ' + mdInline(part.unit) : ''}${tolText(part)}</div>`);
    }
    if (!lastInput) lastInput = input;
    wrap.append(row);
  });
  area.append(wrap);

  if (!ctx.locked) {
    const tools = document.createElement('details');
    tools.className = 'calc-tools';
    tools.innerHTML = '<summary>Keypad &amp; scratch pad</summary>';
    const pad = document.createElement('div');
    pad.className = 'keypad';
    for (const k of KEYPAD) {
      const label = { '*': '×', '/': '÷', 'sqrt(': '√', pi: 'π', E: '×10ⁿ', '⌫': '⌫' }[k] || k;
      pad.append(button(esc(label), 'key', () => {
        const inp = lastInput;
        if (!inp || inp.readOnly) return;
        const s = inp.selectionStart ?? inp.value.length, e = inp.selectionEnd ?? inp.value.length;
        if (k === '⌫') {
          const from = s === e ? Math.max(0, s - 1) : s;
          inp.value = inp.value.slice(0, from) + inp.value.slice(e);
          inp.setSelectionRange(from, from);
        } else {
          const ins = k === 'E' ? 'e' : k;
          inp.value = inp.value.slice(0, s) + ins + inp.value.slice(e);
          inp.setSelectionRange(s + ins.length, s + ins.length);
        }
        inp.dispatchEvent(new Event('input'));
      }));
    }
    const scratch = document.createElement('textarea');
    scratch.className = 'scratch';
    scratch.placeholder = 'Working (not graded)…';
    scratch.rows = 4;
    scratch.value = st.scratch || '';
    scratch.addEventListener('input', () => { st.scratch = scratch.value; });
    tools.append(pad, scratch);
    area.append(tools);
    area.insertAdjacentHTML('beforeend', '<p class="hint">Expressions are fine: <code>1/3</code>, <code>2*pi*r</code>, <code>sqrt(2)</code>, <code>1.2e-3</code>. Units after the number are ignored.</p>');
  }
}

function tolText(part) {
  if (part.tol) return ` <span class="muted">(±${fmtNum(part.tol)})</span>`;
  if (part.rel) return ` <span class="muted">(±${fmtNum(part.rel * 100)}%)</span>`;
  return ' <span class="muted">(±1%)</span>';
}

// ---------- short answer ----------
function short(area, q, st, ctx, show) {
  const ta = document.createElement('textarea');
  ta.className = 'short-input';
  ta.rows = 5;
  // touch screens: Enter starts a new line (no Shift key to hold); the Submit button submits
  const enterSubmits = !matchMedia('(hover: none) and (pointer: coarse)').matches;
  ta.placeholder = ctx.locked ? '(left blank)' : !enterSubmits ? 'Write your answer…'
    : ctx.mode === 'practice' ? 'Write your answer… (Enter to submit, or to see the answer; Shift+Enter for a new line)' : 'Write your answer… (Enter to submit, Shift+Enter for a new line)';
  ta.value = st.response || '';
  ta.readOnly = !!ctx.locked;
  const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight + 2, 600)}px`; };
  ta.addEventListener('input', () => { grow(); ctx.onChange(ta.value, false); });
  ta.addEventListener('keydown', (e) => {
    if (enterSubmits && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.stopPropagation(); ctx.onSubmit?.(true); }
    else e.stopPropagation(); // typing letters must not trigger shortcuts
  });
  requestAnimationFrame(grow);
  area.append(ta);
}

// ---------- feedback ----------
function feedback(q, st, ctx) {
  const box = document.createElement('section');
  box.className = 'feedback';
  const r = st.result;
  let verdict = '';
  if (isOpen(q.type)) {
    if (st.selfGrade) verdict = verdictHtml(st.selfGrade === 'right' ? 'right' : st.selfGrade === 'partial' ? 'partial' : 'wrong');
    else verdict = '<div class="verdict pending">Compare with the reference answer and grade yourself</div>';
  } else if (r) {
    verdict = verdictHtml(r.correct ? 'right' : r.score > 0 ? 'partial' : (st.blank ? 'blank' : 'wrong'));
  }
  let html = verdict;
  if (q.type === 'single' || q.type === 'multi' || q.type === 'judge') {
    html += `<p class="key-line">Answer: <b>${esc(answerText(q))}</b></p>`;
  } else if (isOpen(q.type)) {
    html += `<div class="reference"><h4>Reference answer</h4><div class="prose">${md(q.answer)}</div></div>`;
    if (q.keywords?.length) {
      const hits = new Set(r?.detail?.keywordHits || []);
      html += `<p class="keywords">Key points: ${q.keywords.map((k) => `<span class="chip ${hits.has(k) ? 'hit' : ''}">${hits.has(k) ? '✓ ' : ''}${esc(k)}</span>`).join(' ')}</p>`;
    }
  }
  if (q.explanation) html += `<div class="explanation"><h4>Explanation</h4><div class="prose">${md(q.explanation)}</div></div>`;
  box.innerHTML = html;

  if (isOpen(q.type) && ctx.onSelfGrade) {
    const row = document.createElement('div');
    row.className = 'selfgrade';
    row.innerHTML = '<p class="sg-ask">How did you do? <span class="sg-why">Grade it to move on — it isn’t counted until you do.</span></p>';
    for (const [v, label, key, n] of [['right', 'I got it', 'Y', '1'], ['partial', 'Partly', 'P', '2'], ['wrong', 'Missed it', 'N', '3']]) {
      const b = button(`${label}<kbd class="key-hint">${key}</kbd>`, `btn sg-${v}${st.selfGrade === v ? ' on' : ''}`, () => ctx.onSelfGrade(v));
      b.dataset.keys = `${key} ${n}`;
      row.append(b);
    }
    box.append(row);
  }
  if (ctx.footer) box.append(ctx.footer);
  return box;
}

function verdictHtml(kind) {
  const map = {
    right: ['right', '✓ Correct'],
    partial: ['partial', '≈ Partially correct'],
    wrong: ['wrong', '✗ Incorrect'],
    blank: ['wrong', '— Not answered'],
  };
  const [cls, text] = map[kind];
  return `<div class="verdict ${cls}" role="status">${text}</div>`;
}
