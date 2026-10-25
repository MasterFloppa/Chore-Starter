import { useEffect, useRef, useState } from 'react';
import type { Action, ActionEvent, Approval, Format, Status, Task } from '../shared/schema';
import { api, type TaskResponse, type TaskSummary } from './api';
import { Dialog } from './Dialog';

const EXAMPLES = [
  { label: 'Ask for a refund', request: 'Draft a polite email asking for a refund or replacement. My headphones arrived with a cracked headband. I have photos of the damage, but I still need to find the order number.' },
  { label: 'Plan a chore', request: 'Help me finally declutter my desk this weekend. I have 30 minutes, a pile of old bills, tangled cables, and notebooks. Prepare a realistic plan I can follow without buying anything.' },
  { label: 'Write a tricky message', request: 'Prepare a friendly message to my neighbour asking them to turn the music down after 10 pm. I want to keep things neighbourly rather than make it a confrontation.' },
];
const ACTION_LABELS: Record<Action, string> = { copy: 'Copy draft', download: 'Download task', email: 'Open email draft' };
const CONFIRM_LABELS: Record<Action, string> = { copy: 'Confirm & copy', download: 'Confirm & download', email: 'Confirm & open draft' };

function editable(task: Task) {
  return JSON.stringify([task.title, task.recipient, task.subject, task.body, task.checklist]);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function Settings({ status, onClose, onSaved }: { status: Status; onClose: () => void; onSaved: (status: Status) => void }) {
  const [model, setModel] = useState(status.model);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true);
    setError('');
    try {
      await api.settings(model);
      onSaved(await api.status());
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Local model" onClose={onClose} busy={busy}>
      <p className="muted">Ollama runs the model on this machine. Your tasks are not sent to a hosted AI service.</p>
      {status.ollamaError && <p role="alert" className="notice error">{status.ollamaError}</p>}
      <label className="field">Installed model
        <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
          {!status.models.includes(status.model) && <option value={status.model}>{status.model} (not available)</option>}
          {status.models.map((name) => <option key={name}>{name}</option>)}
        </select>
      </label>
      <p className="small muted">Nothing to select? Start Ollama and run <code>ollama pull gemma3:4b</code>, then reload.</p>
      {error && <p role="alert" className="notice error">{error}</p>}
      <div className="dialog-actions"><button className="button secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="button primary" onClick={save} disabled={busy || !status.models.includes(model)}>Save model</button></div>
    </Dialog>
  );
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [history, setHistory] = useState<TaskSummary[]>([]);
  const [request, setRequest] = useState('');
  const [format, setFormat] = useState<Format>('auto');
  const [task, setTask] = useState<Task | null>(null);
  const [savedTask, setSavedTask] = useState<Task | null>(null);
  const [events, setEvents] = useState<ActionEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [approval, setApproval] = useState<Approval | null>(null);
  const [approvalError, setApprovalError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [manualCopy, setManualCopy] = useState('');
  const controller = useRef<AbortController | null>(null);
  const dirty = !!task && !!savedTask && editable(task) !== editable(savedTask);

  useEffect(() => {
    let active = true;
    Promise.all([api.status(), api.tasks()]).then(([s, h]) => {
      if (active) { setStatus(s); setHistory(h); }
    }).catch((err: Error) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function showTask(result: TaskResponse) {
    setTask(result.task);
    setSavedTask(result.task);
    setEvents(result.events);
    setManualCopy('');
    setMessage('');
    setError('');
  }

  async function refreshHistory() {
    setHistory(await api.tasks());
  }

  async function prepare() {
    setError('');
    setMessage('');
    setBusy(true);
    setElapsed(0);
    controller.current = new AbortController();
    try {
      const result = await api.prepare({ request: request.trim(), format }, controller.current.signal);
      showTask(result);
      await refreshHistory();
    } catch (err) {
      if (controller.current.signal.aborted) setMessage('Stopped waiting. No outside action was performed. If the draft finishes saving, it will appear in history.');
      else setError((err as Error).message);
    } finally {
      setBusy(false);
      controller.current = null;
    }
  }

  function updateTask(patch: Partial<Task>) {
    setTask((cur) => cur ? { ...cur, ...patch } : null);
    setMessage('');
  }

  async function save(): Promise<Task> {
    if (!task) throw new Error('No task is open.');
    if (!dirty) return task;
    const result = await api.edit(task.id, {
      revision: task.revision,
      title: task.title,
      recipient: task.recipient,
      subject: task.subject,
      body: task.body,
      checklist: task.checklist,
    });
    setTask(result.task);
    setSavedTask(result.task);
    await refreshHistory();
    return result.task;
  }

  async function saveEdits() {
    setWorking(true);
    setError('');
    try { await save(); setMessage('Changes saved locally. Nothing was sent.'); }
    catch (err) { setError((err as Error).message); }
    finally { setWorking(false); }
  }

  async function preview(action: Action) {
    setWorking(true);
    setError('');
    setApprovalError('');
    setMessage('');
    try {
      const current = await save();
      setApproval(await api.preview(current.id, current.revision, action));
    } catch (err) { setError((err as Error).message); }
    finally { setWorking(false); }
  }

  async function cancelApproval() {
    if (!approval) return;
    setWorking(true);
    try {
      await api.cancel(approval);
      setApproval(null);
      setApprovalError('');
      setMessage('Cancelled. Nothing was copied, downloaded or opened.');
    } catch (err) { setApprovalError((err as Error).message); }
    finally { setWorking(false); }
  }

  async function confirmApproval() {
    if (!approval) return;
    setWorking(true);
    setApprovalError('');
    try {
      const result = await api.confirm(approval);
      setApproval(null);
      if (result.action === 'copy') {
        try {
          await navigator.clipboard.writeText(result.content);
          setMessage('Draft copied. Nothing was sent.');
        } catch {
          setManualCopy(result.content);
          setError('Clipboard access was blocked. Select and copy the text below manually.');
        }
      } else if (result.action === 'download') {
        const blob = URL.createObjectURL(new Blob([result.content], { type: 'text/markdown;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = blob;
        link.download = result.filename ?? 'prepared-task.md';
        link.click();
        setTimeout(() => URL.revokeObjectURL(blob), 1000);
        setMessage('Download requested. No file was uploaded.');
      } else if (result.url?.startsWith('mailto:')) {
        window.location.href = result.url;
        setMessage('Asked your email app to open this draft. Review and send it yourself; Chore Starter sent nothing.');
      }
      const current = await api.task(approval.taskId);
      setEvents(current.events);
    } catch (err) {
      setApprovalError((err as Error).message);
      setError((err as Error).message);
    } finally { setWorking(false); }
  }

  function mayLeave(): boolean {
    return !dirty || window.confirm('Discard the unsaved edits to this draft?');
  }

  async function openHistory(id: string) {
    if (working || !mayLeave()) return;
    setWorking(true);
    try { showTask(await api.task(id)); }
    catch (err) { setError((err as Error).message); }
    finally { setWorking(false); }
  }

  const ready = status?.modelReady ?? false;
  return (
    <main className="app">
      <header className="topbar">
        <a className="brand" href="/" onClick={(e) => { if (busy || working || !mayLeave()) e.preventDefault(); }}>
          <span className="brand-mark" aria-hidden="true">c<span>↗</span></span>
          <span>chore starter<span className="brand-caption">a little less effort</span></span>
        </a>
        <button className="model-button" onClick={() => setSettingsOpen(true)} disabled={!status || busy || working}>
          <span className={`dot ${ready ? 'ready' : 'offline'}`} />{ready ? 'Local AI' : 'Model setup'}
          <span aria-hidden="true">⌄</span>
        </button>
      </header>

      {error && <div role="alert" className="notice error">{error}</div>}
      {message && <div role="status" className="notice success">{message}</div>}

      {!task ? (
        <section className="composer-page">
          <div className="intro">
            <span className="eyebrow">THE HARD PART IS STARTING.</span>
            <h1>What are you<br />putting off?</h1>
            <p>Give me the messy version.<br />I’ll get it ready. You decide what happens next.</p>
          </div>
          <form className="composer" onSubmit={(e) => { e.preventDefault(); if (!busy && ready && request.trim().length >= 8) void prepare(); }}>
            <label className="sr-only" htmlFor="task-input">Your task</label>
            <textarea id="task-input" placeholder="I need to ask for a refund, but I don’t know what to write…" value={request} onChange={(e) => setRequest(e.target.value)} maxLength={4000} rows={5} disabled={busy} />
            <div className="composer-toolbar">
              <label className="format-select"><span className="sr-only">Output format</span>
                <select value={format} onChange={(e) => setFormat(e.target.value as Format)} disabled={busy}>
                  <option value="auto">Let AI choose</option><option value="email">Email draft</option><option value="message">Message draft</option><option value="plan">A plan</option>
                </select>
              </label>
              {busy ? <button type="button" className="button secondary" onClick={() => controller.current?.abort()}>Stop waiting</button> : <button className="button primary" disabled={!status || !ready || request.trim().length < 8}>Prepare it <span aria-hidden="true">↗</span></button>}
            </div>
          </form>
          {busy ? <p className="preparing" role="status"><span className="spinner" />Preparing your task · {elapsed}s<span className="small muted">Local AI can take 30–90 seconds. Nothing is being sent or carried out.</span></p> : <div className="examples"><span>Try a small chore</span>{EXAMPLES.map((example) => <button key={example.label} onClick={() => { setRequest(example.request); document.getElementById('task-input')?.focus(); }}>{example.label} <span aria-hidden="true">↗</span></button>)}</div>}
          {status && !ready && <p className="notice error" role="alert">{status.ollamaError ?? `The model "${status.model}" is not installed. Open Model setup to choose an installed model.`}</p>}
          <p className="privacy-line"><span aria-hidden="true">◇</span> Prepared locally. No automatic sending, spending or scheduling.</p>
        </section>
      ) : (
        <section className="task-page">
          <div className="task-heading">
            <button className="text-button" disabled={working} onClick={() => { if (mayLeave()) { setTask(null); setSavedTask(null); setEvents([]); setError(''); setMessage(''); } }}>← Another task</button>
            <span className="small muted">{dirty ? 'Unsaved edits' : 'Saved on this machine'}</span>
          </div>
          <div className="result-intro"><span className="eyebrow">READY FOR YOUR REVIEW</span><h1>The first draft is done.</h1><p>{task.summary}</p></div>
          <div className="workspace">
            <div className="draft-card">
              <label className="field title-field">Task title<input value={task.title} onChange={(e) => updateTask({ title: e.target.value })} maxLength={90} disabled={working} /></label>
              {task.kind === 'email' && <>
                <label className="field">To <span className="muted">(you choose the recipient)</span><input type="email" placeholder="recipient@example.com" value={task.recipient} onChange={(e) => updateTask({ recipient: e.target.value })} disabled={working} /></label>
                <label className="field">Subject<input value={task.subject} onChange={(e) => updateTask({ subject: e.target.value })} maxLength={160} disabled={working} /></label>
              </>}
              <div className="field"><label htmlFor="draft-body">{task.kind === 'plan' ? 'Your plan' : 'Your draft'}</label><textarea id="draft-body" className="draft-body" rows={12} value={task.body} onChange={(e) => updateTask({ body: e.target.value })} maxLength={6000} disabled={working} /></div>
              <div className="draft-foot"><span>AI draft. Check facts and placeholders.</span>{dirty && <button className="text-button" onClick={saveEdits} disabled={working}>Save edits</button>}</div>
            </div>
            <aside className="review-card">
              <h2>Before you use it</h2>
              <div className="checklist">{task.checklist.map((item, index) => <label className="check" key={index}><input type="checkbox" checked={item.done} disabled={working} onChange={(e) => updateTask({ checklist: task.checklist.map((cur, i) => i === index ? { ...cur, done: e.target.checked } : cur) })} /><span>{item.text}</span></label>)}</div>
              {task.missingInfo.length > 0 && <details className="missing" open><summary>Details to fill in ({task.missingInfo.length})</summary><ul>{task.missingInfo.map((item, i) => <li key={i}>{item}</li>)}</ul><p className="small muted">Keep placeholders until you have the real details.</p></details>}
              <div className="action-buttons">
                {(['copy', 'download'] as Action[]).map((action) => <button key={action} className={`button ${action === 'copy' ? 'primary' : 'secondary'}`} disabled={working} onClick={() => preview(action)}>{ACTION_LABELS[action]}<span aria-hidden="true">↗</span></button>)}
                {task.kind === 'email' && <button className="button secondary" disabled={working || !task.recipient.trim()} title={!task.recipient.trim() ? 'Enter a recipient first' : 'Opens a draft only; never sends'} onClick={() => preview('email')}>Open email draft <span aria-hidden="true">↗</span></button>}
              </div>
              <p className="confirmation-hint">You’ll see a preview and confirm first.<br />No “send” button lives here.</p>
            </aside>
          </div>
          {manualCopy && <label className="field manual-copy">Your browser blocked copying. Select this text to copy manually.<textarea readOnly value={manualCopy} onFocus={(e) => e.target.select()} rows={8} /></label>}
          <div className="task-meta">
            <details><summary>Original request</summary><p className="plain-text">{task.request}</p></details>
            <span className="small muted">{task.model} · prepared in {Math.max(1, Math.round(task.prepareMs / 1000))}s</span>
          </div>
          {events.length > 0 && <details className="event-history"><summary>Confirmation history ({events.length})</summary><ul>{events.map((event) => <li key={event.id}><span>You approved: {ACTION_LABELS[event.action].toLowerCase()}</span><time dateTime={event.at}>{formatDate(event.at)}</time></li>)}</ul><p className="small muted">Records your approvals, not email delivery or completion of the chore.</p></details>}
        </section>
      )}

      {history.length > 0 && <details className="history"><summary>Previously prepared <span>{history.length}</span></summary><div>{history.map((item) => <button key={item.id} disabled={busy || working} onClick={() => openHistory(item.id)}><span>{item.title}</span><span className="small muted">{formatDate(item.updatedAt)} ↗</span></button>)}</div></details>}
      <footer>Chore Starter <span>·</span> A draft, not a decision.</footer>

      {settingsOpen && status && <Settings status={status} onClose={() => setSettingsOpen(false)} onSaved={setStatus} />}
      {approval && <Dialog title={approval.title} busy={working} onClose={() => { void cancelApproval(); }}>
        <p className="muted">{approval.explanation}</p>
        <pre className="approval-preview">{approval.content}</pre>
        <p className="small muted">Applies only to this version of the draft. Confirmation expires after two minutes.</p>
        {approvalError && <p role="alert" className="notice error">{approvalError}</p>}
        <div className="dialog-actions"><button className="button secondary" onClick={cancelApproval} disabled={working}>Cancel</button><button className="button primary" onClick={confirmApproval} disabled={working}>{working ? 'Working…' : CONFIRM_LABELS[approval.action]}</button></div>
      </Dialog>}
    </main>
  );
}
