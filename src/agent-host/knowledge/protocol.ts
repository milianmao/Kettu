// Messages between the knowledge store in the host and the knowledge worker that owns a
// project's code index. The worker data names the canonical project root and the index file;
// every request carries the file list the host enumerated, so the worker only stats, reads,
// hashes and writes.

import type { BuildProgress, CodeMatch } from './index'

/** What the worker is started with: the project root and the database file of its index. */
export interface KnowledgeWorkerData {
  /** The canonical project root; file paths in requests are relative to it. */
  root: string
  file: string
}

/** A file the host enumerated, with the size and modification time it saw. */
export interface ScanFile {
  /** The path relative to the root, `/`-separated. */
  path: string
  size: number
  /** Milliseconds since the epoch, as `stat` reports them. */
  mtime: number
}

/** How `open` answered: whether the index is there, and whether this open replaced a bad file. */
export interface OpenAnswer {
  opened: boolean
  rebuilt: boolean
  root: string
}

/** The answer of a search: matching lines, whether more were left out, and how the build goes. */
export interface CodeSearchAnswer {
  matches: CodeMatch[]
  /** More lines matched than were kept. */
  capped: boolean
  /** The build under way, or null when the index is complete. */
  indexing: BuildProgress | null
}

export type KnowledgeRequest =
  | { id: number; op: 'open' }
  | { id: number; op: 'ensure'; files: ScanFile[] }
  | { id: number; op: 'search'; query: string; glob?: string; limit: number }
  | { id: number; op: 'drop' }
  | { id: number; op: 'close' }

export type KnowledgeReply =
  | { type: 'ready' }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'result'; id: number; value: unknown }
  | { type: 'error'; id: number; message: string }
