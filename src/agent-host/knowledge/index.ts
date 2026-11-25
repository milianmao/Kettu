// The code index: the folded text of a project's source files, one row per file, kept in a
// database of its own under the user's data folder. It is derived data: the file can be deleted
// and built again. node:sqlite is synchronous, so this runs in the knowledge worker, never on
// the host's event loop. Modeled on ../search/index.ts; the two evolve apart.

import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite'
import { foldBulk } from '@shared/search-fold'
import { transaction } from '../sqlite'

/** The format of the tables; a newer format uses a file name of its own. */
export const INDEX_FORMAT = 1
export const INDEX_FILE = `code-${INDEX_FORMAT}.db`

// A word of fewer characters has no trigram, so it is matched by `instr` instead.
const TRIGRAM = 3

const SQLITE_CORRUPT = 11
const SQLITE_NOTADB = 26
const SQLITE_CANTOPEN = 14

// `file` holds one row per file: the text for locating lines, and the folded text the trigram
// index reads. `meta` holds format, fts, the root the paths are relative to, when the last scan
// ended, and how far a build under way has come.
const TABLES = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;
  CREATE TABLE file (
    id     INTEGER PRIMARY KEY,
    path   TEXT NOT NULL,
    hash   TEXT NOT NULL,
    size   INTEGER NOT NULL,
    mtime  INTEGER NOT NULL,
    text   TEXT NOT NULL,
    folded TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX file_by_path ON file (path);
`

// The trigram index over the folded text, kept by the triggers as files come and go. The update
// trigger fires only when the statement sets `text` or `folded`: a scan that writes back only
// size and mtime must not delete and insert the FTS row, or every touch would rewrite it.
const FTS = `
  CREATE VIRTUAL TABLE file_fts USING fts5(
    folded, content = 'file', content_rowid = 'id', tokenize = 'trigram');
  CREATE TRIGGER file_ai AFTER INSERT ON file BEGIN
    INSERT INTO file_fts (rowid, folded) VALUES (new.id, new.folded);
  END;
  CREATE TRIGGER file_ad AFTER DELETE ON file BEGIN
    INSERT INTO file_fts (file_fts, rowid, folded) VALUES ('delete', old.id, old.folded);
  END;
  CREATE TRIGGER file_au AFTER UPDATE OF text, folded ON file BEGIN
    INSERT INTO file_fts (file_fts, rowid, folded) VALUES ('delete', old.id, old.folded);
    INSERT INTO file_fts (rowid, folded) VALUES (new.id, new.folded);
  END;
`

type Row = Record<string, SQLOutputValue>
export type IndexLog = (level: 'info' | 'warn' | 'error', message: string) => void

/** A line of a file that holds every word of a search. */
export interface CodeMatch {
  path: string
  line: number
  text: string
}

/** A file as the index holds it, for the scan that decides what to read again. */
export interface IndexedFile {
  id: number
  hash: string
  size: number
  mtime: number
}

/** How far a build of the whole index has come: files done of the files it started with. */
export interface BuildProgress {
  done: number
  total: number
}

/** One file of a scan's result: a new or changed file to write whole. */
export interface FileUpsert {
  path: string
  hash: string
  size: number
  mtime: number
  text: string
}

/** A file whose content did not change but whose size or mtime did: only those are written. */
export interface StatUpdate {
  id: number
  size: number
  mtime: number
}

function resultCode(error: unknown): number | null {
  const errcode = (error as { errcode?: unknown } | null)?.errcode
  return typeof errcode === 'number' ? errcode & 0xff : null
}

/** Whether the file is damaged, or not an index of this format: it is built again. */
export function isIndexDamaged(error: unknown): boolean {
  const code = resultCode(error)
  return code === SQLITE_CORRUPT || code === SQLITE_NOTADB || error instanceof WrongIndexError
}

class WrongIndexError extends Error {}

/**
 * Whether this SQLite can run the trigram index a file already has. A file made by a Node.js
 * with FTS5 can be opened by one without (22.13 to 22.15): reads of the files still work, but
 * every write fires a trigger into a module that is not there.
 */
function runsTrigram(db: DatabaseSync): boolean {
  try {
    db.prepare('SELECT 1 FROM file_fts LIMIT 0')
    return true
  } catch (error) {
    if (/no such (module|tokenizer)/i.test(message(error))) return false
    throw error
  }
}

/** An FTS5 phrase that matches `word` as it stands. */
const phrase = (word: string): string => `"${word.replace(/"/g, '""')}"`

// How many lines of one file a search answers with, so one large file cannot fill the result.
export const LINES_PER_FILE = 10

// A line as a match shows it: without its line end and cut to this many characters.
const MATCH_CHARS = 300

/** A line without its line end, cut to `chars` characters without splitting a surrogate pair. */
function cutLine(line: string, chars: number): string {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line
  if (text.length <= chars) return text
  // Do not leave half of a surrogate pair at the cut.
  const end = /[\uD800-\uDBFF]/.test(text[chars - 1] ?? '') ? chars - 1 : chars
  return text.slice(0, end)
}

/**
 * A modification time as the index holds it. `stat` reports fractions of a millisecond on some
 * file systems, which SQLite's INTEGER column refuses; rounding the same value twice gives the
 * same whole millisecond, so a file the index already holds is not read again for its fraction.
 */
export function mtimeOf(mtime: number): number {
  return Math.round(mtime)
}

export class CodeIndex {
  private readonly statements = new Map<string, StatementSync>()

  private constructor(
    private readonly db: DatabaseSync,
    /** Whether the trigram index exists; without it every word is matched by `instr`. */
    readonly hasFts: boolean,
    /** Whether this open replaced a file that was damaged or of another format. */
    readonly rebuilt: boolean,
    /** The canonical root the indexed paths are relative to. */
    readonly root: string,
  ) {}

  /**
   * Opens the index for writing, making it when there is none. A file that is damaged or of
   * another format is deleted and made again, which loses nothing: the index is derived.
   */
  static open(
    file: string,
    root: string,
    log: IndexLog,
    options: { fts?: boolean } = {},
  ): CodeIndex {
    mkdirSync(path.dirname(file), { recursive: true })
    const fts = options.fts ?? true
    try {
      return CodeIndex.connect(file, root, log, fts)
    } catch (error) {
      if (!isIndexDamaged(error)) throw error
      log('warn', `Code index ${path.basename(file)} is unusable, built again: ${message(error)}`)
      CodeIndex.remove(file)
      const again = CodeIndex.connect(file, root, log, fts)
      return new CodeIndex(again.db, again.hasFts, true, again.root)
    }
  }

  /**
   * Opens the index for reading; null when there is no file, or it is not ready: the worker may
   * be making it, or it is damaged and the worker will make it again.
   */
  static openReader(file: string, log: IndexLog): CodeIndex | null {
    let db: DatabaseSync | null = null
    try {
      db = new DatabaseSync(file, { readOnly: true })
      db.exec('PRAGMA busy_timeout = 5000')
      const { fts, root } = CodeIndex.readMeta(db)
      return new CodeIndex(db, fts && runsTrigram(db), false, root)
    } catch (error) {
      db?.close()
      if (resultCode(error) !== SQLITE_CANTOPEN) {
        log('info', `Code index is not readable yet: ${message(error)}`)
      }
      return null
    }
  }

  /** Deletes the file with its journal files. */
  static remove(file: string): void {
    for (const name of [file, `${file}-wal`, `${file}-shm`]) rmSync(name, { force: true })
  }

  private static readMeta(db: DatabaseSync): { fts: boolean; root: string } {
    let rows: Row[]
    try {
      rows = db.prepare('SELECT key, value FROM meta').all()
    } catch (error) {
      if (isIndexDamaged(error)) throw error
      throw new WrongIndexError(`no meta table: ${message(error)}`)
    }
    const meta = new Map(rows.map((row) => [String(row.key), String(row.value)]))
    if (meta.get('format') !== String(INDEX_FORMAT)) {
      throw new WrongIndexError(`format ${meta.get('format') ?? 'none'}, not ${INDEX_FORMAT}`)
    }
    return { fts: meta.get('fts') === '1', root: meta.get('root') ?? '' }
  }

  private static connect(file: string, root: string, log: IndexLog, withFts: boolean): CodeIndex {
    const db = new DatabaseSync(file)
    try {
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = NORMAL')
      db.exec('PRAGMA busy_timeout = 5000')
      const empty = db.prepare('SELECT count(*) AS n FROM sqlite_master').get()?.n === 0
      if (!empty) {
        const { fts, root } = CodeIndex.readMeta(db)
        if (fts && !runsTrigram(db)) {
          throw new WrongIndexError('its trigram index needs an FTS5 this SQLite does not have')
        }
        return new CodeIndex(db, fts, false, root)
      }
      db.exec('BEGIN')
      db.exec(TABLES)
      let fts = false
      try {
        if (withFts) db.exec(FTS)
        fts = withFts
      } catch (error) {
        log('warn', `Code index has no trigram index, words are scanned: ${message(error)}`)
      }
      const put = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      put.run('format', String(INDEX_FORMAT))
      put.run('fts', fts ? '1' : '0')
      put.run('root', root)
      db.exec('COMMIT')
      return new CodeIndex(db, fts, false, root)
    } catch (error) {
      db.close()
      throw error
    }
  }

  close(): void {
    this.statements.clear()
    this.db.close()
  }

  private sql(text: string): StatementSync {
    let statement = this.statements.get(text)
    if (!statement) this.statements.set(text, (statement = this.db.prepare(text)))
    return statement
  }

  private transaction<T>(run: () => T): T {
    return transaction(this.db, run)
  }

  // Writing.

  /**
   * Applies what one batch of a scan found, in one transaction: files new or changed whole,
   * paths that are gone, and files whose content stood still while their size or mtime moved.
   * The last kind must not set `text` or `folded`, so the update trigger leaves the FTS row be.
   */
  applyScan(
    upserts: readonly FileUpsert[],
    removedPaths: readonly string[],
    stats: readonly StatUpdate[],
  ): void {
    this.transaction(() => {
      const write = this.sql(`
        INSERT INTO file (path, hash, size, mtime, text, folded)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (path) DO UPDATE SET
          hash = excluded.hash, size = excluded.size, mtime = excluded.mtime,
          text = excluded.text, folded = excluded.folded`)
      for (const { path, hash, size, mtime, text } of upserts) {
        write.run(path, hash, size, mtimeOf(mtime), text, foldBulk(text))
      }
      const drop = this.sql('DELETE FROM file WHERE path = ?')
      for (const gone of removedPaths) drop.run(gone)
      const touch = this.sql('UPDATE file SET size = ?, mtime = ? WHERE id = ?')
      for (const { id, size, mtime } of stats) touch.run(size, mtimeOf(mtime), id)
    })
  }

  /** When the last scan ended, or null when none ever did. */
  lastScan(): number | null {
    const row = this.sql("SELECT value FROM meta WHERE key = 'last_scan'").get()
    return row ? Number(row.value) : null
  }

  setLastScan(at: number): void {
    this.sql(
      `INSERT INTO meta (key, value) VALUES ('last_scan', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run(String(at))
  }

  /** Records how far a build is, or that none is under way. */
  setBuild(progress: BuildProgress | null): void {
    this.transaction(() => {
      if (progress === null) {
        this.sql("DELETE FROM meta WHERE key IN ('build_done', 'build_total')").run()
        return
      }
      const put = this.sql(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      put.run('build_done', String(progress.done))
      put.run('build_total', String(progress.total))
    })
  }

  // Reading.

  /** How many files the index holds. */
  count(): number {
    return Number(this.sql('SELECT count(*) AS n FROM file').get()?.n ?? 0)
  }

  /** The files the index holds, by path, for the scan that decides what to read again. */
  indexed(): Map<string, IndexedFile> {
    const rows = this.sql('SELECT id, path, hash, size, mtime FROM file').all()
    return new Map(
      rows.map((row: Row): [string, IndexedFile] => [
        String(row.path),
        {
          id: Number(row.id),
          hash: String(row.hash),
          size: Number(row.size),
          mtime: Number(row.mtime),
        },
      ]),
    )
  }

  /** The build under way, or null when the index is complete. */
  build(): BuildProgress | null {
    const rows = this.sql(
      "SELECT key, value FROM meta WHERE key IN ('build_done', 'build_total')",
    ).all()
    const meta = new Map(rows.map((row) => [String(row.key), Number(row.value)]))
    const done = meta.get('build_done')
    const total = meta.get('build_total')
    return done === undefined || total === undefined ? null : { done, total }
  }

  /**
   * The files that hold every one of `words`, which are folded, by path. Long words narrow the
   * set through the trigram index; short ones, or all of them without FTS5, are matched with
   * `instr` over the folded text.
   */
  find(words: readonly string[]): { id: number; path: string; text: string }[] {
    if (words.length === 0) return []
    const long = this.hasFts ? words.filter((word) => Array.from(word).length >= TRIGRAM) : []
    const short = words.filter((word) => !long.includes(word))
    const conditions: string[] = []
    const params: string[] = []
    if (long.length > 0) {
      conditions.push('id IN (SELECT rowid FROM file_fts WHERE file_fts MATCH ?)')
      params.push(long.map(phrase).join(' AND '))
    }
    for (const word of short) {
      conditions.push('instr(folded, ?) > 0')
      params.push(word)
    }
    const rows = this.sql(
      `SELECT id, path, text FROM file WHERE ${conditions.join(' AND ')} ORDER BY path`,
    ).all(...params)
    return rows.map((row: Row) => ({
      id: Number(row.id),
      path: String(row.path),
      text: String(row.text),
    }))
  }

  /**
   * The lines of `text` that hold every one of `words`, folded, oldest first, at most
   * `LINES_PER_FILE` of them, each cut to `MATCH_CHARS` characters.
   */
  lineMatches(text: string, words: readonly string[]): { line: number; text: string }[] {
    if (words.length === 0) return []
    const found: { line: number; text: string }[] = []
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index++) {
      const folded = foldBulk(lines[index]!)
      if (words.every((word) => folded.includes(word))) {
        found.push({ line: index + 1, text: cutLine(lines[index]!, MATCH_CHARS) })
        if (found.length >= LINES_PER_FILE) break
      }
    }
    return found
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
