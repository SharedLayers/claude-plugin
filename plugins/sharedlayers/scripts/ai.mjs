#!/usr/bin/env node
/**
 * SharedLayers AI layer helper, for an AI agent working in this project.
 *
 * The SharedLayers extension writes this file into .sharedlayers/ beside an AI
 * layer and keeps it up to date; changes made here by hand are written over.
 * AI.md, next to it, says how an agent uses it. The SharedLayers plugin for
 * Claude Code carries the same file, and its hooks run `wake` (and through it
 * `serve`) with every session.
 *
 *   node .sharedlayers/ai.mjs listen           one line per new request, until stopped
 *   node .sharedlayers/ai.mjs show <id>        a request in full, as JSON
 *   node .sharedlayers/ai.mjs working <id>     tell the person you have started on it
 *   node .sharedlayers/ai.mjs done <id> <text> say what you changed; the person checks it
 *   node .sharedlayers/ai.mjs ask <id> <text>  ask the person something before going on
 *   node ai.mjs serve [project]                the plugin's: listen, and let the extension
 *                                              read and write .sharedlayers over a local port
 *   node ai.mjs wake [project]                 the plugin's hooks: keep the session's serve
 *                                              running, and wake Claude with its requests
 *   node ai.mjs codex [project]                serve, and run Codex on each request as it comes
 *   node ai.mjs copilot [project]              the same with GitHub Copilot
 *   node ai.mjs cursor [project]               the same with Cursor
 *
 * Needs Node 18 or later and nothing else. Every write replaces a file in one
 * step (a new file renamed over the old), so the extension never reads half
 * of one.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promises as fs, appendFileSync, openSync, closeSync, writeSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A path as the disk names it (/tmp and /private/tmp are one folder on a Mac). */
function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The .sharedlayers folder this works on, and the project it is in. */
let ROOT = process.env.SHAREDLAYERS_DIR || dirname(fileURLToPath(import.meta.url));
let PROJECT = real(dirname(ROOT));
let LAYERS = join(ROOT, 'layers');
/** Read by the extension, to show the person whether anyone is listening. */
let AGENT = join(ROOT, 'agent.json');

function useProject(project) {
  PROJECT = real(project);
  ROOT = join(project, '.sharedlayers');
  LAYERS = join(ROOT, 'layers');
  AGENT = join(ROOT, 'agent.json');
}

/**
 * The app answering, as its replies are marked. `codex` and `copilot` set it
 * for themselves and the commands their AI runs; Codex's sandbox says itself
 * otherwise.
 */
let VIA = process.env.SHAREDLAYERS_VIA || (process.env.CODEX_SANDBOX ? 'Codex' : 'Claude');

const LOOK_MS = Number(process.env.SHAREDLAYERS_LOOK_MS) || 1000;
const BEAT_MS = 3000;
/** How often a session's listener checks its Claude Code is still there, and its wake hook looks for lines. */
const OWNER_LOOK_MS = Number(process.env.SHAREDLAYERS_OWNER_MS) || 5000;
const WAKE_LOOK_MS = Number(process.env.SHAREDLAYERS_WAKE_MS) || 500;
/**
 * A pid file its process has not touched for this long names a process that
 * is gone, whatever that pid is now: Windows hands pids out again within
 * minutes, and a listener ended there is ended outright, files and all. The
 * lock and a session's listener file are touched every beat; a waiting hook's
 * file every look, so it goes stale sooner.
 */
const STALE_MS = 20_000;
const WAITER_STALE_MS = Math.max(5000, WAKE_LOOK_MS * 10);
/**
 * The page picture and attached images are saved a moment after the comment.
 * A new request is passed on once its picture is there, or after this long
 * without one (pictures can be off); a reply after a second.
 */
const SETTLE_MS = Number(process.env.SHAREDLAYERS_SETTLE_MS ?? 4000);
const REPLY_SETTLE_MS = Math.min(SETTLE_MS, 1000);
/** How much of a request one line carries; `show` has the rest. */
const LINE_TEXT = 280;

/* ------------------------------------------------------------------ */
/* Layer files                                                         */
/* ------------------------------------------------------------------ */

async function readJson(path) {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Every layer in the folder, with its file's id. */
async function allLayers() {
  let names = [];
  try {
    names = await fs.readdir(LAYERS);
  } catch {
    return [];
  }
  const layers = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const layer = await readJson(join(LAYERS, name));
    if (layer && Array.isArray(layer.comments)) {
      layers.push({ id: name.slice(0, -'.json'.length), layer });
    }
  }
  return layers;
}

/** Every AI layer in the folder, with its file's id. */
async function aiLayers() {
  return (await allLayers()).filter(({ layer }) => layer.workflow_type === 'ai');
}

/** Writes a file whole: a new one beside it, renamed over it. */
async function replaceFile(path, data) {
  const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(temp, data);
  await fs.rename(temp, path);
}

async function writeLayer(id, layer) {
  await replaceFile(join(LAYERS, `${id}.json`), `${JSON.stringify(layer, null, 2)}\n`);
}

/** The AI layer holding a comment, found by its id or the start of it. */
async function findRequest(ref) {
  if (!ref) fail('Say which request: its id, as listen printed it.');
  const hits = [];
  for (const { id, layer } of await aiLayers()) {
    for (const comment of layer.comments) {
      if (typeof comment?.id === 'string' && comment.id.startsWith(ref)) hits.push({ id, layer, comment });
    }
  }
  if (hits.length === 0) fail(`No request ${ref} in an AI layer in ${ROOT}.`);
  if (hits.length > 1) fail(`${ref} matches ${hits.length} requests; give more of the id.`);
  return hits[0];
}

/**
 * Reads a layer again just before changing it, so a comment the person posted
 * a moment ago is not written over, and writes it back.
 */
async function changeRequest(ref, change) {
  const { id, comment: { id: commentId } } = await findRequest(ref);
  const layer = await readJson(join(LAYERS, `${id}.json`));
  const comment = layer?.comments?.find((c) => c?.id === commentId);
  if (!comment) fail(`Request ${ref} was deleted.`);
  change(comment);
  await writeLayer(id, layer);
  return comment;
}

/* ------------------------------------------------------------------ */
/* What a request is                                                   */
/* ------------------------------------------------------------------ */

/** Where a request stands: sent (waiting for you), working, question or done. */
function statusOf(comment) {
  if (comment.is_resolved) return 'resolved';
  return ['working', 'question', 'done'].includes(comment.ai_status) ? comment.ai_status : 'sent';
}

/** The person's words after the agent's last say: the newest reply, or the comment itself. */
function latestWord(comment) {
  const replies = Array.isArray(comment.replies) ? comment.replies : [];
  const last = replies[replies.length - 1];
  return last && !last.via ? { text: last.body, reply: true } : { text: comment.body, reply: replies.some((r) => !r.via) };
}

function oneLine(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** What `listen` prints for one request: enough to start, in one line. */
function requestLine(comment, status) {
  const { text, reply } = latestWord(comment);
  // The label names the element as the widget does: <h1#title> "Book a lesson".
  const where = [comment.page_url || '/', comment.anchor_element_label ? oneLine(comment.anchor_element_label, 80) : null]
    .filter(Boolean).join(' ');
  const what = oneLine(text, LINE_TEXT) || '(an image; run show)';
  const kind = status === 'working' ? 'Unfinished request' : reply ? 'New reply on request' : 'New request';
  return `${kind} ${comment.id} on ${where}: ${what}`;
}

/**
 * What makes a request news: its id and the person's latest reply. A reply
 * after the agent's answer sends it back (the extension marks it sent again),
 * and is news of its own.
 */
function newsKey(comment) {
  const mine = personReplies(comment);
  return `${comment.id}:${mine.length ? mine[mine.length - 1].id : ''}`;
}

function personReplies(comment) {
  return (Array.isArray(comment.replies) ? comment.replies : []).filter((r) => r && !r.via);
}

/** Whether what the person wrote last has had time to bring its picture and images along. */
function settled(comment, now = Date.now()) {
  const mine = personReplies(comment);
  const last = mine[mine.length - 1];
  if (last) return now - Date.parse(last.created_at) >= REPLY_SETTLE_MS || Number.isNaN(Date.parse(last.created_at));
  if (comment.snapshot_path) return true;
  const age = now - Date.parse(comment.created_at);
  return Number.isNaN(age) || age >= SETTLE_MS;
}

/* ------------------------------------------------------------------ */
/* One listener per project                                            */
/* ------------------------------------------------------------------ */

/**
 * A lock file outside the project, named after it, holding the pid of the
 * process passing its requests on. Two Claude Code sessions in one project, or
 * the plugin and a hand-started listen, would otherwise both take every request.
 */
function projectKey() {
  return createHash('sha1').update(PROJECT).digest('hex').slice(0, 16);
}

function lockPath() {
  return join(os.tmpdir(), `sharedlayers-${projectKey()}.lock`);
}

/**
 * A Claude Code session's own files beside the lock: its listener's pid
 * (serve), its waiting hook's (waiter), the lines queued for it (queue) and how
 * much of them it has been handed (offset).
 */
function sessionFile(session, kind) {
  return join(os.tmpdir(), `sharedlayers-${projectKey()}-${session}.${kind}`);
}

/** The pid written in a file, or 0. */
function readPid(path) {
  try {
    return Number(readFileSync(path, 'utf8')) || 0;
  } catch {
    return 0;
  }
}

function alive(pid) {
  // 0 would ask about this whole process group, and a negative pid about another one.
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/** How long ago a file was written or touched, in ms; Infinity when it is not there. */
function age(path) {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return Infinity;
  }
}

/** Keeps a pid file of this process fresh (STALE_MS), while it still names this process. */
function keepFresh(path, every = BEAT_MS) {
  return setInterval(() => {
    if (readPid(path) !== process.pid) return;
    const now = new Date();
    try {
      utimesSync(path, now, now);
    } catch { /* gone: nothing to keep */ }
  }, every);
}

/** The pid a pid file names, while that process is alive and keeps the file fresh; else 0. */
function liveHolder(path, within = STALE_MS) {
  const pid = readPid(path);
  return pid && alive(pid) && age(path) < within ? pid : 0;
}

/** The pid holding the project's lock, other than this one, or null. */
function lockHolder() {
  const pid = liveHolder(lockPath());
  return pid && pid !== process.pid ? pid : null;
}

let keepingLock = null;

/** Takes the lock when nobody alive holds it, and keeps it fresh while this runs. */
function takeLock() {
  if (lockHolder()) return false;
  try {
    const fd = openSync(lockPath(), 'w');
    writeSync(fd, String(process.pid));
    closeSync(fd);
  } catch {
    return false;
  }
  // Another process may have written in the same moment: the last write wins.
  if (lockHolder()) return false;
  keepingLock ??= keepFresh(lockPath());
  return true;
}

function releaseLock() {
  try {
    if (Number(readFileSync(lockPath(), 'utf8')) === process.pid) rmSync(lockPath(), { force: true });
  } catch { /* gone already */ }
}

/* ------------------------------------------------------------------ */
/* Passing requests on                                                 */
/* ------------------------------------------------------------------ */

/**
 * Looks at the AI layers every second and prints each request that is news
 * (through `emit`, `serve`'s for a Claude Code session), or hands it to
 * `onNews` (`codex`, `copilot`) instead.
 */
async function watch({ hint = null, announce = true, onNews = null, emit = (text) => process.stdout.write(text) } = {}) {
  const said = new Set();
  let first = true;
  let hinted = false;
  for (;;) {
    for (const { layer } of await aiLayers()) {
      for (const comment of layer.comments) {
        if (typeof comment?.id !== 'string') continue;
        const status = statusOf(comment);
        // Taken already, by you or another listener, is news only the first
        // time round: something left unfinished when the last listener stopped.
        const news = status === 'sent' || (first && status === 'working');
        const key = newsKey(comment);
        if (!news || said.has(key) || !settled(comment)) continue;
        said.add(key);
        if (onNews) {
          onNews(comment.id);
          continue;
        }
        const line = requestLine(comment, status);
        emit(`${line}${hint && !hinted ? ` ${hint}` : ''}\n`);
        hinted = true;
      }
    }
    if (first) {
      first = false;
      if (announce) process.stdout.write(`Listening for AI requests in ${ROOT}.\n`);
    }
    await new Promise((r) => setTimeout(r, LOOK_MS));
  }
}

async function beat() {
  const now = new Date().toISOString();
  const held = (await readJson(AGENT)) || {};
  const mine = held.pid === process.pid;
  await fs.writeFile(AGENT, `${JSON.stringify({
    app: VIA,
    pid: process.pid,
    started_at: mine ? held.started_at : now,
    seen_at: now,
  }, null, 2)}\n`).catch(() => {});
}

/** Shells a hook's command may run through on its way from Claude Code. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh']);

/**
 * Every process's parent and name: from ps, or on Windows from PowerShell
 * (wmic is gone from current Windows). Null when neither answers.
 */
function processTable() {
  const [file, args] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }']]
    : ['ps', ['-A', '-o', 'pid=,ppid=,comm=']];
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 20_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, out) => {
      if (err && !out) return resolve(null);
      const table = new Map();
      for (const line of String(out).split(/\r?\n/)) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        if (!m) continue;
        const name = m[3].split(/[\\/]/).pop().replace(/^-/, '').replace(/\.exe$/i, '').toLowerCase();
        table.set(Number(m[1]), { ppid: Number(m[2]), name });
      }
      resolve(table.size ? table : null);
    });
  });
}

/**
 * The Claude Code process a hook belongs to: the first process above any
 * shells. On a Mac or Linux the shell running a hook's command hands its
 * process over to node, so the hook's parent is Claude Code itself. On
 * Windows it cannot: the shell (Git Bash or PowerShell) stays in between and
 * ends with the hook, which ended the session's listener with each request
 * it woke Claude for, and the bar said Connect while Claude worked
 * (2026-10-30). The hook's own parent when the table cannot be had.
 */
async function sessionOwner(pid = process.ppid) {
  const table = await processTable();
  let at = pid;
  for (let i = 0; table && i < 8; i++) {
    const p = table.get(at);
    if (!p || !SHELLS.has(p.name) || !(p.ppid > 1)) break;
    at = p.ppid;
  }
  return at;
}

let stopping = false;

/**
 * Ends this process as a stop signal would, its cleanup and all. A signal
 * sent to itself would do that on a Mac, but on Windows it ends the process
 * outright, leaving its lock and files behind.
 */
function stopNow() {
  if (stopping) return;
  stopping = true;
  if (process.listenerCount('SIGTERM')) process.emit('SIGTERM', 'SIGTERM');
  else process.exit(0);
}

function onStop(cleanup) {
  const stop = async () => {
    await cleanup().catch(() => {});
    releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
  process.on('exit', releaseLock);
}

async function dropBeat() {
  const held = await readJson(AGENT);
  if (held?.pid === process.pid) await fs.rm(AGENT, { force: true });
}

/** By hand, from .sharedlayers: prints requests until stopped. */
async function listen() {
  if (!takeLock()) {
    process.stdout.write('SharedLayers is already listening in this project (the Claude Code plugin, or another session). Nothing to start.\n');
    return;
  }
  onStop(dropBeat);
  await beat();
  setInterval(() => void beat(), BEAT_MS);
  await watch();
}

/* ------------------------------------------------------------------ */
/* serve: the plugin's listener                                        */
/* ------------------------------------------------------------------ */

/**
 * The SharedLayers extension: the Chrome Web Store's, and the one built for
 * testing with the manifest's key. Nothing else may read or write through the
 * port: a page could otherwise hand Claude instructions.
 */
const EXTENSIONS = new Set([
  'aenobkpkjgdjollnmafnnadpbjcdbgei',
  'joecoihhimdjimenbcbkondieippnpaa',
  ...(process.env.SHAREDLAYERS_EXTENSION_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
]);

/** Where the extension looks for listeners (AGENT_PORTS in src/local/agent-link.ts): the first free one is taken. */
const PORTS = Array.from({ length: 20 }, (_, i) => 47820 + i);
const MAX_BODY = 25 * 1024 * 1024;
const FOLDER = '.sharedlayers';

/**
 * The extension's worker names itself in x-sharedlayers, a header a page can
 * only send to another address after a preflight this never approves (and an
 * img or a script cannot send at all). Chrome adds Origin to the worker's POST,
 * PUT and DELETE but not its GET, so Origin, when there, must be the same
 * extension; and a request Chrome made for a web page says so in
 * sec-fetch-site, which a page cannot set.
 */
function fromExtension(req) {
  const id = String(req.headers['x-sharedlayers'] || '');
  if (!EXTENSIONS.has(id)) return false;
  if (req.headers.origin !== undefined && req.headers.origin !== `chrome-extension://${id}`) return false;
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'none') return false;
  // A page that points its own name at 127.0.0.1 still says its own name here.
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  return host === '127.0.0.1' || host === 'localhost';
}

/** A path the extension names, inside .sharedlayers and nowhere else. */
function inFolder(rel) {
  if (typeof rel !== 'string') return null;
  const parts = rel.split('/');
  if (parts[0] !== FOLDER) return null;
  if (parts.some((p) => !p || p === '.' || p === '..' || p.includes('\\') || p.includes('\0'))) return null;
  return join(PROJECT, ...parts);
}

/** The local ports served by programs started in this project: its dev server. */
let servedCache = { at: 0, ports: [] };
function servedPorts() {
  if (process.env.SHAREDLAYERS_SERVES !== undefined) {
    return Promise.resolve(process.env.SHAREDLAYERS_SERVES.split(',').map(Number).filter(Boolean));
  }
  if (Date.now() - servedCache.at < 15_000 || process.platform === 'win32') return Promise.resolve(servedCache.ports);
  const run = (args) => new Promise((resolve) => {
    execFile('lsof', args, { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err && !out ? '' : String(out)));
  });
  return (async () => {
    const listening = await run(['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']);
    const portsByPid = new Map();
    let pid = 0;
    for (const line of listening.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('n') && pid !== process.pid) {
        const port = Number(line.slice(line.lastIndexOf(':') + 1));
        if (port) portsByPid.set(pid, [...(portsByPid.get(pid) || []), port]);
      }
    }
    const ports = new Set();
    if (portsByPid.size) {
      const cwds = await run(['-a', '-p', [...portsByPid.keys()].join(','), '-d', 'cwd', '-Fpn']);
      for (const line of cwds.split('\n')) {
        if (line.startsWith('p')) pid = Number(line.slice(1));
        else if (line.startsWith('n')) {
          const cwd = line.slice(1);
          if (cwd === PROJECT || cwd.startsWith(PROJECT + sep)) for (const port of portsByPid.get(pid) || []) ports.add(port);
        }
      }
    }
    servedCache = { at: Date.now(), ports: [...ports].sort((a, b) => a - b) };
    return servedCache.ports;
  })();
}

function send(res, status, body, headers = {}) {
  const json = typeof body === 'object' && !(body instanceof Buffer);
  res.writeHead(status, { 'content-type': json ? 'application/json' : 'application/octet-stream', ...headers });
  res.end(json ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function statOf(path) {
  const s = await fs.stat(path);
  return { kind: s.isDirectory() ? 'directory' : 'file', size: s.size, lastModified: Math.round(s.mtimeMs) };
}

/** The extension's calls: who is listening, and the folder's files. */
function handler() {
  return async (req, res) => {
    if (!fromExtension(req)) return send(res, 403, { error: 'Only the SharedLayers extension may use this port.' });
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.searchParams.get('path');
    try {
      if (req.method === 'GET' && url.pathname === '/hello') {
        return send(res, 200, {
          app: VIA,
          version: 1,
          project: basename(PROJECT),
          path: PROJECT,
          serves: await servedPorts(),
        });
      }
      if (!url.pathname.startsWith('/fs/')) return send(res, 404, { error: 'Not found' });
      const at = inFolder(path);
      if (!at) return send(res, 400, { error: `Not a path inside ${FOLDER}: ${path}` });

      if (req.method === 'GET' && url.pathname === '/fs/stat') {
        return send(res, 200, await statOf(at));
      }
      if (req.method === 'GET' && url.pathname === '/fs/list') {
        const entries = await fs.readdir(at, { withFileTypes: true });
        return send(res, 200, entries
          .filter((e) => !e.name.endsWith('.tmp'))
          .map((e) => ({ name: e.name, kind: e.isDirectory() ? 'directory' : 'file' })));
      }
      if (req.method === 'GET' && url.pathname === '/fs/file') {
        const s = await statOf(at);
        if (s.kind !== 'file') return send(res, 409, { error: 'Not a file' });
        return send(res, 200, await fs.readFile(at), { 'x-last-modified': String(s.lastModified) });
      }
      if (req.method === 'POST' && url.pathname === '/fs/dir') {
        await fs.mkdir(at, { recursive: true });
        return send(res, 200, await statOf(at));
      }
      if (req.method === 'PUT' && url.pathname === '/fs/file') {
        const body = await readBody(req);
        await fs.mkdir(dirname(at), { recursive: true });
        await replaceFile(at, body);
        return send(res, 200, await statOf(at));
      }
      if (req.method === 'DELETE' && url.pathname === '/fs/entry') {
        await fs.rm(at, { recursive: url.searchParams.get('recursive') === '1' });
        return send(res, 200, { removed: true });
      }
      return send(res, 405, { error: 'Not allowed' });
    } catch (err) {
      if (err?.code === 'ENOENT') return send(res, 404, { error: 'Not found' });
      if (err?.code === 'ENOTEMPTY' || err?.code === 'EISDIR' || err?.code === 'ENOTDIR') return send(res, 409, { error: err.code });
      return send(res, err?.status || 500, { error: String(err?.message || err) });
    }
  };
}

/** Listens on the first free port of PORTS, or null when all are taken. */
async function openPort(server) {
  for (const port of PORTS) {
    const ok = await new Promise((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (ok) return port;
  }
  return null;
}

/**
 * The plugin's listener, one with every Claude Code session in its project,
 * started by `wake`. Silent until there is a request: a session in a project
 * without SharedLayers never hears from it. Waits, quietly, while another
 * listener holds the project, and takes over when that one stops.
 *
 * With `owner` (the Claude Code process) it ends when the session does, and
 * with `session` it writes each request line to that session's queue, which
 * the session's `wake` hook hands to Claude.
 */
async function serve(project, { owner = null, session = null } = {}) {
  // The plugin passes the project (a hook's command is given
  // ${CLAUDE_PROJECT_DIR}); by hand, it is where this runs.
  useProject(project || process.env.SHAREDLAYERS_PROJECT || process.cwd());
  if (owner) {
    setInterval(() => {
      if (!alive(owner)) stopNow();
    }, OWNER_LOOK_MS);
  }
  const queue = session ? sessionFile(session, 'queue') : null;
  if (session) {
    // The session's wake hook starts another listener only when this one is
    // gone from it: alive, and its file fresh (liveHolder).
    keepFresh(sessionFile(session, 'serve'));
    process.on('exit', () => {
      for (const kind of ['queue', 'offset']) rmSync(sessionFile(session, kind), { force: true });
      if (readPid(sessionFile(session, 'serve')) === process.pid) rmSync(sessionFile(session, 'serve'), { force: true });
    });
  }
  await hold();
  await watch({
    hint: '(SharedLayers: how to handle it is in .sharedlayers/AI.md)',
    announce: false,
    emit: (text) => {
      process.stdout.write(text);
      if (queue) appendFileSync(queue, text);
    },
  });
}

/* ------------------------------------------------------------------ */
/* wake: the plugin's way to Claude                                    */
/* ------------------------------------------------------------------ */

/**
 * The plugin's hook on SessionStart, Stop and StopFailure, run in the
 * background with asyncRewake: Claude Code wakes Claude, idle or not, when a
 * hook like that ends with exit code 2, and shows it what the hook wrote.
 * That works in the terminal and in the desktop app alike, where a plugin's
 * monitors do not run.
 *
 * Each run makes sure the session has its listener (`serve`, detached, gone
 * with the session), then waits for the lines that listener queues for this
 * session and ends with them, waking Claude. The Stop hooks start the next
 * wait after Claude's turn. One wait per session at a time: a run that finds
 * one waiting already ends at once.
 */
async function wake(project) {
  let data = {};
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch { /* no input: by hand */ }
  useProject(project || process.env.CLAUDE_PROJECT_DIR || data.cwd || process.cwd());
  const session = String(data.session_id || 'session').replace(/[^\w-]/g, '').slice(0, 64) || 'session';
  // The Claude Code process of its session: the hook's parent, or above the
  // shell that ran it on Windows.
  const owner = await sessionOwner();

  if (!liveHolder(sessionFile(session, 'serve'))) {
    const listener = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', PROJECT, '--owner', String(owner), '--session', session], {
      detached: true,
      stdio: 'ignore',
    });
    listener.unref();
    writeFileSync(sessionFile(session, 'serve'), String(listener.pid));
  }

  const waiter = sessionFile(session, 'waiter');
  if (liveHolder(waiter, WAITER_STALE_MS)) return;
  writeFileSync(waiter, String(process.pid));
  keepFresh(waiter, WAKE_LOOK_MS);
  const queue = sessionFile(session, 'queue');
  const offsetFile = sessionFile(session, 'offset');
  for (;;) {
    if (!alive(owner)) return;
    let text = '';
    try {
      const all = readFileSync(queue);
      let from = 0;
      try {
        from = Number(readFileSync(offsetFile, 'utf8')) || 0;
      } catch { /* none handed over yet */ }
      if (all.length > from) {
        text = all.subarray(from).toString('utf8');
        writeFileSync(offsetFile, String(all.length));
      }
    } catch { /* nothing queued yet */ }
    if (text.trim()) {
      process.stderr.write(text);
      process.exit(2);
    }
    await new Promise((r) => setTimeout(r, WAKE_LOOK_MS));
  }
}

/**
 * Takes the project, waiting while another listener has it, then opens the
 * port and keeps the heartbeat going until stopped.
 */
async function hold({ waiting = null } = {}) {
  const retry = Number(process.env.SHAREDLAYERS_LOCK_MS) || 5000;
  for (let told = false; !takeLock(); told = true) {
    if (!told) waiting?.();
    await new Promise((r) => setTimeout(r, retry));
  }
  const server = http.createServer(handler());
  const port = await openPort(server);
  if (port === null) {
    process.stderr.write(`SharedLayers: every port from ${PORTS[0]} to ${PORTS[PORTS.length - 1]} is taken; the browser cannot reach this project.\n`);
  }
  onStop(async () => {
    server.close();
    await dropBeat();
  });
  // The heartbeat only where there is a folder already: no .sharedlayers is
  // made in a project that never had a comment.
  setInterval(() => {
    fs.stat(ROOT).then(() => beat(), () => {});
  }, BEAT_MS);
  return port;
}

/**
 * The plugin's SessionStart hook: tells Claude, before anything else, that
 * this project takes requests from the browser, and where the instructions
 * are; and that the other layers' open comments are in the folder, which
 * the connector never sees and a search skips (it ignores itself in git).
 * Nothing at all in a project with neither.
 */
async function context(project) {
  useProject(project || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const layers = await allLayers();
  const ai = layers.some(({ layer }) => layer.workflow_type === 'ai');
  const open = layers
    .filter(({ layer }) => layer.workflow_type !== 'ai')
    .reduce((n, { layer }) => n + layer.comments.filter((c) => c && !c.is_resolved).length, 0);
  const lines = [];
  if (ai) {
    lines.push('This project has a SharedLayers AI layer: the person comments on the running app in their browser, '
      + 'and each comment reaches you as a line from the SharedLayers plugin ("New request <id> …"). You are listening '
      + 'already; do not start another watch. Handle each request as .sharedlayers/AI.md says: '
      + 'node .sharedlayers/ai.mjs working <id>, then show <id>, make the change, then done <id> "<what changed>" or ask <id> "<question>".');
  }
  if (open) {
    lines.push(`This project has ${open} open SharedLayers comment${open === 1 ? '' : 's'} that people left on the app while it ran locally, `
      + 'kept in .sharedlayers/layers/ (one JSON file a layer; .sharedlayers/README.md says how to read and close them). '
      + 'The SharedLayers connector does not list them, and the folder ignores itself in git, so a search skips it. '
      + 'When the person asks about comments, feedback or review notes on the app, read them there.');
  }
  if (!lines.length) return;
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n\n') },
  })}\n`);
}

/* ------------------------------------------------------------------ */
/* The agent's answers                                                 */
/* ------------------------------------------------------------------ */

async function show(ref) {
  const { id, layer, comment } = await findRequest(ref);
  const picture = comment.snapshot_path ? join(ROOT, comment.snapshot_path) : null;
  const images = (comment.attachments || []).map((a) => join(ROOT, 'images', comment.id, a.name));
  process.stdout.write(`${JSON.stringify({
    id: comment.id,
    status: statusOf(comment),
    layer: { id, name: layer.name },
    page: `${comment.page_origin || ''}${comment.page_url || ''}`,
    element: { selector: comment.anchor_selector, label: comment.anchor_element_label },
    text: comment.body,
    ...(comment.spoken ? { spoken: true } : {}),
    picture,
    images,
    replies: (comment.replies || []).map((r) => ({
      from: r.via ? r.via : r.author?.display_name || 'the person',
      text: r.body,
      at: r.created_at,
    })),
  }, null, 2)}\n`);
}

function reply(comment, text) {
  const body = String(text ?? '').trim();
  if (!body) fail('Say it in the text after the id.');
  comment.replies = Array.isArray(comment.replies) ? comment.replies : [];
  // Written for the person who asked, by this app, as the connector does (077).
  comment.replies.push({
    id: randomUUID(),
    body,
    author: comment.author,
    via: VIA,
    created_at: new Date().toISOString(),
    attachments: [],
  });
}

/**
 * Said aloud in talk mode: the request becomes the clean wording, and the words
 * as heard are kept under it (the thread's "Heard:").
 */
async function polish(ref, text) {
  const wording = String(text ?? '').trim();
  if (!wording) fail('Give the clean request after the id.');
  const comment = await changeRequest(ref, (c) => {
    if (!c.heard) c.heard = c.body;
    c.body = wording;
    delete c.spoken;
    c.updated_at = new Date().toISOString();
  });
  process.stdout.write(`${comment.id} now reads: ${wording}\n`);
}

async function changeStatus(ref, status, text) {
  const comment = await changeRequest(ref, (c) => {
    if (c.is_resolved) fail(`Request ${ref} is resolved already.`);
    if (text !== undefined) reply(c, text);
    c.ai_status = status;
    c.ai_status_at = new Date().toISOString();
  });
  // What the pin says beside it while the agent works (progress, below).
  await setProgress(comment.id, status === 'working' ? 'Reading the request' : null).catch(() => {});
  return comment;
}

async function setStatus(ref, status, text) {
  const comment = await changeStatus(ref, status, text);
  process.stdout.write(`${comment.id} is ${status}.\n`);
}

/* ------------------------------------------------------------------ */
/* progress: what the agent is doing, for the pin to say               */
/* ------------------------------------------------------------------ */

/**
 * progress.json beside the layers: for each request being worked on, a few
 * words on what the agent is doing right now ("Editing styles.css"), which
 * the extension shows beside its pin. Written by `working` and by the
 * plugin's PreToolUse hook (`progress`), cleared by `done` and `ask`.
 */
function progressPath() {
  return join(ROOT, 'progress.json');
}

async function setProgress(commentId, label) {
  const all = (await readJson(progressPath())) || {};
  if (label) all[commentId] = { label, at: new Date().toISOString() };
  else delete all[commentId];
  await replaceFile(progressPath(), `${JSON.stringify(all, null, 2)}\n`);
}

/** The few words for one tool call, or null for one not worth saying. */
function toolLabel(tool, input = {}) {
  const path = typeof input.file_path === 'string' ? input.file_path
    : typeof input.notebook_path === 'string' ? input.notebook_path : null;
  // SharedLayers' own files are the request itself, named by ids nobody knows.
  if (path && /(^|[\\/])\.sharedlayers[\\/]/.test(path)) {
    return tool === 'Read'
      ? /[\\/](pictures|images)[\\/]/.test(path) ? 'Looking at the picture' : 'Reading the request'
      : null;
  }
  const name = path ? path.split(/[\\/]/).pop() : null;
  // A name that is an id says nothing to the person: the plain words instead.
  const file = name && !/[0-9a-f]{8}-[0-9a-f]{4}-|^[0-9a-f-]{16,}(\.|$)/i.test(name) ? name : null;
  switch (tool) {
    case 'Read': return file ? `Reading ${file}` : 'Reading the code';
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit':
      return file ? `Editing ${file}` : 'Editing the code';
    case 'Grep': case 'Glob': return 'Searching the code';
    case 'Bash':
      // Its own helper calls are not news: the status they set says it.
      return /\.sharedlayers\/ai\.mjs|scripts\/ai\.mjs/.test(String(input.command || '')) ? null : 'Running a command';
    case 'WebFetch': case 'WebSearch': return 'Looking something up';
    case 'Task': case 'Agent': return 'Thinking it through';
    default: return null;
  }
}

/**
 * The plugin's PreToolUse hook: the tool call arrives as JSON on stdin. Puts
 * its label on the request most recently started, if one is being worked on;
 * otherwise does nothing. Never fails the call it watches.
 */
async function progress() {
  let data = {};
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return;
  }
  useProject(process.env.CLAUDE_PROJECT_DIR || data.cwd || process.cwd());
  const label = toolLabel(data.tool_name, data.tool_input || {});
  if (!label) return;
  let newest = null;
  for (const { layer } of await aiLayers()) {
    for (const c of layer.comments) {
      if (c?.ai_status !== 'working' || c.is_resolved) continue;
      if (!newest || String(c.ai_status_at || '') > String(newest.ai_status_at || '')) newest = c;
    }
  }
  if (newest) await setProgress(newest.id, label).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* codex, copilot: an AI run on each request                           */
/* ------------------------------------------------------------------ */

/**
 * Codex, GitHub Copilot and Cursor cannot be woken from outside while they
 * sit open, so `ai.mjs codex`, `copilot` and `cursor` run them once per
 * request instead:
 * in the project, with what was asked and the page picture, continuing the
 * same conversation for the next one, so they remember the earlier ones. One
 * at a time, oldest first. Each works on the person's own sign-in or key, in
 * its own sandbox: it may change files in the project and nothing outside it.
 * It answers with this script's done or ask, as AI.md says; if it ends
 * without either, its last message is the answer, and if it fails, the
 * person is told why and can reply to try again.
 *
 * What differs between the apps is in AGENTS: how a turn is started, and how
 * the events it prints (one JSON object a line) are read into the turn.
 */

/** Runs a short command and gives back its exit code and output, never throwing. */
function runShort(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 20_000 }, (err, out, errOut) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, missing: err?.code === 'ENOENT', out: String(out), err: String(errOut) });
    });
  });
}

/** The few words for a shell command an AI runs, or null for its calls to this script. */
function commandLabel(command) {
  const text = String(command || '');
  if (/\.sharedlayers\/ai\.mjs/.test(text)) return null;
  // Codex runs each command through a shell: bash -lc '…'.
  const inner = text.replace(/^\S*?(ba|z)?sh\s+-l?c\s+/, '').replace(/^['"]|['"]$/g, '').trim();
  const [word, ...rest] = inner.split(/\s+/);
  if (['rg', 'grep', 'find', 'fd', 'ls', 'tree'].includes(word)) return 'Searching the code';
  if (['cat', 'sed', 'head', 'tail', 'nl', 'bat', 'less', 'git'].includes(word)) {
    const file = rest.reverse().find((w) => !w.startsWith('-') && /\.[a-z0-9]+['"]?$/i.test(w));
    return toolLabel('Read', { file_path: file?.replace(/^['"]|['"]$/g, '') });
  }
  return 'Running a command';
}

/**
 * Each app: its name (as its replies are marked), the command, how to
 * install and sign in, a check before starting, how a turn starts (setting
 * turn.thread when it is known then), and read(event, turn), which notes what
 * the event says in the turn and returns a label for the pin, or null.
 */
const AGENTS = {
  /**
   * OpenAI's Codex CLI: `codex exec` with the prompt on stdin, in its
   * workspace-write sandbox, then `codex exec resume <thread>`. Events:
   * thread.started, turn.started, item.started (command_execution,
   * file_change, web_search), item.completed (agent_message),
   * turn.completed, turn.failed, error.
   */
  codex: {
    name: 'Codex',
    bin: process.env.SHAREDLAYERS_CODEX || 'codex',
    install: 'npm install -g @openai/codex',
    login: 'codex login',
    async ready() {
      const login = await runShort(this.bin, ['login', 'status']);
      if (login.code !== 0) fail('Codex is not signed in. Run: codex login\nThen start this again.');
    },
    start(turn, images, prompt) {
      const pictures = images.flatMap((p) => ['-i', p]);
      const args = turn.thread
        ? ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', ...pictures, turn.thread, '-']
        : ['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '-C', PROJECT, ...pictures];
      return { args, input: prompt };
    },
    read(e, turn) {
      if (e.type === 'thread.started' && e.thread_id) turn.thread = e.thread_id;
      else if (e.type === 'turn.started') turn.started = true;
      else if (e.type === 'turn.completed') turn.ok = true;
      else if (e.type === 'turn.failed') turn.error = e.error?.message || 'the turn failed';
      // Retries say so as they go; only the last word counts.
      else if (e.type === 'error' && !/^Reconnecting/.test(String(e.message))) turn.error = e.message;
      else if (e.type === 'item.completed' && e.item?.type === 'agent_message' && e.item.text) turn.message = e.item.text;
      else if ((e.type === 'item.started' || e.type === 'item.updated') && e.item) {
        const item = e.item;
        if (item.type === 'file_change') return toolLabel('Edit', { file_path: item.changes?.[0]?.path });
        if (item.type === 'command_execution') return commandLabel(item.command);
        if (item.type === 'web_search') return 'Looking something up';
      }
      return null;
    },
    opens: (thread) => `codex resume ${thread}`,
  },

  /**
   * GitHub Copilot CLI: `copilot -p` with --session-id, which starts that
   * session the first time and continues it after, and --allow-all-tools,
   * which it needs with nobody there to ask, inside its --sandbox. Events:
   * user.message, tool.execution_start (bash, view, edit, create, grep,
   * glob…), assistant.message, session.error, result (with exitCode).
   */
  copilot: {
    name: 'Copilot',
    bin: process.env.SHAREDLAYERS_COPILOT || 'copilot',
    install: 'npm install -g @github/copilot',
    login: 'copilot login',
    // Copilot cannot be asked whether it is signed in; the first request says so if not.
    async ready() {},
    start(turn, images, prompt) {
      if (!turn.thread) turn.thread = randomUUID();
      return {
        args: [
          '-p', prompt, '--output-format', 'json', '--session-id', turn.thread, '-C', PROJECT,
          '--allow-all-tools', '--sandbox', '--no-ask-user', ...images.flatMap((p) => ['--attachment', p]),
        ],
        input: null,
      };
    },
    read(e, turn) {
      const data = e.data || {};
      if (e.type === 'user.message' || e.type === 'assistant.turn_start') turn.started = true;
      else if (e.type === 'assistant.message' && typeof data.content === 'string' && data.content.trim()) turn.message = data.content;
      else if (e.type === 'session.error') turn.error = data.message || 'the session failed';
      else if (e.type === 'result') turn.ok = e.exitCode === 0;
      else if (e.type === 'tool.execution_start') {
        const args = data.arguments || {};
        switch (data.toolName) {
          case 'bash': case 'powershell': return commandLabel(args.command);
          case 'view': return toolLabel('Read', { file_path: args.path });
          case 'edit': case 'create': return toolLabel('Edit', { file_path: args.path });
          case 'grep': case 'glob': return 'Searching the code';
          case 'web_fetch': case 'web_search': return 'Looking something up';
          case 'task': return 'Thinking it through';
          default: return null;
        }
      }
      return null;
    },
    opens: (thread) => `copilot --resume ${thread}`,
  },

  /**
   * Cursor's CLI (cursor-agent, also installed as `agent`): `-p` with the
   * prompt, --output-format stream-json, --force (commands run without a
   * person to ask) inside --sandbox enabled, --trust for the workspace, then
   * --resume <session> for the next request. Events, as Cursor documents them
   * (cursor.com/docs/cli/reference/output-format): system (init, with
   * session_id), user, assistant, tool_call started/completed keyed by tool
   * (readToolCall, writeToolCall, …), result (is_error). A failure ends
   * without a result and exits non-zero.
   */
  cursor: {
    name: 'Cursor',
    bin: process.env.SHAREDLAYERS_CURSOR || 'cursor-agent',
    install: 'curl https://cursor.com/install -fsS | bash',
    login: 'cursor-agent login',
    // Signed in with `login`, or by CURSOR_API_KEY; its status says which.
    async ready() {
      if (process.env.CURSOR_API_KEY) return;
      const status = await runShort(this.bin, ['status']);
      if (status.code !== 0) fail('Cursor is not signed in. Run: cursor-agent login\nThen start this again.');
    },
    start(turn, _images, prompt) {
      return {
        args: [
          '-p', '--output-format', 'stream-json', '--force', '--trust', '--sandbox', 'enabled', '--workspace', PROJECT,
          ...(turn.thread ? ['--resume', turn.thread] : []), prompt,
        ],
        input: null,
      };
    },
    read(e, turn) {
      if (e.type === 'system' && e.subtype === 'init') {
        turn.started = true;
        if (e.session_id) turn.thread = e.session_id;
      } else if (e.type === 'assistant') {
        const text = (e.message?.content || []).map((p) => p?.text || '').join('').trim();
        if (text) turn.message = text;
      } else if (e.type === 'result') {
        turn.ok = !e.is_error;
        if (typeof e.result === 'string' && e.result.trim()) turn.message = e.result.trim();
        if (e.is_error) turn.error = e.result || 'the turn failed';
      } else if (e.type === 'tool_call' && e.subtype === 'started' && e.tool_call) {
        const [kind, call] = Object.entries(e.tool_call)[0] || [];
        const args = call?.args || {};
        if (kind === 'function') return null;
        if (/read/i.test(kind)) return toolLabel('Read', { file_path: args.path });
        if (/write|edit|delete/i.test(kind)) return toolLabel('Edit', { file_path: args.path });
        if (/shell|terminal|command/i.test(kind)) return commandLabel(args.command);
        if (/grep|glob|search|ls|find/i.test(kind)) return 'Searching the code';
      }
      return null;
    },
    opens: (thread) => `cursor-agent --resume ${thread}`,
  },
};

/** When the AI last started on each request: a reply after that is news to it. */
const turnStarted = new Map();

/** Whether a request waits for the AI: sent, never finished, or replied to while it was on it. */
function waitsForAgent(comment) {
  const status = statusOf(comment);
  if (status === 'sent' || status === 'working') return true;
  if (status === 'resolved') return false;
  const mine = personReplies(comment);
  const last = mine[mine.length - 1];
  return !!last && Date.parse(last.created_at) > (turnStarted.get(comment.id) ?? Infinity);
}

/** What the AI is told: the request in a line, and how to answer it. */
function agentPrompt(comment) {
  const id = comment.id;
  return [
    // Working already, before the AI was ever on it here: left unfinished by an earlier run.
    requestLine(comment, statusOf(comment) === 'working' ? 'working' : 'sent'),
    '',
    'This came from the person\'s browser: a comment on their running app, left with SharedLayers.',
    `Handle it as .sharedlayers/AI.md says under "For each request": run node .sharedlayers/ai.mjs show ${id} for all of it,`,
    'make the change in this project, then answer in the thread with',
    `node .sharedlayers/ai.mjs done ${id} "<what you changed, in a sentence>"`,
    `or, when you need the person first, node .sharedlayers/ai.mjs ask ${id} "<your question>".`,
    'It is marked as being worked on already. Do not start a listener: SharedLayers hands you each request as it comes.',
  ].join('\n');
}

/** The pictures worth attaching: the page as it looked, and the person's images, on a new request only. */
async function requestImages(comment) {
  if (statusOf(comment) !== 'sent' || personReplies(comment).length) return [];
  const paths = [
    comment.snapshot_path ? join(ROOT, comment.snapshot_path) : null,
    ...(comment.attachments || []).map((a) => (a?.name ? join(ROOT, 'images', comment.id, a.name) : null)),
  ].filter(Boolean);
  const there = await Promise.all(paths.map((p) => fs.stat(p).then((s) => s.isFile(), () => false)));
  return paths.filter((_, i) => there[i]);
}

/**
 * One turn of the AI on a request. `state.thread` is the conversation while
 * this runs: each request after the first continues it. Resolves with how it
 * ended: { ok, message, error }. A conversation that cannot be continued
 * (deleted, say) is started again, once.
 */
function agentTurn(agent, state, id, prompt, images) {
  const resuming = state.thread;
  const turn = { thread: state.thread, started: false, ok: false, error: null, message: null };
  const { args, input } = agent.start(turn, images, prompt);
  return new Promise((resolve) => {
    const child = spawn(agent.bin, args, {
      cwd: PROJECT,
      env: { ...process.env, SHAREDLAYERS_VIA: agent.name },
      stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    let errOut = '';
    let label = null;
    // One write after another, so the newest label is the one left.
    let writing = Promise.resolve();
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        const next = agent.read(e, turn);
        if (next && next !== label) {
          label = next;
          writing = writing.then(() => setProgress(id, next)).catch(() => {});
        }
      }
    });
    child.stderr.on('data', (chunk) => { errOut = (errOut + String(chunk)).slice(-4000); });
    child.on('error', (err) => resolve({ ok: false, error: String(err?.message || err) }));
    child.on('close', async (code) => {
      await writing;
      if (resuming && !turn.started) {
        state.thread = null;
        resolve(agentTurn(agent, state, id, prompt, images));
        return;
      }
      state.thread = turn.thread;
      const last = errOut.trim().split('\n').filter((l) => !/^\d{4}-\d\d-\d\dT.*\b(ERROR|WARN|INFO)\b/.test(l)).pop();
      resolve(turn.ok && code === 0
        ? { ok: true, message: turn.message }
        : { ok: false, message: turn.message, error: turn.error || last || `${agent.name} stopped (exit ${code})` });
    });
    if (input != null) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

/** Says something in the terminal this runs in. */
function say(line) {
  process.stdout.write(`${line}\n`);
}

/** The AI's error in a sentence the person can act on. */
function plainError(agent, error) {
  const text = oneLine(error, 300);
  if (/401|unauthori[sz]ed|not logged in|not signed in|sign in|authenticat/i.test(text)) {
    return `${agent.name} is not signed in. Run ${agent.login} in a terminal`;
  }
  return text.replace(/[.\s]+$/, '');
}

/** The AI on one request, from taking it to its answer. */
async function agentOn(agent, state, id) {
  const found = await findRequest(id).catch(() => null);
  if (!found || !waitsForAgent(found.comment)) return;
  const { comment } = found;
  const images = await requestImages(comment);
  const prompt = agentPrompt(comment);
  say(`→ ${oneLine(latestWord(comment).text, 72) || '(an image)'}  [${id.slice(0, 8)}]`);
  turnStarted.set(id, Date.now());
  try {
    await changeStatus(id, 'working');
  } catch {
    return;
  }
  const before = state.thread;
  const result = await agentTurn(agent, state, id, prompt, images);
  if (state.thread && state.thread !== before) {
    say(`  ${agent.name} conversation ${state.thread} (${agent.opens(state.thread)} opens it)`);
  }
  const after = (await findRequest(id).catch(() => null))?.comment;
  await setProgress(id, null).catch(() => {});
  if (!after) return;
  const status = statusOf(after);
  if (status === 'working') {
    // It ended without answering in the thread: its last words, or why it stopped.
    if (result.ok) {
      await changeStatus(id, 'done', result.message || 'Done. Check the page.').catch(() => {});
      say('  ✓ Done');
    } else {
      const why = plainError(agent, result.error);
      await changeStatus(id, 'question', `${agent.name} stopped before finishing: ${why}. Reply here to send this to it again.`).catch(() => {});
      say(`  ✗ ${why}`);
    }
  } else if (status === 'done') say('  ✓ Done');
  else if (status === 'question') say('  ? Asked a question');
}

/**
 * By hand, in the project: the listener, with Codex, Copilot or Cursor doing
 * the work. Leave it running, as a dev server; Ctrl-C stops it.
 */
async function runAgent(kind, project) {
  const agent = AGENTS[kind];
  VIA = agent.name;
  useProject(project || process.env.SHAREDLAYERS_PROJECT || process.cwd());
  const version = await runShort(agent.bin, ['--version']);
  if (version.missing) fail(`${agent.name} is not installed. Install it with: ${agent.install}\nThen sign in with: ${agent.login}`);
  if (version.code !== 0) fail(`${agent.name} did not start: ${(version.err || version.out).trim()}`);
  await agent.ready();
  await hold({
    waiting: () => say('Another listener has this project (Claude Code with the SharedLayers plugin, or another terminal). Waiting for it to stop…'),
  });
  const named = version.out.trim().split('\n')[0].replace(/\.$/, '');
  say(`SharedLayers: comments in ${basename(PROJECT)}'s AI layers go to ${agent.name} (${named}). Keep this running; Ctrl-C stops it.`);
  const state = { thread: null };
  const queue = [];
  let busy = false;
  const next = async () => {
    if (busy) return;
    busy = true;
    while (queue.length) await agentOn(agent, state, queue.shift()).catch((err) => say(`  ✗ ${String(err?.message || err)}`));
    busy = false;
  };
  await watch({
    announce: false,
    onNews: (id) => {
      if (!queue.includes(id)) queue.push(id);
      void next();
    },
  });
}

/** What went wrong in a command, said to whoever ran it. Thrown, so `codex`, `copilot` and `cursor` go on to the next request. */
class Refusal extends Error {}

function fail(message) {
  throw new Refusal(message);
}

const [command, ref, ...words] = process.argv.slice(2);
const text = words.join(' ');

/** serve's --owner <pid> and --session <id>, as wake starts it. */
function serveOptions(args) {
  const value = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return { owner: Number(value('--owner')) || null, session: value('--session') || null };
}

try {
  switch (command) {
    case 'listen': await listen(); break;
    case 'serve': await serve(ref, serveOptions(words)); break;
    case 'wake': await wake(ref); break;
    case 'codex': await runAgent('codex', ref); break;
    case 'copilot': await runAgent('copilot', ref); break;
    case 'cursor': await runAgent('cursor', ref); break;
    case 'context': await context(ref); break;
    case 'progress': await progress().catch(() => {}); break;
    case 'show': await show(ref); break;
    case 'working': await setStatus(ref, 'working'); break;
    case 'done': await setStatus(ref, 'done', text); break;
    case 'ask': await setStatus(ref, 'question', text); break;
    case 'polish': await polish(ref, text); break;
    default:
      fail('Commands: listen | show <id> | working <id> | polish <id> <clean request> | done <id> <what changed> | ask <id> <question> | serve | wake | codex | copilot | cursor');
  }
} catch (err) {
  if (!(err instanceof Refusal)) throw err;
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
}
