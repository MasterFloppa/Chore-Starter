import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { stateSchema, type State } from '../shared/schema.js';

export class Store {
  private state: State;

  constructor(private readonly path: string, defaultModel: string) {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) throw err;
      this.state = stateSchema.parse({ version: 1, model: defaultModel, tasks: [], events: [] });
      this.persist(this.state);
      return;
    }
    try {
      this.state = stateSchema.parse(JSON.parse(raw));
    } catch (err) {
      throw new Error(`Cannot read the saved task data at ${path}. It was not overwritten.`, { cause: err });
    }
  }

  read(): State {
    return structuredClone(this.state);
  }

  update(change: (next: State) => void): void {
    const next = this.read();
    change(next);
    const validated = stateSchema.parse(next);
    this.persist(validated);
    this.state = validated;
  }

  private persist(state: State): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temp, this.path);
  }
}
