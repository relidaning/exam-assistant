// "Re-parse" dialog: edit a question's source text (or load its note's current version), preview how it parses,
// and save it. Progress on the question is kept by the server even when its id changes.
import { api, esc, toast } from './ui.js';
import { md, mdInline } from './render.js';
import { TYPES, TYPE_LABELS, LETTERS, answerText, isOpen } from './grade.js';

const enc = encodeURIComponent;

/** Opens the dialog; resolves with { question, oldId } after a save, or null when cancelled. */
export async function openReparse(courseId, qid) {
  const src = await api('GET', `/api/courses/${enc(courseId)}/questions/${enc(qid)}/source`);
  const noteDiffers = src.fromFile && src.fromFile.raw.trim() !== src.raw.trim();
  const where = src.file
    ? `From <code>${esc(src.fileName)}</code>${src.line ? `, line ${src.line}` : ''}${src.fileExists ? '' : ' (file no longer found)'}`
    : src.generated ? 'The original text was not kept for this question; this is rebuilt from the saved question.' : 'Imported from pasted text.';

  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'dialog wide reparse';
    d.innerHTML = `<form method="dialog">
      <h3>Re-parse question</h3>
      <p class="muted small">${where}</p>
      ${noteDiffers ? `<div class="reparse-note">The note now has a different version of this question${src.fromFile.line ? ` (line ${src.fromFile.line})` : ''}.
        <button type="button" class="btn small" data-act="load-note">Use the note's version</button></div>` : ''}
      <label class="field"><span>Source text</span><textarea class="reparse-text" rows="9" spellcheck="false">${esc(src.raw)}</textarea></label>
      <label class="field inline"><span>Question type</span>
        <select name="type">${TYPES.map((t) => `<option value="${t}" ${t === src.question.type ? 'selected' : ''}>${esc(TYPE_LABELS[t])}</option>`).join('')}<option value="">Detect from the text</option></select>
      </label>
      <p class="hint">The type is a hint: it is used when the text fits it (e.g. “（ ）” counts as a blank for fill-in questions).</p>
      <div class="reparse-preview" aria-live="polite"></div>
      <div class="dialog-actions"><button class="btn ghost" value="cancel" formnovalidate>Cancel</button><button type="button" class="btn primary" data-act="save">Save</button></div>
    </form>`;
    document.body.append(d);
    const ta = d.querySelector('.reparse-text');
    const typeSel = d.querySelector('select[name="type"]');
    const out = d.querySelector('.reparse-preview');
    const saveBtn = d.querySelector('[data-act="save"]');
    let line = null;
    let timer = null;
    let seq = 0;
    let result = null;

    const body = (save) => ({ content: ta.value, type: typeSel.value || undefined, save, line });
    const preview = async () => {
      const mine = ++seq;
      let r;
      try { r = await api('POST', `/api/courses/${enc(courseId)}/questions/${enc(qid)}/reparse`, body(false)); }
      catch (e) { r = { error: e.message }; }
      if (mine !== seq) return; // a newer edit is already being previewed
      result = r;
      saveBtn.disabled = !!r.error;
      out.innerHTML = r.error
        ? `<p class="error-text">✗ ${esc(r.error)}</p>`
        : previewHtml(r.question) + (r.warnings || []).map((w) => `<p class="warn-text small">${esc(w)}</p>`).join('');
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(preview, 250); };

    ta.addEventListener('input', schedule);
    ta.addEventListener('keydown', (e) => e.stopPropagation()); // typing must not trigger the runner's shortcuts
    typeSel.addEventListener('change', preview);
    d.querySelector('[data-act="load-note"]')?.addEventListener('click', (e) => {
      ta.value = src.fromFile.raw;
      line = src.fromFile.line;
      e.target.closest('.reparse-note').remove();
      preview();
    });
    saveBtn.addEventListener('click', async () => {
      if (!result || result.error) return;
      saveBtn.disabled = true;
      try {
        const r = await api('POST', `/api/courses/${enc(courseId)}/questions/${enc(qid)}/reparse`, body(true));
        toast('Question updated', 'ok');
        d.returnValue = 'saved';
        d.close();
        resolve({ question: r.question, oldId: qid });
      } catch (e) {
        toast(e.message, 'error');
        saveBtn.disabled = false;
      }
    });
    d.addEventListener('close', () => { d.remove(); if (d.returnValue !== 'saved') resolve(null); });
    d.showModal();
    preview();
  });
}

function previewHtml(q) {
  const correct = new Set(q.type === 'single' ? [q.answer] : q.type === 'multi' ? q.answer : []);
  return `<div class="reparse-result">
    <p class="small"><span class="badge type">${esc(TYPE_LABELS[q.type])}</span> ${q.chapter ? `<span class="badge">${esc(q.chapter)}</span>` : ''}</p>
    <div class="prose">${md(q.stem)}</div>
    ${q.options ? `<ol class="opt-list" type="A">${q.options.map((o, i) => `<li class="${correct.has(i) ? 'is-answer' : ''}">${mdInline(o)}${correct.has(i) ? ' ✓' : ''}</li>`).join('')}</ol>` : ''}
    <p><b>Answer:</b> ${isOpen(q.type) ? '' : mdInline(String(answerText(q)))}</p>${isOpen(q.type) ? `<div class="prose">${md(q.answer)}</div>` : ''}
    ${q.explanation ? `<p class="muted small"><b>Explanation:</b> ${mdInline(q.explanation.split('\n')[0])}</p>` : ''}
    <p class="muted small">${q.options ? `${q.options.length} options (${LETTERS.slice(0, q.options.length).split('').join(' ')})` : ''}</p>
  </div>`;
}
