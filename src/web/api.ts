import type { Action, ActionEvent, ActionResult, Approval, EditInput, PrepareInput, Status, Task } from '../shared/schema';

export type TaskSummary = Pick<Task, 'id' | 'title' | 'kind' | 'updatedAt'>;
export interface TaskResponse { task: Task; events: ActionEvent[] }

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

let csrfToken = '';

async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-chore-starter-token': csrfToken },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error('The app server is not reachable. Keep its terminal open and try again.');
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error('The server returned an unexpected response. Check the terminal and reload the page.');
  }
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
      ? data.error : `The request failed (HTTP ${response.status}).`;
    throw new ApiError(message, response.status);
  }
  return data as T;
}

export const api = {
  status: async () => {
    const status = await request<Status>('/status');
    csrfToken = status.csrfToken;
    return status;
  },
  tasks: () => request<TaskSummary[]>('/tasks'),
  task: (id: string) => request<TaskResponse>(`/tasks/${id}`),
  prepare: (body: PrepareInput, signal: AbortSignal) => request<TaskResponse>('/tasks', 'POST', body, signal),
  edit: (id: string, body: EditInput) => request<{ task: Task }>(`/tasks/${id}`, 'PATCH', body),
  settings: (model: string) => request<{ model: string }>('/settings', 'PUT', { model }),
  preview: (id: string, revision: number, action: Action) => request<Approval>(`/tasks/${id}/preview`, 'POST', { revision, action }),
  cancel: (approval: Approval) => request<{ cancelled: boolean }>(`/tasks/${approval.taskId}/cancel`, 'POST', { token: approval.token }, AbortSignal.timeout(5000)),
  confirm: (approval: Approval) => request<ActionResult>(`/tasks/${approval.taskId}/confirm`, 'POST', { token: approval.token }),
};
