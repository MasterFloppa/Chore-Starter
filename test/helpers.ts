import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Prepared } from '../src/shared/schema.js';
import type { ModelClient } from '../src/server/ollama.js';
import { TaskService } from '../src/server/service.js';
import { Store } from '../src/server/store.js';

export const prepared: Prepared = {
  kind: 'email',
  title: 'Request a replacement',
  summary: 'A polite draft asking for a replacement.',
  subject: 'Damaged headphones: replacement request',
  body: 'Hello,\n\nMy headphones arrived with a cracked headband. Could you help arrange a replacement?\n\nMy order number is [order number]. I can provide photos.\n\nThank you,\n[your name]',
  checklist: ['Add your order number', 'Attach photos before sending'],
  missingInfo: ['Order number', 'Your name'],
};

export function fixture(customModel?: ModelClient) {
  const directory = mkdtempSync(join(tmpdir(), 'chore-starter-test-'));
  const path = join(directory, 'state.json');
  const store = new Store(path, 'gemma3:4b');
  let clock = Date.parse('2026-10-26T00:00:00Z');
  const model: ModelClient = customModel ?? {
    health: async () => ({ models: ['gemma3:4b'], error: null }),
    prepare: async () => structuredClone(prepared),
  };
  return {
    directory, path, store, model,
    service: new TaskService(store, model, () => clock),
    advance: (ms: number) => { clock += ms; },
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}
