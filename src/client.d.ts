export interface Scope { projectId: string; signal?: AbortSignal }
export interface Sandbox {
  id: string;
  projectId: string;
  profile: string;
  network: 'none' | 'bridge';
  state: string;
  createdAt: string;
  updatedAt: string;
  limits: { memoryMb: number; cpus: number; pids: number };
  ports: Array<{ containerPort: number; hostPort: number; url: string }>;
  containerName?: string;
  workspaceVolume?: string;
  networkName?: string;
  imageId?: string;
}
export interface CreateSandbox {
  projectId: string;
  profile?: string;
  network?: 'none' | 'bridge';
  ports?: number[];
  limits?: { memoryMb?: number; cpus?: number };
}
export interface Execution {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}
export interface Client {
  health(options?: { signal?: AbortSignal }): Promise<{ service: 'opengen'; version: string; apiVersion: 'v1'; mode: 'local-single-owner'; runtime: Record<string, unknown> }>;
  list(options?: Partial<Scope>): Promise<Sandbox[]>;
  create(input: CreateSandbox, options?: { signal?: AbortSignal }): Promise<Sandbox>;
  get(id: string, scope: Scope): Promise<Sandbox>;
  start(id: string, scope: Scope): Promise<Sandbox>;
  stop(id: string, scope: Scope): Promise<Sandbox>;
  reset(id: string, scope: Scope): Promise<Sandbox>;
  remove(id: string, scope: Scope & { deleteWorkspace: boolean }): Promise<unknown>;
  exec(id: string, input: { projectId: string; argv: string[]; cwd?: string; timeoutMs?: number }, options?: { signal?: AbortSignal }): Promise<Execution>;
  readFile(id: string, input: Scope & { path: string }): Promise<{ path: string; content: string; encoding: 'base64' }>;
  writeFile(id: string, input: { projectId: string; path: string; content: string; encoding?: 'utf8' | 'base64' }, options?: { signal?: AbortSignal }): Promise<{ path: string; bytes: number }>;
}
export class OpenGenError extends Error {
  code: string;
  status: number;
  requestId?: string;
  constructor(code: string, message: string, status?: number, requestId?: string);
}
export function createClient(options: { baseUrl?: string; token: string }): Client;
