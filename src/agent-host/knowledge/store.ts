// The host's side of the code index: one worker per project folder, started when a search first
// names it, and the file list the host enumerates for the worker, which only stats, reads and
// writes. The index is derived data: a root that is gone, or a worker that fails, answers with
// nothing rather than an error.

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Worker } from 'node:worker_threads'
import type { Platform } from '@shared/platform'
import { GIT_TIMEOUT_MS, type Exec, type ExecResult } from '../git/exec'
import { canonicalizePath, pathKey } from '../paths'
import { writeFileAtomic, type LogFn } from '../storage'
import { INDEX_FILE, type BuildProgress } from './index'
import type {
  CodeSearchAnswer,
  KnowledgeReply,
  KnowledgeRequest,
  KnowledgeWorkerData,
  ScanFile,
} from './protocol'
import { SCAN_AFTER_MS, type ScannerOptions } from './scan'

/** What the store needs of a worker, so tests can run the service in their own thread. */
export interface KnowledgeWorker {
  postMessage(request: KnowledgeRequest): void
  onMessage(listener: (reply: KnowledgeReply) => void): void
  /** Called once when the worker stops, with the error that stopped it, if any. */
  onExit(listener: (error: Error | null) => void): void
  terminate(): Promise<unknown>
}

export type KnowledgeWorkerFactory = (
  data: KnowledgeWorkerData,
  /** The scanner's timings; only a test's in-thread worker can take them. */
  scanning?: Partial<ScannerOptions>,
) => KnowledgeWorker

export function nodeKnowledgeWorker(worker: Worker): KnowledgeWorker {
  return {
    postMessage: (request) => worker.postMessage(request),
    onMessage: (listener) => worker.on('message', listener),
    onExit: (listener) => {
      let failure: Error | null = null
      worker.on('error', (error) => {
        failure = error
      })
      worker.on('exit', (code) =>
        listener(failure ?? (code === 0 ? null : new Error(`exited with code ${code}`))),
      )
    },
    terminate: () => worker.terminate(),
  }
}

// How many project indexes stay open; beyond that, the least recently used worker is closed.
const MAX_OPEN_SLOTS = 3
// git ls-files of a repository with hundreds of thousands of files can pass the default buffer.
const GIT_MAX_BUFFER = 64 * 1024 * 1024
// The walk's bounds when git cannot answer: no interface waits behind it, so they are the disk's.
const WALK_FILES = 200_000
const WALK_DEPTH = 30
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['.git', 'node_modules'])
// Paths the host stats at once while it builds the list it hands the worker.
const STAT_BATCH = 50
// How long closing a worker waits for it to fold the WAL before stopping it.
const CLOSE_TIMEOUT_MS = 2_000
// What a search answers with when it cannot answer: the index is derived, so nothing is fatal.
const SEARCH_LIMIT = 50

export interface KnowledgeStoreOptions {
  /** The folder the indexes live in, `<userData>/knowledge`. */
  dataPath: string
  platform: Platform
  /** Runs git with the agent environment; the walk takes over when git cannot answer. */
  exec: Exec
  /** Waited for before git runs, so git is found as the agents find it. */
  env: { ready(): Promise<void> }
  createWorker: KnowledgeWorkerFactory
  log: LogFn
  /** The scanner's timings, for tests; only an in-thread worker can take them. */
  scanTimings?: Partial<ScannerOptions>
  now?: () => number
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never
type Request = WithoutId<KnowledgeRequest>

/** One worker, the folder's index it owns, and the requests it has yet to answer. */
interface Slot {
  key: string
  worker: KnowledgeWorker
  pending: Map<number, Pending>
  /** A build was under way as the last reply said; such a slot is never closed to make room. */
  building: boolean
  /** Replaced, closed or stopped by the store, so its exit is no failure. */
  retired: boolean
  lastUse: number
}

/** `<basename>-<12 hex of the path key's SHA-256>`, the memory service's naming scheme. */
function dirNameOf(root: string, platform: Platform): string {
  const key = pathKey(root, platform)
  const paths = platform === 'win32' ? path.win32 : path.posix
  const base = paths
    .basename(root)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 40)
  return `${base || 'project'}-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`
}

function noAnswer(): CodeSearchAnswer {
  return { matches: [], capped: false, indexing: null }
}

/** Whether a command ran to its end and succeeded. */
function ran(result: ExecResult): boolean {
  return result.failure === null && result.code === 0
}

/** A path whose stat failed with ENOENT or ENOTDIR is gone. */
function isGone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export class KnowledgeStore {
  private readonly paths: path.PlatformPath
  private readonly slots = new Map<string, Slot>()
  /** Each folder's file list, as it was enumerated and when. */
  private readonly lists = new Map<string, { files: ScanFile[]; at: number }>()
  private nextId = 1
  private closing: Promise<void> | null = null

  constructor(private readonly options: KnowledgeStoreOptions) {
    this.paths = options.platform === 'win32' ? path.win32 : path.posix
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /**
   * The lines of the folder's files that hold every word of `query`. A folder that is not on
   * disk answers with nothing, and so does a worker that fails twice: the index is derived.
   */
  async search(
    folder: string,
    query: string,
    opts: { glob?: string; limit?: number } = {},
  ): Promise<CodeSearchAnswer> {
    if (this.closing) return noAnswer()
    let root: string
    try {
      if (!(await stat(folder)).isDirectory()) throw new Error('not a folder')
      root = await canonicalizePath(folder, this.options.platform, realpath)
    } catch {
      this.options.log(
        'info',
        `The code index was asked for a folder that is not on disk: ${folder}`,
      )
      return noAnswer()
    }
    try {
      return await this.ask(root, query, opts)
    } catch (error) {
      this.options.log('warn', `A code search failed, trying again: ${(error as Error).message}`)
    }
    try {
      return await this.ask(root, query, opts)
    } catch (error) {
      this.options.log('warn', `A code search failed: ${(error as Error).message}`)
      return noAnswer()
    }
  }

  private async ask(
    root: string,
    query: string,
    opts: { glob?: string; limit?: number },
  ): Promise<CodeSearchAnswer> {
    const slot = await this.slot(root)
    try {
      const files = await this.filesFor(root)
      const progress = await this.send<BuildProgress | null>(slot, { op: 'ensure', files })
      slot.building = progress !== null
      const answer = await this.send<CodeSearchAnswer>(slot, {
        op: 'search',
        query,
        ...(opts.glob !== undefined ? { glob: opts.glob } : {}),
        limit: opts.limit ?? SEARCH_LIMIT,
      })
      slot.building = answer.indexing !== null
      return answer
    } catch (error) {
      this.retire(slot)
      throw error
    }
  }

  /** The folder's worker, started when a search first names the folder. */
  private async slot(root: string): Promise<Slot> {
    if (this.closing) throw new Error('The knowledge store is closed')
    const key = pathKey(root, this.options.platform)
    const held = this.slots.get(key)
    if (held) {
      held.lastUse = this.now()
      return held
    }
    const dir = path.join(this.options.dataPath, dirNameOf(root, this.options.platform))
    await mkdir(dir, { recursive: true })
    // The claim the sweep reads: a folder whose root is gone is removed whole.
    const claim = path.join(dir, 'project.json')
    if ((await stat(claim).catch(() => null)) === null) {
      await writeFileAtomic(claim, `${JSON.stringify({ version: 1, path: root }, null, 2)}\n`)
    }
    const slot = this.spawn(key, { root, file: path.join(dir, INDEX_FILE) })
    this.slots.set(key, slot)
    this.trim()
    return slot
  }

  private spawn(key: string, data: KnowledgeWorkerData): Slot {
    const slot: Slot = {
      key,
      worker: this.options.createWorker(data, this.options.scanTimings),
      pending: new Map(),
      building: false,
      retired: false,
      lastUse: this.now(),
    }
    slot.worker.onMessage((reply) => {
      switch (reply.type) {
        case 'ready':
          break
        case 'log':
          this.options.log(reply.level, `Code index: ${reply.message}`)
          break
        case 'result':
          this.settle(slot, reply.id)?.resolve(reply.value)
          break
        case 'error':
          this.settle(slot, reply.id)?.reject(new Error(reply.message))
          break
      }
    })
    slot.worker.onExit((error) => {
      if (slot.retired) return
      slot.retired = true
      this.slots.delete(slot.key)
      const reason = `The knowledge worker stopped${error ? `: ${error.message}` : ''}`
      this.options.log('warn', reason)
      this.fail(slot, new Error(reason))
    })
    return slot
  }

  /** Closes workers until the cap holds again; one whose build is under way stays open. */
  private trim(): void {
    while (this.slots.size > MAX_OPEN_SLOTS) {
      let idle: Slot | null = null
      for (const slot of this.slots.values()) {
        if (slot.retired || slot.building || slot.pending.size > 0) continue
        if (idle === null || slot.lastUse < idle.lastUse) idle = slot
      }
      if (idle === null) return
      this.retire(idle)
    }
  }

  /** Takes a slot out of use: its requests fail, and its worker closes and stops. */
  private retire(slot: Slot): void {
    if (slot.retired) return
    slot.retired = true
    this.slots.delete(slot.key)
    this.fail(slot, new Error('The knowledge worker was replaced'))
    void this.closeWorker(slot)
  }

  /** Sends `close`, waits at most `CLOSE_TIMEOUT_MS` for it, then stops the worker. */
  private async closeWorker(slot: Slot): Promise<void> {
    const closed = this.send<null>(slot, { op: 'close' }).catch((error: unknown) => {
      this.options.log('warn', `Closing a code index failed: ${(error as Error).message}`)
    })
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), CLOSE_TIMEOUT_MS)
    })
    const outcome = await Promise.race([closed, timeout])
    if (timer) clearTimeout(timer)
    if (outcome === 'timeout') {
      this.options.log('warn', 'A code index did not close in time; stopping its worker')
    }
    await slot.worker.terminate()
  }

  /** Stops every worker, folding each index's WAL into its file first. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      const slots = [...this.slots.values()]
      this.slots.clear()
      for (const slot of slots) {
        slot.retired = true
        this.fail(slot, new Error('The knowledge store is closed'))
      }
      await Promise.all(slots.map((slot) => this.closeWorker(slot)))
    })()
    return this.closing
  }

  private settle(slot: Slot, id: number): Pending | undefined {
    const pending = slot.pending.get(id)
    slot.pending.delete(id)
    return pending
  }

  private fail(slot: Slot, error: Error): void {
    for (const pending of slot.pending.values()) pending.reject(error)
    slot.pending.clear()
  }

  private send<T>(slot: Slot, request: Request): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      slot.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      slot.worker.postMessage({ ...request, id } as KnowledgeRequest)
    })
  }

  /**
   * The folder's files for the worker: enumerated again only once the list is older than the
   * scan's threshold, since a worker that scanned within it skips the ensure anyway.
   */
  private async filesFor(root: string): Promise<ScanFile[]> {
    const key = pathKey(root, this.options.platform)
    const held = this.lists.get(key)
    if (held && this.now() - held.at < SCAN_AFTER_MS) return held.files
    const files = await this.enumerate(root)
    this.lists.set(key, { files, at: this.now() })
    return files
  }

  /** Lists the folder's files: git's when it is a repository, a bounded walk when it is not. */
  private async enumerate(root: string): Promise<ScanFile[]> {
    await this.options.env.ready()
    const [listed, deleted] = await Promise.all([
      this.git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
      this.git(root, ['ls-files', '-z', '--deleted']),
    ])
    if (ran(listed) && ran(deleted)) {
      // Without the deleted, a file the index still tracks stays listed after it leaves the disk.
      const gone = new Set(deleted.stdout.split('\0'))
      // A nested repository is listed as a folder, with a trailing slash.
      const paths = [
        ...new Set(
          listed.stdout.split('\0').filter((p) => p !== '' && !p.endsWith('/') && !gone.has(p)),
        ),
      ]
      return this.statFiles(root, paths)
    }
    return this.walk(root)
  }

  private git(root: string, args: readonly string[]): Promise<ExecResult> {
    return this.options.exec('git', ['-c', 'core.quotepath=off', ...args], {
      cwd: root,
      timeoutMs: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    })
  }

  /**
   * Stats the paths the list named, as the worker's list takes them. A path the host cannot
   * stat is left out, so the scan drops its row: it is not on disk as far as the host can tell.
   */
  private async statFiles(root: string, paths: readonly string[]): Promise<ScanFile[]> {
    const files: ScanFile[] = []
    for (let at = 0; at < paths.length; at += STAT_BATCH) {
      const found = await Promise.all(
        paths.slice(at, at + STAT_BATCH).map(async (relative) => {
          try {
            const info = await stat(this.paths.join(root, relative))
            if (!info.isFile()) return null
            return { path: relative, size: info.size, mtime: info.mtimeMs }
          } catch {
            return null
          }
        }),
      )
      for (const file of found) if (file !== null) files.push(file)
    }
    return files
  }

  /**
   * The folder's files when git cannot answer: breadth-first, `.git` and `node_modules` left
   * out, stopped at `WALK_FILES` files and `WALK_DEPTH` levels. Only the root must be readable;
   * a folder that is not stops that branch.
   */
  private async walk(root: string): Promise<ScanFile[]> {
    const paths: string[] = []
    let level = ['']
    for (let depth = 0; level.length > 0 && depth <= WALK_DEPTH; depth++) {
      const next: string[] = []
      for (const directory of level) {
        let entries
        try {
          entries = await readdir(this.paths.join(root, directory), { withFileTypes: true })
        } catch (error) {
          // Only the project folder itself must be readable.
          if (directory === '') throw error
          continue
        }
        for (const entry of entries) {
          const relative = directory === '' ? entry.name : `${directory}/${entry.name}`
          if (entry.isDirectory()) {
            if (!SKIPPED_DIRECTORIES.has(entry.name) && paths.length < WALK_FILES) {
              next.push(relative)
            }
            continue
          }
          // A symbolic link to a folder is not followed; one to a file is a file.
          const isFile =
            entry.isFile() || (entry.isSymbolicLink() && (await this.linksToFile(root, relative)))
          if (!isFile) continue
          if (paths.length >= WALK_FILES) return this.statFiles(root, paths)
          paths.push(relative)
        }
      }
      level = next
    }
    return this.statFiles(root, paths)
  }

  private async linksToFile(root: string, relative: string): Promise<boolean> {
    try {
      return (await stat(this.paths.join(root, relative))).isFile()
    } catch {
      return false
    }
  }

  /**
   * Removes the index folders whose claimed root is gone: the index is derived, and a temporary
   * worktree would otherwise leave a whole one behind. Nothing here is fatal; one folder that
   * cannot be checked stops nothing.
   */
  async prune(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.options.dataPath)
    } catch {
      return
    }
    for (const name of names) {
      const dir = path.join(this.options.dataPath, name)
      try {
        if (!(await stat(dir)).isDirectory()) continue
        const text = await readFile(path.join(dir, 'project.json'), 'utf8')
        const record = JSON.parse(text) as { version?: unknown; path?: unknown }
        if (record.version !== 1 || typeof record.path !== 'string') continue
        try {
          await stat(record.path)
        } catch (error) {
          if (!isGone(error)) continue
          await rm(dir, { recursive: true, force: true })
          this.options.log(
            'info',
            `Removed the code index of a folder that is gone: ${record.path}`,
          )
        }
      } catch (error) {
        this.options.log(
          'warn',
          `Could not sweep the code index folder ${name}: ${(error as Error).message}`,
        )
      }
    }
  }
}
