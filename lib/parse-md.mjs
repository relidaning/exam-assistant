// Parse loosely structured Markdown (Obsidian notes, pasted exam papers) into raw question objects.
// See docs/FORMAT.md for the accepted syntax. Output goes through normalizeAll().
import { canonicalType } from './normalize.mjs';

const KEYS = [
  ['explanation', /^(?:解析|答案解析|解答|详解|分析|explanation|explain|analysis|solution)\s*[:：]\s*/i],
  // Chinese answer keys are often written without a colon in notes: "答案C", "答案;C"
  ['answer', /^(?:【?(?:正确答案|参考答案|答案)】?(?!解析)\s*[:：;；]?|答\s*[:：]|(?:answer|ans|key)\s*[:：])\s*/i],
  ['type', /^(?:题型|类型|type)\s*[:：]\s*/i],
  ['tags', /^(?:标签|tags?)\s*[:：]\s*/i],
  ['difficulty', /^(?:难度|difficulty)\s*[:：]\s*/i],
  ['source', /^(?:来源|出处|source)\s*[:：]\s*/i],
  ['chapter', /^(?:章节|chapter)\s*[:：]\s*/i],
  ['unit', /^(?:单位|unit)\s*[:：]\s*/i],
  ['tol', /^(?:误差|允许误差|tolerance|tol)\s*[:：]\s*/i],
  ['keywords', /^(?:关键词|得分点|要点|keywords?|points)\s*[:：]\s*/i],
  ['score', /^(?:分值|score|points?\s*value)\s*[:：]\s*/i],
  ['order', /^(?:答案顺序|顺序|order)\s*[:：]\s*/i],
];
const MULTILINE = new Set(['answer', 'explanation']);

// Section headings like "一、单项选择题（每题2分）" or "Part II: Multiple Choice" set the default type.
const SECTION_TYPE_RE = [
  ['multi', /多项选择|多选|不定项|multiple[- ]choice|multi[- ]select|select all/i],
  ['single', /单项选择|单选|选择题|single[- ]choice|multiple[- ]?choice questions? \(one/i],
  ['judge', /判断|是非|true\s*(?:\/|or|-)\s*false|t\/f/i],
  ['fill', /填空|fill[- ]in|blanks?/i],
  ['calc', /计算|calculation|numeric|problems? to solve|compute/i],
  ['essay', /论述|材料题|材料分析|essay|discussion/i],
  ['term', /名词解释|definition/i],
  ['short', /简答|问答|证明|分析题|综合题|应用题|short[- ]answer|proof/i],
];

const TYPE_TAG_RE = /[\[【(（]\s*(单选题?|多选题?|单项选择题?|多项选择题?|不定项选择?题?|判断题?|填空题?|计算题?|简答题?|问答题?|论述题?|材料题|证明题?|名词解释题?|single|multi(?:ple)?|judge|tf|true\/false|fill|calc(?:ulation)?|short|essay|term)\s*[\]】)）]/i;
const OPTION_RE = /^\s*(?:[-*+]\s+)?[(（]?([A-La-l])\s*[.、．:：)）]\s*(.*)$/;
const OPTION_LOOSE_RE = /^\s*([A-L])\s*([\u4e00-\u9fa5“"《].*)$/; // "C实现…" (separator forgotten) — only for the expected letter
const BARE_ANSWER_RE = /^[A-L](?:[\s,，、]*[A-L]){0,11}$/; // a line holding just "ABC" after the options
const SECTION_LINE_RE = /^(?:[一二三四五六七八九十]+\s*[、.．]|(?:part|section)\s+\w+\s*[:.：]?)|^[\u4e00-\u9fa5]{1,8}题\s*[:：]?$/i;
const INLINE_ANSWER_RE = /^(.*\S)\s*(?:正确答案|参考答案|答案|Answer)\s*[:：]\s*(\S.*)$/; // "…伟大实践。答案：正确"
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
const CHECKBOX_RE = /^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/;
const NUMBERED_RE = /^(\d{1,3})\s*[.、．)）]\s*(?=\S)/;
const NUMBERED_LOOSE_RE = /^(\d{1,3})(?=[\u4e00-\u9fa5（(“])/; // "11改革开放…" — accepted only as the next number
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^\s*(```|~~~)/;
const OBSIDIAN_EMBED_RE = /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

function sectionType(text) {
  if (text.length > 40) return null;
  for (const [t, re] of SECTION_TYPE_RE) if (re.test(text)) return t;
  return null;
}

function parseFrontmatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: src.slice(m[0].length) };
}

/** Split "A. foo  B. bar" / " C.foo   D.bar" into separate option lines. */
function splitInlineOptions(line) {
  if (!/^\s*[(（]?[A-L](?:\s*[.、．)）]|[\u4e00-\u9fa5“"《])/.test(line)) return [line];
  // next option marker after whitespace ("A. x   B. y", "A. x  B y"), or glued to CJK text/punctuation ("…主义B.建设")
  const parts = line.split(/\s+(?=[(（]?[B-L](?:\s*[.、．)）]\s*\S|\s*[\u4e00-\u9fa5“"《]))|(?<=[\u4e00-\u9fa5，。；、）)”])(?=[B-L][.、．]\s*\S)/);
  return parts.length > 1 ? parts : [line];
}

/**
 * @returns {{ meta: object, questions: object[], warnings: string[] }}
 *   questions are raw (un-normalized) objects with stem/options/answer/... and `_line` for diagnostics.
 */
export function parseMarkdown(src) {
  const text = String(src).replace(/\r\n?/g, '\n');
  const { meta, body } = parseFrontmatter(text);
  const lines = body.split('\n');
  const lineOffset = text.slice(0, text.length - body.length).split('\n').length - 1; // frontmatter lines
  const questions = [];
  const warnings = [];
  let chapter = meta.chapter || null;
  let secType = canonicalType(meta.type) || null;
  let cur = null;
  let field = 'stem';
  let inFence = false;
  let checkboxAnswers = [];

  // endLine: last body line (1-based) that belongs to the current question; its source block is kept as `_raw`
  const flush = (endLine) => {
    if (!cur) return;
    cur._raw = lines.slice(cur._line - 1, endLine).join('\n').replace(/\s+$/, '');
    for (const k of ['stem', 'answer', 'explanation']) if (typeof cur[k] === 'string') cur[k] = cur[k].replace(/\n{3,}/g, '\n\n').trim();
    if (checkboxAnswers.length && (cur.answer == null || cur.answer === '')) cur.answer = checkboxAnswers;
    delete cur._num; delete cur._fieldList;
    // a lone short line with nothing else ("第三章 坚持党的全面领导" at the top of a note) is a title, not a question
    const isTitle = !cur.options && !cur.answer && !cur.explanation && cur.stem && !cur.stem.includes('\n')
      && cur.stem.length <= 40 && !/[?？_]|[(（]\s*[)）]|\{\{/.test(cur.stem);
    if (isTitle) {
      chapter = cur.stem.replace(/^#+\s*/, '').trim();
      cur = null;
      checkboxAnswers = [];
      return;
    }
    if (cur.stem || cur.options) {
      if (!cur.stem) warnings.push(`line ${cur._line}: question has no stem`);
      questions.push(cur);
    }
    cur = null;
    checkboxAnswers = [];
  };

  const start = (lineNo, text, num) => {
    flush(lineNo - 1);
    cur = { _line: lineNo, stem: '' };
    if (num != null) cur._num = num;
    if (chapter) cur.chapter = chapter;
    if (secType) cur.typeHint = secType; // soft: overridden when the question's shape disagrees
    field = 'stem';
    const tag = TYPE_TAG_RE.exec(text);
    if (tag) {
      const t = canonicalType(tag[1]) || canonicalType(tag[1].replace(/题$/, '') + '题');
      if (t) cur.type = t;
      text = text.replace(tag[0], '').trim();
    }
    const inline = INLINE_ANSWER_RE.exec(text);
    if (inline) {
      appendTo('stem', inline[1]);
      cur.answer = inline[2].trim();
      field = 'tail';
      return;
    }
    appendTo('stem', text);
  };

  const appendTo = (k, text) => {
    cur[k] = cur[k] ? `${cur[k]}\n${text}` : text;
  };

  lines.forEach((rawLine, i) => {
    const lineNo = i + 1;
    let line = rawLine.replace(ZERO_WIDTH_RE, '').replace(OBSIDIAN_EMBED_RE, (_, p) => `![](${p.trim()})`);

    if (FENCE_RE.test(line)) inFence = !inFence;
    if (inFence || FENCE_RE.test(line)) {
      if (cur) appendTo(field === 'stem' || MULTILINE.has(field) ? field : 'stem', line);
      return;
    }

    const h = HEADING_RE.exec(line);
    if (h) {
      const level = h[1].length;
      const text = h[2].trim();
      const st = sectionType(text);
      if (st) { flush(lineNo - 1); secType = st; return; }
      if (level === 1) { flush(lineNo - 1); chapter = text; return; }
      const hn = NUMBERED_RE.exec(text);
      start(lineNo, text.replace(NUMBERED_RE, ''), hn ? Number(hn[1]) : undefined);
      return;
    }

    const trimmed = line.trim();
    // plain-text section line: "二、多项选择题", "Part II: True/False", "判断题："
    if (trimmed.length <= 30 && SECTION_LINE_RE.test(trimmed) && sectionType(trimmed)) {
      flush(lineNo - 1);
      secType = sectionType(trimmed);
      return;
    }
    // Answer-like fields, in Obsidian callout or blockquote form as well: "> 答案：B", "> [!answer] B"
    const unq = trimmed.replace(/^>\s*/, '').replace(/^\[!(answer|tip|note|solution|explanation)\][-+]?\s*/i, (m, k) => {
      return /answer/i.test(k) ? 'answer: ' : /solution|explanation|tip/i.test(k) ? 'explanation: ' : '';
    });

    if (cur) {
      for (const [k, re] of KEYS) {
        if (re.test(unq)) {
          field = k;
          delete cur._fieldList;
          const val = unq.replace(re, '');
          if (MULTILINE.has(k)) { if (val) appendTo(k, val); else cur[k] = cur[k] || ''; }
          else cur[k] = val;
          // a one-line answer (letters for a choice question, or a short value) ends the answer: what follows is
          // the next question, not more answer text
          if (k === 'answer' && val && (cur.options?.length || val.length <= 20)) field = 'tail';
          if (k === 'chapter') cur.chapter = val;
          return;
        }
      }
    }

    if (!trimmed) {
      if (cur && field !== 'stem' && !MULTILINE.has(field)) field = 'stem';
      if (cur && MULTILINE.has(field)) appendTo(field, '');
      else if (cur && field === 'stem' && cur.stem) appendTo('stem', '');
      return;
    }

    // A numbered line starts a new question — except inside a multi-line answer/explanation, where it only does
    // when it continues the question numbering (Q3 → "4.") rather than the field's own "1. 2." list.
    let nm = NUMBERED_RE.exec(trimmed);
    if (!nm && cur?._num != null && cur.answer != null) {
      const loose = NUMBERED_LOOSE_RE.exec(trimmed);
      if (loose && Number(loose[1]) === cur._num + 1) nm = loose;
    }
    if (nm && !/^\s/.test(line)) {
      const n = Number(nm[1]);
      if (cur && MULTILINE.has(field)) {
        if (n === 1 || n === cur._fieldList) cur._fieldList = n + 1; // the field's own "1. 2. 3." list
        else if (cur._num != null && n === cur._num + 1) {
          start(lineNo, trimmed.replace(NUMBERED_RE, ''), n);
          return;
        }
        appendTo(field, line);
        return;
      }
      start(lineNo, trimmed.replace(NUMBERED_RE, ''), n);
      return;
    }

    if (!cur) {
      if (trimmed && !/^>/.test(trimmed)) start(lineNo, trimmed);
      return;
    }

    if (field === 'tail') {
      // text after a one-line answer: explanation for choice questions, more answer otherwise
      appendTo(cur.options?.length ? 'explanation' : 'answer', line);
      return;
    }

    if (field === 'stem' && cur.answer == null) {
      // answer written at the end of the stem line: "…伟大实践。答案：正确"
      const inline = INLINE_ANSWER_RE.exec(line);
      if (inline) {
        appendTo('stem', inline[1]);
        cur.answer = inline[2].trim();
        field = 'tail';
        return;
      }
    }

    if (field === 'stem' || field === 'options') {
      if (cur.options?.length >= 2 && cur.answer == null && BARE_ANSWER_RE.test(trimmed)
          && [...trimmed.replace(/[\s,，、]/g, '')].every((ch) => 'ABCDEFGHIJKL'.indexOf(ch) < cur.options.length)) {
        cur.answer = trimmed;
        field = 'tail';
        return;
      }
      const cb = CHECKBOX_RE.exec(line);
      if (cb) {
        cur.options = cur.options || [];
        if (cb[1].toLowerCase() === 'x') checkboxAnswers.push(cur.options.length);
        cur.options.push(cb[2].trim());
        field = 'options';
        return;
      }
      const parts = splitInlineOptions(line);
      let matched = false;
      for (const part of parts) {
        let om = OPTION_RE.exec(part);
        if (!om) {
          const loose = OPTION_LOOSE_RE.exec(part);
          const expected = 'ABCDEFGHIJKL'.indexOf(loose?.[1]) === (cur.options?.length || 0);
          // a separator-less "A…" only counts when a B option follows (so "A股市场…" stays text)
          const bFollows = parts.length > 1 || /^\s*[(（]?B(?:\s*[.、．)）]|\s*[\u4e00-\u9fa5“"《])/.test(lines[i + 1] || '');
          if (loose && expected && (cur.options?.length || bFollows)) om = loose;
        }
        if (om && (cur.options?.length || om[1].toUpperCase() === 'A')) {
          const idx = 'ABCDEFGHIJKL'.indexOf(om[1].toUpperCase());
          cur.options = cur.options || [];
          if (idx === cur.options.length) { cur.options.push(om[2].trim()); matched = true; field = 'options'; continue; }
        }
        if (matched && field === 'options') cur.options[cur.options.length - 1] += ' ' + part.trim();
      }
      if (matched) return;
      if (field === 'options' && cur.options?.length && /^\s{2,}/.test(line)) {
        cur.options[cur.options.length - 1] += ' ' + trimmed; // indented continuation of an option
        return;
      }
      if (field === 'options') field = 'stem';
      appendTo('stem', line);
      return;
    }

    if (MULTILINE.has(field)) { appendTo(field, line.replace(/^>\s?/, '')); return; }
    appendTo('stem', line);
    field = 'stem';
  });
  flush(lines.length);
  for (const q of questions) q._line += lineOffset; // report file line numbers, not body line numbers

  if (meta.tags) meta.tags = meta.tags.replace(/^\[|\]$/g, '');
  return { meta, questions, warnings };
}
