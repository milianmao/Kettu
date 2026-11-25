import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { queryWords } from '@shared/search-fold'
import { CodeIndex, INDEX_FILE, type FileUpsert, isIndexDamaged } from './index'

const dirs: string[] = []
const logs: { level: string; message: string }[] = []
const log = (level: 'info' | 'warn' | 'error', message: string): void => {
  logs.push({ level, message })
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  logs.length = 0
})

function tempFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-code-index-'))
  dirs.push(dir)
  return path.join(dir, INDEX_FILE)
}

function fileOf(path: string, text: string): FileUpsert {
  return { path, hash: `h-${path}`, size: text.length, mtime: 1, text }
}

describe.each([{ fts: true }, { fts: false }])('the code index (fts: $fts)', ({ fts }) => {
  const open = (file = tempFile()): CodeIndex => CodeIndex.open(file, 'C:\\proj', log, { fts })

  it('finds the files that hold every word, ignoring case and accents, by path', () => {
    const index = open()
    expect(index.hasFts).toBe(fts)
    index.applyScan(
      [
        fileOf('b.ts', 'Fix the CAFÉ menu\nnothing else'),
        fileOf('a.ts', 'The menu of the cafe is fixed'),
        fileOf('c.ts', '搜索会话里的内容\n令牌唯一性需要测试'),
      ],
      [],
      [],
    )
    const found = (query: string) => index.find(queryWords(query)).map((f) => f.path)
    expect(found('cafe menu')).toEqual(['a.ts', 'b.ts'])
    expect(found('MENU')).toEqual(['a.ts', 'b.ts'])
    expect(found('fixed menu')).toEqual(['a.ts'])
    // A word of one message does not reach into another file's row.
    expect(found('nothing fixed')).toEqual([])
    expect(found('令牌')).toEqual(['c.ts'])
    expect(found('内容')).toEqual(['c.ts'])
    // A word of one message does not reach into another file's row.
    expect(found('nothing fixed')).toEqual([])
    // Quotes and operators in a query are text.
    expect(found('"a" OR b')).toEqual([])
    expect(index.find([])).toEqual([])
    index.close()
  })

  it('applies removals and stat-only updates, keeping the FTS row of a touched file', () => {
    const index = open()
    const first = index.applyScan([fileOf('a.ts', 'alpha beta')], [], [])
    expect(first).toBeUndefined()
    const id = index.indexed().get('a.ts')!.id
    // The content stood still: the stat write-back must not rewrite the trigram row.
    index.applyScan([], [], [{ id, size: 9, mtime: 2 }])
    expect(index.find(queryWords('beta')).map((f) => f.path)).toEqual(['a.ts'])
    // A changed text is found by what it says now, and not by what it said.
    index.applyScan([fileOf('a.ts', 'gamma delta')], [], [])
    expect(index.find(queryWords('alpha')).map((f) => f.path)).toEqual([])
    expect(index.find(queryWords('delta')).map((f) => f.path)).toEqual(['a.ts'])
    index.applyScan([], ['a.ts'], [])
    expect(index.find(queryWords('delta')).map((f) => f.path)).toEqual([])
    expect(index.count()).toBe(0)
    index.close()
  })

  it('locates the lines that hold every word, cut and capped per file', () => {
    const index = open()
    const text =
      'const needle = 1\n' +
      'unrelated\n' +
      `const long = 'needle at ${'x'.repeat(400)} end'\n` +
      'needle again\n'.repeat(3) +
      'needle with an emoji \u{1F988} here\n'
    const found = index.lineMatches(text, queryWords('NEEDLE'))
    expect(found.map((line) => line.line)).toEqual([1, 3, 4, 5, 6, 7])
    // The long line is cut, without splitting a surrogate pair.
    expect(found[1]!.text.length).toBeLessThanOrEqual(300)
    expect(found[1]!.text.startsWith('needle')).toBe(false)
    const emoji = found.at(-1)!.text
    expect(emoji.endsWith('\u{1F988} here')).toBe(true)
    // Every word of the query must sit on the line itself.
    expect(index.lineMatches(text, queryWords('needle unrelated'))).toEqual([])
    expect(index.lineMatches(text, [])).toEqual([])
    // At most ten lines of one file, with a CRLF line end trimmed.
    const many = 'hit\r\n'.repeat(12)
    expect(index.lineMatches(many, queryWords('hit')).map((line) => line.text)).toEqual(
      Array.from({ length: 10 }, () => 'hit'),
    )
    index.close()
  })

  it('keeps its tables, root and scan times across a reopen, and tells a build under way', () => {
    const file = tempFile()
    const index = open(file)
    index.applyScan([fileOf('a.ts', 'kept text')], [], [])
    expect(index.build()).toBeNull()
    index.setBuild({ done: 2, total: 9 })
    index.setBuild({ done: 3, total: 9 })
    expect(index.build()).toEqual({ done: 3, total: 9 })
    expect(index.lastScan()).toBeNull()
    index.setLastScan(123)
    index.close()
    const again = CodeIndex.open(file, 'C:\\proj', log, { fts })
    expect(again.hasFts).toBe(fts)
    expect(again.rebuilt).toBe(false)
    expect(again.root).toBe('C:\\proj')
    expect(again.indexed().get('a.ts')!.hash).toBe('h-a.ts')
    expect(again.find(queryWords('kept')).map((f) => f.path)).toEqual(['a.ts'])
    expect(again.build()).toEqual({ done: 3, total: 9 })
    expect(again.lastScan()).toBe(123)
    again.setBuild(null)
    expect(again.build()).toBeNull()
    again.close()
  })

  it('builds a file that is damaged, of another format or not an index again', () => {
    const garbage = tempFile()
    writeFileSync(garbage, 'this is not a database'.repeat(200))
    const fromGarbage = open(garbage)
    expect(fromGarbage.rebuilt).toBe(true)
    fromGarbage.applyScan([fileOf('a.ts', 'fresh')], [], [])
    expect(fromGarbage.find(queryWords('fresh')).map((f) => f.path)).toEqual(['a.ts'])
    fromGarbage.close()
    expect(logs.some((entry) => entry.level === 'warn')).toBe(true)

    const other = tempFile()
    const db = new DatabaseSync(other)
    db.exec("CREATE TABLE unrelated (x TEXT); INSERT INTO unrelated VALUES ('kept?')")
    db.close()
    const fromOther = open(other)
    expect(fromOther.rebuilt).toBe(true)
    expect(fromOther.find(queryWords('kept')).map((f) => f.path)).toEqual([])
    fromOther.close()

    const newer = tempFile()
    const first = open(newer)
    first.close()
    const edit = new DatabaseSync(newer)
    edit.exec("UPDATE meta SET value = '999' WHERE key = 'format'")
    edit.close()
    const fromNewer = open(newer)
    expect(fromNewer.rebuilt).toBe(true)
    fromNewer.applyScan([fileOf('a.ts', 'again')], [], [])
    expect(fromNewer.find(queryWords('again')).map((f) => f.path)).toEqual(['a.ts'])
    fromNewer.close()
  })

  it('tells damage by its SQLite codes', () => {
    const damaged = Object.assign(new Error('database disk image is malformed'), { errcode: 11 })
    expect(isIndexDamaged(damaged)).toBe(true)
    expect(
      isIndexDamaged(Object.assign(new Error('file is not a database'), { errcode: 26 })),
    ).toBe(true)
    expect(isIndexDamaged(new Error('disk I/O error'))).toBe(false)
    expect(isIndexDamaged(Object.assign(new Error('cannot open'), { errcode: 14 }))).toBe(false)
  })
})

describe('reading the code index from another connection', () => {
  it('opens only once the file is an index, and sees what the writer commits', () => {
    const file = tempFile()
    expect(CodeIndex.openReader(file, log)).toBeNull()
    const writer = CodeIndex.open(file, 'C:\\proj', log)
    const reader = CodeIndex.openReader(file, log)!
    expect(reader.root).toBe('C:\\proj')
    expect(reader.find(queryWords('late')).map((f) => f.path)).toEqual([])
    writer.applyScan([fileOf('a.ts', 'late arrival')], [], [])
    expect(reader.find(queryWords('late')).map((f) => f.path)).toEqual(['a.ts'])
    reader.close()
    writer.close()
  })
})
