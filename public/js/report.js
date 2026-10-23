// "Report" dialog: tell a question's owner what is wrong with it. From your own fork the report goes to the course it
// was forked from; the owner's answer shows up under Messages.
import { api, esc, toast } from './ui.js';
import { mdInline } from './render.js';
import { navigate } from './nav.js';

const enc = encodeURIComponent;

export const REPORT_KINDS = [
  ['answer', 'The answer is wrong'],
  ['question', 'The question is wrong or unclear'],
  ['explanation', 'The explanation is wrong'],
  ['typo', 'Typo or formatting'],
  ['other', 'Something else'],
];
export const KIND_LABELS = { answer: 'Wrong answer', question: 'Question', explanation: 'Explanation', typo: 'Typo', other: 'Other' };
export const STATUS_LABELS = { open: 'Open', fixed: 'Fixed', declined: 'No change' };

/** Opens the dialog for question q of course courseId; resolves with the sent report, or null. */
export async function openReport(courseId, q) {
  let info;
  try { info = await api('GET', `/api/courses/${enc(courseId)}/questions/${enc(q.id)}/report`); } catch (e) { toast(e.message, 'error'); return null; }
  if (!info.target) { toast('This is your own course: fix the question with Re-parse', 'warn'); return null; }
  if (!info.exists) { toast(`This question is no longer in “${info.target.name}”: it was changed or removed there, or you changed your copy`, 'warn', 4500); return null; }
  if (info.openId) { toast('You already reported this question'); navigate(`#/messages/${info.openId}`); return null; }
  const owner = info.target.owner?.username;

  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'dialog report-dialog';
    d.innerHTML = `<form method="dialog">
      <h3>Report a problem</h3>
      <p class="muted small">Goes to ${owner ? `<b>${esc(owner)}</b>, the owner of ` : 'the owner of '}“${esc(info.target.name)}”. Their answer will show under Messages.</p>
      <p class="report-stem">${mdInline(String(q.stem).split('\n')[0].slice(0, 160))}</p>
      <fieldset class="report-kinds"><legend>What's wrong?</legend>
        ${REPORT_KINDS.map(([v, l], i) => `<label><input type="radio" name="kind" value="${v}" ${i === 0 ? 'checked' : ''}><span>${esc(l)}</span></label>`).join('')}
      </fieldset>
      <label class="field"><span>Details</span><textarea name="message" rows="4" maxlength="2000" required placeholder="e.g. The answer should be B: the book's chapter 3 says…"></textarea></label>
      <div class="dialog-actions"><button class="btn ghost" value="cancel" formnovalidate>Cancel</button><button type="button" class="btn primary" data-act="send">Send report</button></div>
    </form>`;
    document.body.append(d);
    const ta = d.querySelector('textarea');
    const send = d.querySelector('[data-act="send"]');
    ta.addEventListener('keydown', (e) => e.stopPropagation()); // typing must not trigger the runner's shortcuts
    send.addEventListener('click', async () => {
      if (!ta.value.trim()) { ta.focus(); ta.reportValidity(); return; }
      send.disabled = true;
      try {
        const kind = d.querySelector('input[name="kind"]:checked')?.value;
        const r = await api('POST', `/api/courses/${enc(courseId)}/questions/${enc(q.id)}/report`, { kind, message: ta.value });
        toast('Report sent', 'ok');
        d.returnValue = 'sent';
        d.close();
        resolve(r);
      } catch (e) {
        toast(e.message, 'error');
        send.disabled = false;
      }
    });
    d.addEventListener('close', () => { d.remove(); if (d.returnValue !== 'sent') resolve(null); });
    d.showModal();
    if (matchMedia('(pointer: fine)').matches) ta.focus(); // phones: no keyboard over the choices yet
  });
}
