import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface QoderWatchConfigOptions {
  configPath?: string;
  projectsDir?: string;
}

export interface QoderWatchEntriesOptions extends QoderWatchConfigOptions {
  entries: unknown;
}

const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function resolveSessionId(sessionId: string, projectsDir: string): Promise<string | null> {
  const id = sessionId.replace(/\.jsonl$/, '');
  if (!SESSION_ID_RE.test(id)) return null;
  let dirs;
  try {
    dirs = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const candidate = join(projectsDir, dir.name, `${id}.jsonl`);
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

export async function resolveQoderWatchEntries(options: QoderWatchEntriesOptions): Promise<string[]> {
  if (!Array.isArray(options.entries)) return [];
  const projectsDir = options.projectsDir ?? join(homedir(), '.qoder-cn', 'projects');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of options.entries) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const entry = expandHome(raw.trim());
    let path: string | null = null;
    if (isAbsolute(entry)) {
      const absolute = resolve(entry);
      if (await isFile(absolute)) path = absolute;
    } else {
      path = await resolveSessionId(entry, projectsDir);
    }
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

export async function loadQoderWatchTargets(options: QoderWatchConfigOptions = {}): Promise<string[]> {
  const configPath = options.configPath ?? join(homedir(), '.thought-atlas', 'config.json');
  let config: unknown;
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    return [];
  }
  if (typeof config !== 'object' || config === null) return [];
  return resolveQoderWatchEntries({ ...options, entries: (config as Record<string, unknown>).qoderWatch });
}