import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { KnowledgeReply, KnowledgeRequest } from './protocol'
import { startKnowledgeService } from './service'

interface Answer {
  matches: { path: string; line: number; text: string }[]
  capped: boolean
  indexing: { done: number; total: number } | null
}

/** A request without its id, one shape of the union at a time. */
type Ask = KnowledgeRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, 'id'>
    : never
  : never

interface Harness {
  root: string
  dir: string
  /** Runs a request and gives the answer the worker sent, or throws the error it said. */
  ask<T = unknown>(request: Ask): T
  file(name: string, text: string): void
  list(...names: string[]): { path: string; size: number; mtime: number }[]
  advance(ms: number): void
  quiet(): Promise<void>
}

/**
 * A service in this thread, answering as the worker would: the answers arrive as replies, in
 * the order the requests came, with a clock the test moves between scans.
 */
function start(): Harness {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-knowledge-service-'))
  const root = path.join(dir, 'project')
  mkdirSync(root)
  let clock = 0
  let idle: () => void = () => {}
  const answers: { value?: unknown; error?: string }[] = []
  const handle = startKnowledgeService(
    { root, file: path.join(dir, 'state', 'code-1.db') },
    (reply: KnowledgeReply) => {
      if (reply.type === 'result') answers.at(-1)!.value = reply.value
      if (reply.type === 'error') answers.at(-1)!.error = reply.message
    },
    { sliceRestMs: 0, batchFiles: 4, onIdle: () => idle(), now: () => clock },
  )
  let next = 0
  return {
    root,
    dir,
    ask: <T>(request: Ask): T => {
      answers.push({})
      handle({ ...request, id: ++next } as KnowledgeRequest)
      const answer = answers.at(-1)!
      if (answer.error !== undefined) throw new Error(answer.error)
      return answer.value as T
    },
    file: (name, text) => {
      const real = path.join(root, name)
      mkdirSync(path.dirname(real), { recursive: true })
      writeFileSync(real, text)
    },
    list: (...names) =>
      names.map((name) => {
        const info = statSync(path.join(root, name))
        return { path: name, size: info.size, mtime: info.mtimeMs }
      }),
    advance: (ms) => (clock += ms),
    quiet: () => new Promise<void>((resolve) => (idle = resolve)),
  }
}

describe('the knowledge worker service', () => {
  it('answers a search with the lines that hold the words, and none when closed', async () => {
    const s = start()
    s.file('a.ts', 'const needle = 1\nconst other = 2\n')
    s.file('b.ts', 'no hits here\n')
    s.advance(60_000)
    s.ask({ op: 'ensure', files: s.list('a.ts', 'b.ts') })
    await s.quiet()
    const answer = s.ask<Answer>({ op: 'search', query: 'NEEDLE', limit: 50 })
    expect(answer.matches).toEqual([{ path: 'a.ts', line: 1, text: 'const needle = 1' }])
    expect(answer.capped).toBe(false)
    expect(answer.indexing).toBeNull()
    const opened = s.ask<{ opened: boolean; root: string }>({ op: 'open' })
    expect(opened.opened).toBe(true)
    expect(opened.root).toBe(s.root)
    s.ask({ op: 'close' })
    const closed = s.ask<Answer>({ op: 'search', query: 'needle', limit: 5 })
    expect(closed.matches).toEqual([])
    rmSync(s.dir, { recursive: true, force: true })
  })

  it('caps the lines at the limit and keeps a glob prefix', async () => {
    const s = start()
    s.file('src/a.ts', 'NEEDLE upper\nneedle lower\n'.repeat(3))
    s.file('lib/b.ts', 'plain needle\n')
    s.advance(60_000)
    s.ask({ op: 'ensure', files: s.list('src/a.ts', 'lib/b.ts') })
    await s.quiet()
    const narrow = s.ask<Answer>({ op: 'search', query: 'needle', limit: 1, glob: 'lib/' })
    expect(narrow.matches).toEqual([{ path: 'lib/b.ts', line: 1, text: 'plain needle' }])
    expect(narrow.capped).toBe(false)
    const many = s.ask<Answer>({ op: 'search', query: 'needle', limit: 3, glob: 'src/' })
    expect(many.matches).toHaveLength(3)
    expect(many.capped).toBe(true)
    expect(many.matches.map((m) => m.path)).toEqual(['src/a.ts', 'src/a.ts', 'src/a.ts'])
    s.ask({ op: 'close' })
    rmSync(s.dir, { recursive: true, force: true })
  })

  it('answers an ensure with the progress of the build it kicked, at once', async () => {
    const s = start()
    for (let n = 0; n < 3; n++) s.file(`f${n}.ts`, `word ${n} of the build\n`)
    const progress = s.ask<{ done: number; total: number } | null>({
      op: 'ensure',
      files: s.list('f0.ts', 'f1.ts', 'f2.ts'),
    })
    expect(progress).toEqual({ done: 0, total: 3 })
    await s.quiet()
    const done = s.ask<Answer>({ op: 'search', query: 'word', limit: 10 })
    expect(done.indexing).toBeNull()
    expect(done.matches.map((m) => m.path)).toEqual(['f0.ts', 'f1.ts', 'f2.ts'])
    s.ask({ op: 'close' })
    rmSync(s.dir, { recursive: true, force: true })
  })

  it('drops the database and opens it again empty', async () => {
    const s = start()
    s.file('a.ts', 'kept words\n')
    s.advance(60_000)
    s.ask({ op: 'ensure', files: s.list('a.ts') })
    await s.quiet()
    s.ask({ op: 'drop' })
    const after = s.ask<Answer>({ op: 'search', query: 'kept', limit: 10 })
    expect(after.matches).toEqual([])
    const again = s.ask<{ opened: boolean; root: string }>({ op: 'open' })
    expect(again.opened).toBe(true)
    expect(again.root).toBe(s.root)
    s.advance(60_000)
    s.ask({ op: 'ensure', files: s.list('a.ts') })
    await s.quiet()
    const back = s.ask<Answer>({ op: 'search', query: 'kept', limit: 10 })
    expect(back.matches).toEqual([{ path: 'a.ts', line: 1, text: 'kept words' }])
    s.ask({ op: 'close' })
    rmSync(s.dir, { recursive: true, force: true })
  })
})
