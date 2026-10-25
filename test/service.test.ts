import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EditInput } from '../src/shared/schema.js';
import { AppError } from '../src/server/errors.js';
import { TaskService } from '../src/server/service.js';
import { Store } from '../src/server/store.js';
import { fixture, prepared } from './helpers.js';

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(() => { f.dispose(); });

const input = { request: 'Help me request a replacement for my broken headphones.', format: 'email' as const };
const edit = (task: Awaited<ReturnType<TaskService['prepare']>>, patch: Partial<EditInput> = {}): EditInput => ({
  revision: task.revision,
  title: task.title,
  recipient: task.recipient,
  subject: task.subject,
  body: task.body,
  checklist: task.checklist,
  ...patch,
});

describe('preparation and local storage', () => {
  it('prepares a draft with an empty recipient and performs no action', async () => {
    const task = await f.service.prepare(input);
    expect(task.recipient).toBe('');
    expect(task.body).toContain('[order number]');
    expect(task.checklist.every((i) => !i.done)).toBe(true);
    expect(f.store.read().events).toEqual([]);
    expect(f.store.read().tasks).toHaveLength(1);
  });

  it('keeps task data across restarts', async () => {
    const task = await f.service.prepare(input);
    const reopened = new Store(f.path, 'not-the-saved-model');
    expect(reopened.read().tasks[0]).toEqual(task);
    expect(reopened.read().model).toBe('gemma3:4b');
  });

  it('does not let a caller mutate the stored object', async () => {
    const task = await f.service.prepare(input);
    task.body = 'changed';
    const snapshot = f.store.read();
    snapshot.tasks[0].body = 'also changed';
    expect(f.store.read().tasks[0].body).toBe(prepared.body);
  });

  it('refuses to overwrite corrupt user data', () => {
    writeFileSync(f.path, '{broken');
    expect(() => new Store(f.path, 'gemma3:4b')).toThrow('It was not overwritten');
    expect(readFileSync(f.path, 'utf8')).toBe('{broken');
  });

  it('does not report a successful save when the file write fails', () => {
    mkdirSync(`${f.path}.tmp`);
    expect(() => f.store.update((state) => { state.model = 'other'; })).toThrow();
    expect(f.store.read().model).toBe('gemma3:4b');
  });

  it('keeps a failed model call out of history and clears busy state', async () => {
    const service = new TaskService(f.store, {
      health: f.model.health,
      prepare: async () => { throw new AppError('Ollama offline', 503); },
    });
    await expect(service.prepare(input)).rejects.toThrow('Ollama offline');
    expect(service.isBusy()).toBe(false);
    expect(f.store.read().tasks).toEqual([]);
  });

  it('rejects parallel model jobs rather than timing them out in a queue', async () => {
    let release!: (value: typeof prepared) => void;
    const pending = new Promise<typeof prepared>((resolve) => { release = resolve; });
    const service = new TaskService(f.store, { health: f.model.health, prepare: () => pending });
    const first = service.prepare(input);
    expect(service.isBusy()).toBe(true);
    await expect(service.prepare(input)).rejects.toThrow('Another task');
    release(prepared);
    await first;
    expect(service.isBusy()).toBe(false);
  });
});

describe('editing', () => {
  it('saves edits with a new revision', async () => {
    const task = await f.service.prepare(input);
    const changed = f.service.edit(task.id, edit(task, { body: 'My reviewed message.' }));
    expect(changed.revision).toBe(2);
    expect(f.service.getTask(task.id).body).toBe('My reviewed message.');
    expect(f.store.read().events).toEqual([]);
  });

  it('rejects stale writes from another tab', async () => {
    const task = await f.service.prepare(input);
    f.service.edit(task.id, edit(task, { body: 'Newer draft.' }));
    expect(() => f.service.edit(task.id, edit(task, { body: 'Older draft.' }))).toThrow('another tab');
    expect(f.service.getTask(task.id).body).toBe('Newer draft.');
  });
});

describe('confirmation gate', () => {
  it('requires a valid preview token before releasing text', async () => {
    const task = await f.service.prepare(input);
    expect(() => f.service.confirm(task.id, 'made-up')).toThrow('no longer valid');
    expect(f.store.read().events).toEqual([]);
  });

  it('does not record an action while only previewing', async () => {
    const task = await f.service.prepare(input);
    const preview = f.service.preview(task.id, task.revision, 'copy');
    expect(preview.content).toContain(task.body);
    expect(preview.explanation).toContain('Nothing is sent');
    expect(f.store.read().events).toEqual([]);
  });

  it('allows a token once and records only the approval', async () => {
    const task = await f.service.prepare(input);
    const preview = f.service.preview(task.id, 1, 'copy');
    expect(f.service.confirm(task.id, preview.token).content).toBe(preview.content);
    expect(f.store.read().events).toMatchObject([{ taskId: task.id, revision: 1, action: 'copy' }]);
    expect(() => f.service.confirm(task.id, preview.token)).toThrow('no longer valid');
    expect(f.store.read().events).toHaveLength(1);
  });

  it('invalidates a preview after any edit, including the recipient', async () => {
    const task = await f.service.prepare(input);
    const preview = f.service.preview(task.id, 1, 'copy');
    f.service.edit(task.id, edit(task, { recipient: 'user@example.com' }));
    expect(() => f.service.confirm(task.id, preview.token)).toThrow('no longer valid');
    expect(f.store.read().events).toEqual([]);
  });

  it('rejects previews for an old revision', async () => {
    const task = await f.service.prepare(input);
    f.service.edit(task.id, edit(task, { body: 'Changed.' }));
    expect(() => f.service.preview(task.id, 1, 'download')).toThrow('changed');
  });

  it('cancels without releasing content or recording an action', async () => {
    const task = await f.service.prepare(input);
    const preview = f.service.preview(task.id, 1, 'copy');
    f.service.cancel(task.id, preview.token);
    expect(() => f.service.confirm(task.id, preview.token)).toThrow('no longer valid');
    expect(f.store.read().events).toEqual([]);
  });

  it('expires confirmations after two minutes', async () => {
    const task = await f.service.prepare(input);
    const preview = f.service.preview(task.id, 1, 'download');
    f.advance(120_001);
    expect(() => f.service.confirm(task.id, preview.token)).toThrow('expired');
    expect(f.store.read().events).toEqual([]);
  });

  it('does not allow a token on another task', async () => {
    const first = await f.service.prepare(input);
    const second = await f.service.prepare(input);
    const preview = f.service.preview(first.id, 1, 'copy');
    expect(() => f.service.confirm(second.id, preview.token)).toThrow('no longer valid');
    expect(f.service.confirm(first.id, preview.token).action).toBe('copy');
  });

  it('does not carry approvals across server restarts', async () => {
    const task = await f.service.prepare(input);
    const preview = f.service.preview(task.id, 1, 'copy');
    const restarted = new TaskService(new Store(f.path, 'gemma3:4b'), f.model);
    expect(() => restarted.confirm(task.id, preview.token)).toThrow('no longer valid');
  });
});

describe('allowed actions', () => {
  it('downloads a safe filename and the reviewed checklist', async () => {
    const task = await f.service.prepare(input);
    const changed = f.service.edit(task.id, edit(task, { title: '../../bad:file<>.ps1' }));
    const preview = f.service.preview(task.id, changed.revision, 'download');
    const result = f.service.confirm(task.id, preview.token);
    expect(result.filename).toMatch(/^[a-z0-9-]+\.md$/);
    expect(result.content).toContain('- [ ] Add your order number');
  });

  it('requires a manually entered recipient before an email handoff', async () => {
    const task = await f.service.prepare(input);
    expect(() => f.service.preview(task.id, 1, 'email')).toThrow('recipient');
    expect(f.store.read().events).toEqual([]);
  });

  it('encodes email subject/body rather than executing or sending them', async () => {
    const task = await f.service.prepare(input);
    const changed = f.service.edit(task.id, edit(task, {
      recipient: 'person@example.com',
      subject: 'Refund & replacement?',
      body: 'Hello + thanks.\n<script>alert("x")</script>',
    }));
    const preview = f.service.preview(task.id, changed.revision, 'email');
    expect(preview.content).toContain('To: person@example.com');
    const result = f.service.confirm(task.id, preview.token);
    const url = new URL(result.url!);
    expect(url.protocol).toBe('mailto:');
    expect(url.searchParams.get('subject')).toBe('Refund & replacement?');
    expect(url.searchParams.get('body')).toBe(changed.body);
    expect(f.store.read().events[0].action).toBe('email');
  });

  it('rejects header injection in a recipient', async () => {
    const task = await f.service.prepare(input);
    const changed = f.service.edit(task.id, edit(task, { recipient: 'person@example.com\r\nBcc:evil@example.com' }));
    expect(() => f.service.preview(task.id, changed.revision, 'email')).toThrow('valid recipient');
  });
});
