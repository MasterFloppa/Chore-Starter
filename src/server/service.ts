import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { emailSchema, type Action, type ActionResult, type Approval, type EditInput, type PrepareInput, type Task } from '../shared/schema.js';
import { AppError } from './errors.js';
import type { ModelClient } from './ollama.js';
import type { Store } from './store.js';

const APPROVAL_LIFETIME_MS = 2 * 60 * 1000;
const MAX_TASKS = 200;

interface PendingApproval {
  taskId: string;
  revision: number;
  action: Action;
  fingerprint: string;
  expires: number;
}

function draftText(task: Task): string {
  return [task.kind === 'email' && task.subject ? `Subject: ${task.subject}` : '', task.body].filter(Boolean).join('\n\n');
}

function markdown(task: Task): string {
  return [
    `# ${task.title}`,
    `> AI-prepared draft, reviewed by you. No message was sent or task carried out.`,
    draftText(task),
    '## Before using this',
    ...task.checklist.map((item) => `- [${item.done ? 'x' : ' '}] ${item.text}`),
    ...(task.missingInfo.length ? ['## Details to review', ...task.missingInfo.map((item) => `- ${item}`)] : []),
  ].join('\n\n');
}

function payload(task: Task, action: Action): ActionResult {
  if (action === 'copy') return { action, content: draftText(task) };
  if (action === 'download') {
    const stem = task.title.normalize('NFKD').replace(/[^a-zA-Z0-9 -]/g, '').trim().replace(/\s+/g, '-').slice(0, 60).toLowerCase();
    return { action, content: markdown(task), filename: `${stem || 'prepared-task'}.md` };
  }
  if (task.kind !== 'email') throw new AppError('Only an email draft can be opened in a mail app.');
  if (!emailSchema.safeParse(task.recipient).success) throw new AppError('Enter a valid recipient email address before opening an email draft.');
  const query = new URLSearchParams({ subject: task.subject, body: task.body });
  const url = `mailto:${task.recipient}?${query.toString().replace(/\+/g, '%20')}`;
  if (url.length > 8000) throw new AppError('This draft is too long for an email-app link. Copy or download it instead.');
  return { action, content: `To: ${task.recipient}\nSubject: ${task.subject}\n\n${task.body}`, url };
}

const fingerprint = (result: ActionResult) => createHash('sha256').update(JSON.stringify(result)).digest('hex');

export class TaskService {
  private busy = false;
  private readonly approvals = new Map<string, PendingApproval>();

  constructor(
    readonly store: Store,
    readonly model: ModelClient,
    private readonly now: () => number = Date.now,
  ) {}

  isBusy(): boolean {
    return this.busy;
  }

  getTask(id: string): Task {
    const task = this.store.read().tasks.find((t) => t.id === id);
    if (!task) throw new AppError('That task was not found.', 404);
    return task;
  }

  async prepare(input: PrepareInput, signal?: AbortSignal): Promise<Task> {
    if (this.busy) throw new AppError('Another task is being prepared. Let it finish, then try again.', 409);
    if (this.store.read().tasks.length >= MAX_TASKS) throw new AppError('Local history is full (200 tasks). Back up and clear the data file before preparing more.', 409);
    this.busy = true;
    const start = this.now();
    try {
      const selectedModel = this.store.read().model;
      const prepared = await this.model.prepare(input, selectedModel, signal);
      const at = new Date(this.now()).toISOString();
      const task: Task = {
        ...prepared,
        id: randomUUID(),
        revision: 1,
        request: input.request,
        format: input.format,
        recipient: '',
        checklist: prepared.checklist.map((text) => ({ text, done: false })),
        model: selectedModel,
        prepareMs: Math.max(0, this.now() - start),
        createdAt: at,
        updatedAt: at,
      };
      this.store.update((state) => { state.tasks.unshift(task); });
      return task;
    } finally {
      this.busy = false;
    }
  }

  edit(id: string, input: EditInput): Task {
    const current = this.getTask(id);
    if (current.revision !== input.revision) throw new AppError('This task changed in another tab. Reopen it before editing.', 409);
    const updated: Task = {
      ...current,
      ...input,
      revision: current.revision + 1,
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.store.update((state) => { state.tasks = state.tasks.map((t) => t.id === id ? updated : t); });
    for (const [token, approval] of this.approvals) if (approval.taskId === id) this.approvals.delete(token);
    return updated;
  }

  preview(id: string, revision: number, action: Action): Approval {
    const task = this.getTask(id);
    if (task.revision !== revision) throw new AppError('This draft changed. Review the latest version before confirming.', 409);
    const result = payload(task, action);
    for (const [token, approval] of this.approvals) if (approval.expires <= this.now()) this.approvals.delete(token);
    if (this.approvals.size >= 100) throw new AppError('Too many open confirmations. Close old dialogs and try again in two minutes.', 409);
    const token = randomBytes(32).toString('base64url');
    const expires = this.now() + APPROVAL_LIFETIME_MS;
    this.approvals.set(token, { taskId: id, revision, action, fingerprint: fingerprint(result), expires });
    return {
      token,
      taskId: id,
      revision,
      action,
      expiresAt: new Date(expires).toISOString(),
      title: action === 'copy' ? 'Copy this draft?' : action === 'download' ? 'Download this task?' : 'Open this email draft?',
      explanation: action === 'email'
        ? 'This opens your email app with the recipient, subject and draft shown below. It does not send the email. Review and send it yourself.'
        : action === 'download'
          ? 'This downloads a Markdown file to this browser. No file is uploaded and nothing is sent.'
          : 'This copies exactly the text shown below to your clipboard. Nothing is sent.',
      content: result.content,
    };
  }

  cancel(id: string, token: string): void {
    const approval = this.approvals.get(token);
    if (approval && approval.taskId === id) this.approvals.delete(token);
  }

  confirm(id: string, token: string): ActionResult {
    const approval = this.approvals.get(token);
    if (!approval || approval.taskId !== id) throw new AppError('This confirmation is no longer valid. Preview the action again.', 409);
    if (approval.expires <= this.now()) {
      this.approvals.delete(token);
      throw new AppError('This confirmation expired. Review the action again.', 409);
    }
    const task = this.getTask(id);
    const result = payload(task, approval.action);
    if (task.revision !== approval.revision || fingerprint(result) !== approval.fingerprint) {
      this.approvals.delete(token);
      throw new AppError('The draft changed after your preview. Review it again before continuing.', 409);
    }
    // All checks and persistence are synchronous. A token cannot be consumed twice, even on a double click.
    this.store.update((state) => {
      state.events.unshift({
        id: randomUUID(),
        taskId: id,
        revision: task.revision,
        action: approval.action,
        at: new Date(this.now()).toISOString(),
      });
      state.events = state.events.slice(0, 1000);
    });
    this.approvals.delete(token);
    return result;
  }
}
