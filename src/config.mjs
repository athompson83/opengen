import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  port: 47831,
  allowNetwork: false,
  maxSandboxes: 4,
  profiles: { node: { image: 'opengen/node:0.1.0' } },
});

const TOKEN = /^[A-Za-z0-9_-]{43,256}$/;
const PROFILE = /^[a-z][a-z0-9-]{0,31}$/;
const IMAGE = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_.-]+)?(?:@sha256:[a-f0-9]{64})?$/;

export function validateToken(token) {
  if (typeof token !== 'string' || !TOKEN.test(token)) {
    throw new Error('The API token must contain 43–256 base64url or hexadecimal characters.');
  }
  return token;
}

export function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Settings must be a JSON object.');
  if (Object.keys(input).some((key) => !Object.hasOwn(DEFAULT_SETTINGS, key))) throw new Error('Unknown setting.');
  const settings = { ...DEFAULT_SETTINGS, ...input };
  if (settings.version !== 1) throw new Error('Unsupported settings version.');
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) throw new Error('Port must be an integer from 1 to 65535.');
  if (typeof settings.allowNetwork !== 'boolean') throw new Error('allowNetwork must be true or false.');
  if (!Number.isInteger(settings.maxSandboxes) || settings.maxSandboxes < 1 || settings.maxSandboxes > 16) throw new Error('maxSandboxes must be an integer from 1 to 16.');
  if (!settings.profiles || typeof settings.profiles !== 'object' || Array.isArray(settings.profiles)) throw new Error('Profiles must be an object.');
  const profiles = {};
  const entries = Object.entries(settings.profiles);
  if (!entries.length || entries.length > 16) throw new Error('Configure between 1 and 16 profiles.');
  for (const [name, profile] of entries) {
    if (!PROFILE.test(name) || !profile || typeof profile !== 'object' || Array.isArray(profile)
      || Object.keys(profile).some((key) => key !== 'image')
      || typeof profile.image !== 'string' || profile.image.length > 250 || !IMAGE.test(profile.image)) {
      throw new Error('A profile must have a valid name and a single local Docker image reference.');
    }
    profiles[name] = { image: profile.image };
  }
  return { ...settings, profiles };
}

async function rejectUnsafePath(path, directory = false) {
  const info = await lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return null;
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) {
    throw new Error('OpenGen state must use ordinary directories and files, not symbolic links.');
  }
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error('OpenGen state must be owned by the current operating-system user.');
  }
  return info;
}

/** Owner-only local state. This API never prints or returns tokens in diagnostic objects. */
export async function loadState({ stateDir, env = process.env } = {}) {
  const directory = resolve(stateDir ?? env.OPENGEN_STATE_DIR ?? join(homedir(), '.opengen'));
  await rejectUnsafePath(directory, true);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(directory, 0o700);
  const settingsFile = join(directory, 'settings.json');
  const tokenFile = join(directory, 'token');
  await rejectUnsafePath(settingsFile);
  await rejectUnsafePath(tokenFile);
  try {
    await writeFile(settingsFile, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  let settings;
  try { settings = validateSettings(JSON.parse(await readFile(settingsFile, 'utf8'))); }
  catch { throw new Error('OpenGen settings are invalid; check the documented settings.json fields.'); }
  if (env.OPENGEN_PORT !== undefined) settings = validateSettings({ ...settings, port: Number(env.OPENGEN_PORT) });
  if (process.platform !== 'win32') {
    const info = await lstat(settingsFile);
    if ((info.mode & 0o077) !== 0) throw new Error('settings.json permissions must be restricted to its owner (0600).');
  }
  try {
    await writeFile(tokenFile, `${randomBytes(32).toString('base64url')}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (process.platform !== 'win32') {
    const info = await lstat(tokenFile);
    if ((info.mode & 0o077) !== 0) throw new Error('The token file must be restricted to its owner (0600).');
  }
  const token = validateToken(env.OPENGEN_TOKEN ?? (await readFile(tokenFile, 'utf8')).trim());
  return {
    stateDir: directory,
    settingsFile,
    tokenFile,
    settings,
    token,
    dockerPath: env.OPENGEN_DOCKER || 'docker',
    baseUrl: `http://127.0.0.1:${settings.port}`,
  };
}

export function stateSummary(state) {
  return {
    stateDir: state.stateDir,
    settingsFile: state.settingsFile,
    tokenFile: state.tokenFile,
    baseUrl: state.baseUrl,
    allowNetwork: state.settings.allowNetwork,
    profiles: Object.keys(state.settings.profiles),
    credentialStorage: process.platform === 'win32' ? 'current-user directory; verify Windows ACLs' : 'owner-only file permissions',
  };
}
