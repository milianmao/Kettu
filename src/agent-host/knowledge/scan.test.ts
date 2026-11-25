import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { queryWords } from '@shared/search-fold'
import { CodeIndex, INDEX_FILE, type IndexLog } from './index'
import type { ScanFile } from './protocol'
import { Scanner } from './scan'

let dir: string
let root: string
let file: string
let index: CodeIndex
let clock = 0
let reads: string[] = []
let woken: () => void
const logs: string[] = []
const log: IndexLog = (_level, message) => {
  logs.push(message)
}

/** Resolves when the scanner has nothing left to do. */
const quiet = (): Promise<void> => new Promise((resolve) => (woken = resolve))

interface Setup {
  scanner: Scanner
  /** Sends the given files as the host would, and waits for the scan to end. */
  scan(files: ScanFile[]): Promise<void>
  found(query: string): string[]
}

function setup(): Setup {
  const scanner = new Scanner(index, file, log, {
    sliceRestMs: 0,
    batchFiles: 4,
    onIdle: () => woken(),
    onRead: (path) => reads.push(path),
    now: () => clock,
  })
  return {
    scanner,
    async scan(files) {
      const done = quiet()
      scanner.ensure(files)
      await done
    },
    found: (query) => index.find(queryWords(query)).map((f) => f.path),
  }
}

function fileStat(...paths: string[]): ScanFile[] {
  return paths.map((name) => {
    const info = statSync(path.join(root, name))
    return { path: name, size: info.size, mtime: info.mtimeMs }
  })
}

/** Writes a file and stats it, returning the size and mtime the host's list would carry. */
function write(name: string, text: string): ScanFile {
  writeFileSync(path.join(root, name), text)
  return fileStat(name)[0]!
}

/** Touches a file without changing its content, so only its mtime moves. */
function touch(name: string): ScanFile {
  const real = path.join(root, name)
  const info = statSync(real)
  utimesSync(real, new Date(), new Date(info.mtimeMs + 5000))
  return fileStat(name)[0]!
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-code-scan-'))
  root = dir
  file = path.join(dir, 'state', INDEX_FILE)
  index = CodeIndex.open(file, root, log)
  clock = 0
  reads = []
  logs.length = 0
})

afterEach(() => {
  try {
    index.close()
  } catch {
    // Already closed by the test.
  }
  rmSync(dir, { recursive: true, force: true })
})

it('builds every file of the host list, and announces the build while it goes', async () => {
  const s = setup()
  const files = Array.from({ length: 9 }, (_, n) => write(`f${n}.ts`, `content ${n} of the scan`))
  const seen: (number | null)[] = []
  const original = index.setBuild.bind(index)
  index.setBuild = (value) => {
    seen.push(value ? value.done : null)
    original(value)
  }
  await s.scan(files)
  expect(s.found('content')).toEqual(files.map((f) => f.path))
  expect(index.count()).toBe(9)
  expect(reads.length).toBe(9)
  expect(seen.at(0)).toBe(0)
  expect(seen.at(-1)).toBeNull()
  expect(index.build()).toBeNull()
  expect(index.lastScan()).toBe(clock)
})

it('re-reads only the file that changed, and none of the rest', async () => {
  const s = setup()
  await s.scan([write('a.ts', 'alpha words'), write('b.ts', 'beta words'), write('c.ts', 'gamma')])
  reads = []
  const changed = write('b.ts', 'beta words changed')
  clock += 60_000
  await s.scan([fileStat('a.ts')[0]!, changed, fileStat('c.ts')[0]!])
  expect(reads).toEqual(['b.ts'])
  expect(s.found('changed')).toEqual(['b.ts'])
  expect(s.found('alpha')).toEqual(['a.ts'])
})

it('reads a touched file once, then only writes its stat back', async () => {
  const s = setup()
  await s.scan([write('a.ts', 'steady words'), write('b.ts', 'other words')])
  reads = []
  const touched = touch('a.ts')
  clock += 60_000
  await s.scan([touched, fileStat('b.ts')[0]!])
  expect(reads).toEqual(['a.ts'])
  // The stat write-back kept the row's mtime current, so the next scan reads nothing.
  reads = []
  clock += 60_000
  await s.scan([fileStat('a.ts')[0]!, fileStat('b.ts')[0]!])
  expect(reads).toEqual([])
  expect(s.found('steady')).toEqual(['a.ts'])
  const stored = index.indexed().get('a.ts')!.mtime
  expect(stored).toBe(Math.round(fileStat('a.ts')[0]!.mtime))
})

it('drops a file deleted without staging, and takes a new one in', async () => {
  const s = setup()
  const a = write('a.ts', 'kept words')
  const b = write('b.ts', 'gone words')
  await s.scan([a, b])
  expect(s.found('gone')).toEqual(['b.ts'])
  // Deleted from the worktree, but the host list still names it, as a stale list can.
  rmSync(path.join(root, 'b.ts'))
  const fresh = write('c.ts', 'fresh words')
  clock += 60_000
  await s.scan([a, b, fresh])
  expect(s.found('gone')).toEqual([])
  expect(s.found('fresh')).toEqual(['c.ts'])
  expect(s.found('kept')).toEqual(['a.ts'])
})

it('skips a link out of the project, a binary file, one too large and one not UTF-8', async () => {
  const s = setup()
  // The root is a folder of its own, so a link can lead out of it.
  const inside = path.join(dir, 'project')
  mkdirSync(inside)
  const outside = path.join(dir, 'outside')
  mkdirSync(outside)
  writeFileSync(path.join(outside, 'leak.ts'), 'leak words')
  // A junction on Windows, a symbolic link elsewhere: both resolve out of the project.
  symlinkSync(outside, path.join(inside, 'escape'), 'junction')
  writeFileSync(path.join(root, 'zero.bin'), Buffer.from([0x61, 0x00, 0x62]))
  writeFileSync(
    path.join(root, 'wide.ts'),
    Buffer.concat([Buffer.from('wide '), Buffer.from([0xff, 0xfe, 0xfd])]),
  )
  writeFileSync(path.join(root, 'big.ts'), `${'x'.repeat(1024 * 1024 + 1)}`)
  const ok = write('ok.ts', 'plain words')
  const escapeFile = path.join(dir, 'state', 'escape.db')
  const escape = new Scanner(CodeIndex.open(escapeFile, inside, log), escapeFile, log, {
    sliceRestMs: 0,
    batchFiles: 4,
    onIdle: () => woken(),
    now: () => clock,
  })
  clock += 60_000
  const leakStat = statSync(path.join(inside, 'escape', 'leak.ts'))
  const leak: ScanFile = {
    path: 'escape/leak.ts',
    size: leakStat.size,
    mtime: leakStat.mtimeMs,
  }
  const leaked = quiet()
  escape.ensure([leak])
  await leaked
  const escapeIndex = escape.current()
  expect(escapeIndex.find(queryWords('leak'))).toHaveLength(0)
  escapeIndex.close()
  clock += 60_000
  await s.scan([fileStat('zero.bin')[0]!, fileStat('wide.ts')[0]!, fileStat('big.ts')[0]!, ok])
  expect(s.found('words')).toEqual(['ok.ts'])
  expect(logs.some((line) => line.includes('escape/leak.ts'))).toBe(true)
  expect(logs.some((line) => line.includes('zero.bin'))).toBe(true)
  expect(logs.some((line) => line.includes('wide.ts'))).toBe(true)
  expect(logs.some((line) => line.includes('big.ts'))).toBe(true)
})

it('answers an ensure at once while a scan runs, and starts no second scan', async () => {
  const s = setup()
  const files = Array.from({ length: 12 }, (_, n) => write(`f${n}.ts`, `word ${n}`))
  const done = quiet()
  const first = s.scanner.ensure(files)
  expect(first).toEqual({ done: 0, total: 12 })
  // The first scan is under way: a second ensure marks its list and answers the progress.
  const second = s.scanner.ensure(files)
  expect(second).not.toBeNull()
  expect(second).toEqual({ done: 0, total: 12 })
  await done
  // One pass of the list, with the second ensure's mark folded into the same scan.
  expect(reads).toHaveLength(12)
  expect(reads).toEqual([...new Set(reads)])
  expect(index.count()).toBe(12)
})

it('yields between batches, answering a search while the scan goes', async () => {
  const files = Array.from({ length: 12 }, (_, n) => write(`f${n}.ts`, `word ${n}`))
  const slow = new Scanner(index, file, log, {
    sliceRestMs: 40,
    batchFiles: 4,
    onIdle: () => woken(),
    now: () => clock,
  })
  const done = quiet()
  slow.ensure(files)
  await new Promise((resolve) => setTimeout(resolve, 10))
  // The scan rests between batches; while it does, the worker answers from committed rows.
  expect(index.lineMatches('word 11\nlater', queryWords('word'))).toHaveLength(1)
  await done
  expect(index.count()).toBe(12)
  expect(index.find(queryWords('word'))).toHaveLength(12)
})

it('scans nothing when the last scan ended too recently', async () => {
  const s = setup()
  const a = write('a.ts', 'alpha words')
  await s.scan([a])
  reads = []
  write('b.ts', 'beta words')
  const answer = s.scanner.ensure([a, fileStat('b.ts')[0]!])
  expect(answer).toBeNull()
  expect(reads).toEqual([])
  expect(index.count()).toBe(1)
})

it('keeps working after a failure inside a scan, and answers nothing when stopped', async () => {
  const s = setup()
  const failing = index
  failing.applyScan = () => {
    throw new Error('disk full')
  }
  const a = write('a.ts', 'alpha words')
  await s.scan([a])
  expect(logs.some((line) => line.includes('disk full'))).toBe(true)
  delete (failing as { applyScan?: unknown }).applyScan
  clock += 60_000
  await s.scan([a])
  expect(s.found('alpha')).toEqual(['a.ts'])
  s.scanner.stop()
  expect(s.scanner.ensure([a])).toBeNull()
})
