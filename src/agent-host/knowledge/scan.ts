// The scan that keeps the code index in step with the project's files, in the worker that owns
// the index: the host enumerates the files, the scan stats, reads and hashes what changed, a
// batch at a time between the worker's other requests. Failures are not fatal: a file that
// cannot be read is skipped with a log, and the next scan tries it again.
// Modeled on ../search/indexer.ts; the two evolve apart.

import { createHash } from 'node:crypto'
import { open, realpath, stat, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import { readBytes } from '../files'
import { pathKey } from '../paths'
import {
  isIndexDamaged,
  mtimeOf,
  type BuildProgress,
  CodeIndex,
  type FileUpsert,
  type IndexLog,
  type StatUpdate,
} from './index'
import type { ScanFile } from './protocol'

const PLATFORM = process.platform as Platform
const paths = PLATFORM === 'win32' ? path.win32 : path.posix

// How long after one scan ended the next ensure starts another. The disk is the authority, so a
// scan is a full reconciliation, but stat'ing every file is not worth doing on every search.
export const SCAN_AFTER_MS = 30_000
// A scan of fewer files than this is not announced: it is a few files that changed.
const ANNOUNCE_FROM = 5
// The same prefix git looks at to call a file binary.
const BINARY_PROBE_BYTES = 8_000
const MAX_FILE_BYTES = 1024 * 1024

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export interface ScannerOptions {
  /** The rest between two batches. */
  sliceRestMs?: number
  /** Files per batch; each batch commits its own transaction. */
  batchFiles?: number
  /** Called whenever a scan has nothing left to do; for tests. */
  onIdle?: () => void
  /** Called for every file read whole; for tests. */
  onRead?: (path: string) => void
  /** The clock, for tests. */
  now?: () => number
}

/** A file to read again: its path with the size and mtime the scan's stat just saw. */
interface ToRead {
  path: string
  size: number
  mtime: number
}

/** A path whose stat failed with ENOENT or ENOTDIR is gone. */
function isGone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function errorText(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code ?? (error instanceof Error ? error.message : String(error))
}

export class Scanner {
  private working = false
  private again = false
  private stopped = false
  private pending: readonly ScanFile[] = []
  private readonly root: string

  constructor(
    private index: CodeIndex,
    private readonly file: string,
    private readonly log: IndexLog,
    private readonly options: ScannerOptions = {},
  ) {
    this.root = index.root
  }

  /** The index, for reads while this worker is the one answering. */
  current(): CodeIndex {
    return this.index
  }

  stop(): void {
    this.stopped = true
    this.index.close()
  }

  /**
   * Makes the index match the host's list of the project's files, and answers with the progress
   * of the scan it kicked or of the one under way, at once: while a scan runs a second ensure
   * only marks its list for the scan's next pass, and when the last scan ended too recently it
   * answers with what the index says and scans nothing.
   */
  ensure(files: readonly ScanFile[]): BuildProgress | null {
    if (this.stopped) return null
    this.pending = files
    if (this.working) {
      this.again = true
      return this.index.build()
    }
    const last = this.index.lastScan()
    if (last !== null && this.now() - last < SCAN_AFTER_MS) return this.index.build()
    // A search before the first scan has to know the index is still to be built.
    if (this.index.count() === 0 && files.length > 0) {
      this.index.setBuild({ done: 0, total: files.length })
    }
    void this.run()
    return this.index.build()
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private async run(): Promise<void> {
    if (this.stopped) return
    this.working = true
    try {
      do {
        this.again = false
        await this.scan(this.pending)
      } while (this.again && !this.stopped)
    } catch (error) {
      this.failed(error)
    } finally {
      this.working = false
    }
    if (!this.stopped) this.options.onIdle?.()
  }

  /** Runs `change`, and gives a failure to `failed`: the index is derived, so none is fatal. */
  private failed(error: unknown): void {
    if (this.stopped) return
    const reason = error instanceof Error ? error.message : String(error)
    if (isIndexDamaged(error)) {
      this.log('warn', `Code index is damaged, built again: ${reason}`)
      try {
        this.index.close()
        CodeIndex.remove(this.file)
        this.index = CodeIndex.open(this.file, this.root, this.log)
        // Later than this pass, so the flags of the pass that failed are settled first.
        setTimeout(() => void this.run(), 0).unref()
        return
      } catch (again) {
        this.log('error', `Could not make the code index again: ${String(again)}`)
        return
      }
    }
    this.log('warn', `Code index could not be updated, will be checked again: ${reason}`)
  }

  /**
   * One pass over the host's list: stats every file, reads the new and the changed ones in
   * batches, and drops the rows of the paths that are not on disk anymore.
   */
  private async scan(files: readonly ScanFile[]): Promise<void> {
    if (this.stopped) return
    let realRoot: string
    try {
      realRoot = await realpath(this.root)
    } catch (error) {
      // The root itself is gone: nothing can be read, and dropping every row would throw away
      // the index for a folder the host reports as missing before it asks again.
      this.log('warn', `The project root is not readable: ${errorText(error)}`)
      return
    }
    const rootKey = pathKey(realRoot, PLATFORM)
    const prefix = rootKey.endsWith(paths.sep) ? rootKey : rootKey + paths.sep
    // One entry per path, in the host's order.
    const list = [...new Map(files.map((file) => [file.path, file])).values()]
    const batch = this.options.batchFiles ?? 50
    const indexed = this.index.indexed()
    const first = this.index.count() === 0

    // The present paths, with the size and mtime the scan's own stat saw. A path whose stat
    // failed as gone is left out, so its row is dropped: a file deleted without staging can
    // still be named by a list the host built before it went.
    const present = new Set<string>()
    const toRead: ToRead[] = []
    for (let at = 0; at < list.length; at += batch) {
      if (this.stopped) return
      await Promise.all(
        list.slice(at, at + batch).map(async (file) => {
          let info
          try {
            info = await stat(paths.resolve(this.root, file.path))
          } catch (error) {
            if (isGone(error)) return
            this.log('warn', `Could not stat ${file.path}: ${errorText(error)}`)
            present.add(file.path)
            return
          }
          present.add(file.path)
          if (!info.isFile()) return
          // Only a file the index does not hold, or holds with another size or mtime, is read.
          const known = indexed.get(file.path)
          if (known && known.size === info.size && known.mtime === mtimeOf(info.mtimeMs)) return
          toRead.push({ path: file.path, size: info.size, mtime: info.mtimeMs })
        }),
      )
      await this.rest()
    }
    const gone = [...indexed.keys()].filter((path) => !present.has(path))
    const total = toRead.length + gone.length
    const announce = first || total >= ANNOUNCE_FROM
    if (announce) this.index.setBuild({ done: 0, total })
    let done = 0
    for (let at = 0; at < toRead.length; at += batch) {
      if (this.stopped) return
      const slice = toRead.slice(at, at + batch)
      const upserts: FileUpsert[] = []
      const stats: StatUpdate[] = []
      await Promise.all(
        slice.map(async (file) => {
          const read = await this.readFile(file, prefix)
          if (!read) return
          const known = indexed.get(file.path)
          if (known && known.hash === read.hash) {
            // The content stood still while size or mtime moved: writing those back only leaves
            // the FTS row alone, so a touched file is not read again after this.
            stats.push({ id: known.id, size: file.size, mtime: file.mtime })
          } else {
            upserts.push({ path: file.path, size: file.size, mtime: file.mtime, ...read })
          }
        }),
      )
      this.index.applyScan(upserts, [], stats)
      done += slice.length
      if (announce) this.index.setBuild({ done, total })
      await this.rest()
    }
    for (let at = 0; at < gone.length; at += batch) {
      if (this.stopped) return
      const slice = gone.slice(at, at + batch)
      this.index.applyScan([], slice, [])
      done += slice.length
      if (announce) this.index.setBuild({ done, total })
      await this.rest()
    }
    if (this.index.build()) this.index.setBuild(null)
    this.index.setLastScan(this.now())
  }

  /**
   * Reads one file whole: its real path must stay inside the root once every symbolic link is
   * followed, and it must be UTF-8 text of at most a MiB. Returns its hash and text, or null
   * when it is skipped.
   */
  private async readFile(
    file: ToRead,
    rootPrefix: string,
  ): Promise<{ hash: string; text: string } | null> {
    const skip = (reason: string): null => {
      this.log('warn', `Skipped ${file.path}: ${reason}`)
      return null
    }
    if (file.size > MAX_FILE_BYTES) {
      return skip(`it is ${(file.size / 1024 / 1024).toFixed(1)} MiB`)
    }
    this.options.onRead?.(file.path)
    let real: string
    let handle: FileHandle
    try {
      real = await realpath(paths.resolve(this.root, file.path))
      if (!pathKey(real, PLATFORM).startsWith(rootPrefix)) {
        return skip('a symbolic link leads out of the project')
      }
      handle = await open(real, 'r')
    } catch (error) {
      return skip(errorText(error))
    }
    try {
      // One byte past the size tells a file that grew since the stat.
      const bytes = await readBytes(handle, file.size + 1)
      if (bytes.length > file.size) return skip('it changed while it was read')
      if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return skip('it is binary')
      let text: string
      try {
        text = utf8.decode(bytes)
      } catch {
        return skip('it is not UTF-8')
      }
      return { hash: createHash('sha256').update(bytes).digest('hex'), text }
    } catch (error) {
      return skip(errorText(error))
    } finally {
      await handle.close().catch(() => {})
    }
  }

  private rest(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, this.options.sliceRestMs ?? 2).unref()
    })
  }
}
