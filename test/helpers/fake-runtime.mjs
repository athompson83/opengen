import { randomUUID } from 'node:crypto';
import { RuntimeError } from '../../src/runtime-policy.mjs';

/** API test fixture only. It does not execute programs or provide isolation. */
export function fakeRuntime() {
  const records = new Map();
  const calls = [];
  const get = (id, { projectId } = {}) => {
    const record = records.get(id);
    if (!record || record.projectId !== projectId) throw new RuntimeError('SANDBOX_NOT_FOUND', 'Sandbox not found for this project.', 404);
    return record;
  };
  const descriptor = ({ files: _files, ...record }) => structuredClone(record);
  return {
    calls,
    async health() { calls.push(['health']); return { ready: true, backend: 'docker' }; },
    async create(input) {
      calls.push(['create', input]);
      const now = new Date().toISOString();
      const record = { id: randomUUID(), projectId: input.projectId, profile: input.profile ?? 'node', network: input.network ?? 'none', state: 'running', createdAt: now, updatedAt: now, limits: { memoryMb: 2048, cpus: 2, pids: 256 }, ports: [], files: new Map() };
      records.set(record.id, record);
      return descriptor(record);
    },
    async list({ projectId } = {}) { return [...records.values()].filter((record) => projectId === undefined || record.projectId === projectId).map(descriptor); },
    async get(id, scope) { return descriptor(get(id, scope)); },
    async start(id, scope) { const record = get(id, scope); record.state = 'running'; return descriptor(record); },
    async stop(id, scope) { const record = get(id, scope); record.state = 'stopped'; return descriptor(record); },
    async reset(id, scope) { const record = get(id, scope); record.state = 'running'; return descriptor(record); },
    async remove(id, scope) { get(id, scope); records.delete(id); return { id, deleted: true, workspaceDeleted: true }; },
    async exec(id, input) {
      get(id, input); calls.push(['exec', input]);
      return { exitCode: 0, stdout: 'fixture output\n', stderr: '', timedOut: false, truncated: false, durationMs: 1 };
    },
    async readFile(id, input) { return { path: input.path, content: get(id, input).files.get(input.path), encoding: 'base64' }; },
    async writeFile(id, input) {
      const data = Buffer.from(input.content, input.encoding ?? 'utf8');
      get(id, input).files.set(input.path, data.toString('base64'));
      return { path: input.path, bytes: data.length };
    },
  };
}
