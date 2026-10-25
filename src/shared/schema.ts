import { z } from 'zod';

export const formatSchema = z.enum(['auto', 'email', 'message', 'plan']);
export const kindSchema = z.enum(['email', 'message', 'plan']);
export const actionSchema = z.enum(['copy', 'download', 'email']);

export const preparedSchema = z.object({
  kind: kindSchema,
  title: z.string().trim().min(1).max(90),
  summary: z.string().trim().min(1).max(240),
  subject: z.string().trim().max(160),
  body: z.string().trim().min(1).max(6000),
  checklist: z.array(z.string().trim().min(1).max(180)).min(1).max(6),
  missingInfo: z.array(z.string().trim().min(1).max(180)).max(5),
}).strict();

export const taskSchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  request: z.string().trim().min(8).max(4000),
  format: formatSchema,
  kind: kindSchema,
  title: z.string().trim().min(1).max(90),
  summary: z.string().trim().min(1).max(240),
  recipient: z.string().trim().max(320),
  subject: z.string().trim().max(160),
  body: z.string().trim().min(1).max(6000),
  checklist: z.array(z.object({
    text: z.string().trim().min(1).max(180),
    done: z.boolean(),
  })).max(6),
  missingInfo: z.array(z.string().trim().min(1).max(180)).max(5),
  model: z.string().min(1).max(100),
  prepareMs: z.number().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const actionEventSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  revision: z.number().int().positive(),
  action: actionSchema,
  at: z.string().datetime(),
});

export const stateSchema = z.object({
  version: z.literal(1),
  model: z.string().trim().min(1).max(100),
  tasks: z.array(taskSchema).max(200),
  events: z.array(actionEventSchema).max(1000),
});

export const prepareInputSchema = z.object({
  request: z.string().trim().min(8, 'Describe the task in a little more detail.').max(4000),
  format: formatSchema.default('auto'),
}).strict();

export const editInputSchema = taskSchema.pick({
  revision: true,
  title: true,
  recipient: true,
  subject: true,
  body: true,
  checklist: true,
}).strict();

export const approveInputSchema = z.object({
  revision: z.number().int().positive(),
  action: actionSchema,
}).strict();

export const emailSchema = z.string().email().max(320).refine((s) => !/[\r\n]/.test(s));

export type Task = z.infer<typeof taskSchema>;
export type Prepared = z.infer<typeof preparedSchema>;
export type PrepareInput = z.infer<typeof prepareInputSchema>;
export type EditInput = z.infer<typeof editInputSchema>;
export type State = z.infer<typeof stateSchema>;
export type Action = z.infer<typeof actionSchema>;
export type ActionEvent = z.infer<typeof actionEventSchema>;
export type Format = z.infer<typeof formatSchema>;

export interface Approval {
  token: string;
  taskId: string;
  revision: number;
  action: Action;
  expiresAt: string;
  title: string;
  explanation: string;
  content: string;
}

export interface ActionResult {
  action: Action;
  content: string;
  filename?: string;
  url?: string;
}

export interface Status {
  csrfToken: string;
  model: string;
  modelReady: boolean;
  models: string[];
  ollamaError: string | null;
  busy: boolean;
}
