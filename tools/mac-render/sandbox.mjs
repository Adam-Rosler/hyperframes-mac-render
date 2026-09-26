// A macOS filesystem boundary for trusted native commands processing a project.
// Network, Mach and IOKit remain available for stock Chrome/Metal. This is not a VM.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const SANDBOX_POLICY_REVISION = 'mac-filesystem-v2';
const dependencyCache = new Map();
const systemRoots = ['/System', '/usr/lib', '/usr/share'];
const systemTools = ['/bin/ps', '/bin/sh', '/usr/bin/env'];
const browserCachePaths = ['.cache/hyperframes/chrome', '.cache/puppeteer/chrome-headless-shell'];

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Sandbox paths must be absolute and contain no control characters');
  }
  return path.resolve(value);
}

function canonical(value) { return fs.realpathSync(absolute(value)); }

function existingStat(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// The caller supplies a fresh directory under a trusted, non-worker-writable
// parent. Refuse existing links before creating anything beneath that directory.
function privateDirectory(dir) {
  const existing = existingStat(dir);
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
    throw new Error('Sandbox private directories must not be symlinks or non-directories');
  }
  if (!existing) fs.mkdirSync(dir, { mode: 0o700 });
  if (canonical(dir) !== dir) throw new Error('Sandbox private directories must not be symlinks');
  return dir;
}

function executable(command) {
  const candidates = path.isAbsolute(command) ? [command] : (process.env.PATH || '').split(path.delimiter)
    .filter((dir) => path.isAbsolute(dir)).map((dir) => path.join(dir, command));
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return canonical(candidate); } catch {}
  }
  throw new Error(`Sandbox requires an installed executable: ${command}`);
}

// Homebrew libraries use @rpath and can open sibling libraries dynamically. Grant
// only each discovered immutable formula/version tree, never the Homebrew prefix.
function formulaRoot(file) {
  return file.match(/^((?:\/opt\/homebrew|\/usr\/local)\/Cellar\/[^/]+\/[^/]+)(?:\/|$)/)?.[1];
}

function runtimeDependencies(seeds) {
  const key = seeds.map((file) => { const s = fs.statSync(file); return `${file}:${s.size}:${s.mtimeMs}`; }).join('|');
  if (dependencyCache.has(key)) return dependencyCache.get(key);
  const pending = [...seeds];
  for (const seed of seeds) {
    const lib = path.join(path.dirname(path.dirname(seed)), 'lib');
    if (formulaRoot(seed) && fs.existsSync(lib)) {
      pending.push(...fs.readdirSync(lib).filter((name) => name.endsWith('.dylib')).map((name) => path.join(lib, name)));
    }
  }
  const files = new Set();
  const roots = new Set();
  while (pending.length) {
    const file = canonical(pending.pop());
    if (files.has(file)) continue;
    files.add(file);
    const root = formulaRoot(file);
    if (root) roots.add(root);
    let listing;
    try {
      listing = execFileSync('/usr/bin/otool', ['-L', file], {
        encoding: 'utf8', timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
        env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      throw new Error(`Cannot inspect native runtime dependencies with /usr/bin/otool: ${file}. Install the macOS command line tools.`);
    }
    for (const line of listing.split('\n').slice(1)) {
      const dep = line.trim().split(' (')[0];
      const resolved = dep.startsWith('@loader_path/') ? path.resolve(path.dirname(file), dep.slice(13)) : dep;
      if (!path.isAbsolute(resolved) || systemRoots.some((dir) => resolved.startsWith(`${dir}/`))) continue;
      if (fs.existsSync(resolved)) pending.push(resolved);
      else throw new Error(`Missing native runtime dependency: ${resolved}`);
    }
  }
  const result = { files: [...files].sort(), roots: [...roots].sort() };
  dependencyCache.set(key, result);
  return result;
}

function rule(operation, paths, selector = 'subpath') {
  return paths.length ? `(allow ${operation}\n${paths.map((p) => `  (${selector} ${JSON.stringify(p)})`).join('\n')})\n` : '';
}

function readRule(paths) {
  const files = [], dirs = [];
  for (const item of paths) (fs.statSync(item).isDirectory() ? dirs : files).push(item);
  return rule('file-read* file-map-executable', dirs) + rule('file-read* file-map-executable', files, 'literal');
}

/**
 * Wrap trusted argv; never pass request-provided executables or permission roots.
 * scratchDir is fresh for each invocation, under a trusted parent the previous
 * worker could not write. It is NOT the render record dir or a prior worker dir.
 * readOnly/readWrite must exist; writeFiles may be new files in existing parents.
 * Caller must spawn with ignored/piped stdio and must not pass privileged open fds.
 * The caller adds its process-ownership token after this environment is returned.
 */
export function sandboxInvocation(argv, {
  scratchDir, readOnly = [], readWrite = [], writeFiles = [],
  browserPath, browserCaches = false, env = {},
} = {}) {
  if (process.platform !== 'darwin') throw new Error('Native render filesystem isolation requires macOS');
  fs.accessSync('/usr/bin/sandbox-exec', fs.constants.X_OK); // No unsandboxed fallback.
  if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== 'string' || a.includes('\0'))) {
    throw new Error('Sandbox command must be a nonempty string argv');
  }
  const requestedScratch = absolute(scratchDir);
  const scratch = path.join(canonical(path.dirname(requestedScratch)), path.basename(requestedScratch));
  if ([path.parse(scratch).root, canonical(os.homedir()), canonical(os.tmpdir())].includes(scratch)) {
    throw new Error('Sandbox scratch must be a dedicated private worker directory');
  }
  privateDirectory(scratch);
  const privateDirs = Object.fromEntries(['home', 'tmp', 'cache', 'config', 'extract'].map((name) => {
    return [name, privateDirectory(path.join(scratch, name))];
  }));
  const reads = readOnly.map(canonical);
  // Preserve native installed-font availability without granting Library as a whole.
  reads.push(...['/Library/Fonts', path.join(os.homedir(), 'Library', 'Fonts')]
    .filter((dir) => fs.existsSync(dir)).map(canonical));
  if (browserCaches) {
    for (const relative of browserCachePaths) {
      const source = path.join(os.homedir(), relative);
      if (!fs.existsSync(source)) continue;
      const target = canonical(source);
      if (!fs.statSync(target).isDirectory()) throw new Error('Native browser cache must be a directory');
      const link = path.join(privateDirs.home, relative);
      let parent = privateDirs.home;
      for (const name of path.dirname(relative).split(path.sep)) parent = privateDirectory(path.join(parent, name));
      if (existingStat(link)) {
        if (!fs.lstatSync(link).isSymbolicLink() || canonical(link) !== target) throw new Error('Unexpected private browser cache entry');
      } else fs.symlinkSync(target, link);
      reads.push(target);
    }
  }
  let browser;
  if (browserPath) {
    browser = canonical(browserPath);
    fs.accessSync(browser, fs.constants.X_OK);
    // Chrome's helper processes and resources live beside the selected binary.
    reads.push(path.dirname(browser));
  }
  const command = executable(argv[0]);
  const nativeTools = [canonical(process.execPath), executable('ffmpeg'), executable('ffprobe')];
  const dependencies = runtimeDependencies([...new Set([command, ...nativeTools, ...systemTools.map(canonical)])]);
  const writes = [scratch, ...readWrite.map(canonical)];
  const outputFiles = writeFiles.map((file) => {
    const resolved = absolute(file);
    // Resolve the parent, not an existing output symlink's target.
    const result = path.join(canonical(path.dirname(resolved)), path.basename(resolved));
    const existing = existingStat(result);
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
      throw new Error('Sandbox output must be a regular file');
    }
    return result;
  });
  const configFiles = ['/opt/homebrew/etc/openssl@3/openssl.cnf', '/usr/local/etc/openssl@3/openssl.cnf']
    .filter((file) => fs.existsSync(file)).map(canonical);
  const profile = `(version 1)
(deny default)
(allow process-exec process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target self) (target same-sandbox))
(allow system-sched (target self))
(allow sysctl-read)
(allow network* mach-lookup mach-register ipc-posix-shm iokit-open)
(allow file-read-metadata)
(allow file-read* (literal "/"))
(allow file-read* (literal "/dev/urandom") (literal "/dev/random") (literal "/dev/null") (literal "/dev/zero"))
(allow file-write-data (literal "/dev/null") (literal "/dev/zero"))
` + rule('file-read* file-map-executable', systemRoots)
    + rule('file-read* file-map-executable', dependencies.files, 'literal')
    + rule('file-read* file-map-executable', dependencies.roots)
    + readRule([...new Set([...reads, ...configFiles])])
    + rule('file-read* file-write*', [...new Set(writes)])
    + rule('file-read* file-write*', outputFiles, 'literal');
  const cleanEnv = {
    PATH: [...new Set([...nativeTools.map(path.dirname), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(path.delimiter),
    HOME: privateDirs.home, CFFIXED_USER_HOME: privateDirs.home, TMPDIR: privateDirs.tmp,
    XDG_CACHE_HOME: privateDirs.cache, XDG_CONFIG_HOME: privateDirs.config,
    HYPERFRAMES_EXTRACT_CACHE_DIR: privateDirs.extract,
    CI: '1', NO_COLOR: '1', HYPERFRAMES_SKIP_SKILLS: '1',
  };
  if (browser) cleanEnv.HYPERFRAMES_BROWSER_PATH = browser;
  for (const name of ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']) {
    if (typeof env[name] === 'string' && /^[A-Za-z0-9_./:+@-]{1,128}$/.test(env[name])) cleanEnv[name] = env[name];
  }
  if (['true', 'false'].includes(env.HF_CAPTURE_PARALLEL_STREAM)) cleanEnv.HF_CAPTURE_PARALLEL_STREAM = env.HF_CAPTURE_PARALLEL_STREAM;
  const cores = env.PRODUCER_CORES_PER_WORKER;
  if (typeof cores === 'string' && /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(cores)
    && Number.isFinite(Number(cores)) && Number(cores) > 0) cleanEnv.PRODUCER_CORES_PER_WORKER = cores;
  return { argv: ['/usr/bin/sandbox-exec', '-p', profile, command, ...argv.slice(1)], env: cleanEnv, profile };
}
