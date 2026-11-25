import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { realpathSync } from 'node:fs'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Exec } from '../git/exec'
import { inKnowledgeWorker } from '../testing/knowledge-worker'
import type { CodeSearchAnswer, KnowledgeReply } from './protocol'
import type { ScannerOptions } from './scan'
import { KnowledgeStore, type KnowledgeWorker, type KnowledgeWorkerFactory } from './store'

// git is never found, so the store walks the folder, as it would outside a repository.
const noGit: Exec = async () => ({
  code: null,
  stdout: '',
  stderr: '',
  failure: 'not-found',
  message: 'git was not found',
})

interface Answer extends CodeSearchAnswer {
  matches: { path: string; line: number; text: string }[]
}

const dirs: string[] = []
const stores: KnowledgeStore[] = []
const logs: { level: string; message: string }[] = []
let dataPath: string
let clock = 0
let woken: () => void = () => {}
/** Resolves when any worker's scanner has nothing left to do. */
const quiet = (): Promise<void> => new Promise((resolve) => (woken = resolve))

/** Answers the first `times` results with an error, so the store's retry runs out. */
function failingWorker(times: number): KnowledgeWorkerFactory {
  let failures = 0
  return (data, scanning) => {
    const inner = inKnowledgeWorker(data, scanning)
    let listener: ((reply: KnowledgeReply) => void) | null = null
    const worker: KnowledgeWorker = {
      postMessage: (request) => inner.postMessage(request),
      onMessage: (attach) => {
        listener = attach
        inner.onMessage((reply) => {
          if (reply.type === 'result' && failures < times) {
            failures++
            listener?.({ type: 'error', id: reply.id, message: 'the worker failed on purpose' })
            return
          }
          listener?.(reply)
        })
      },
      onExit: (attach) => inner.onExit(attach),
      terminate: () => inner.terminate(),
    }
    return worker
  }
}

interface Store {
  store: KnowledgeStore
  /** The roots of the workers the store stopped, in the order it stopped them. */
  stopped: string[]
  folder(name: string, files: readonly (readonly [string, string])[]): string
  find(folder: string, query: string): Promise<Answer>
  /** Finds, and keeps finding until the build it kicked is done: the answer of the index. */
  settled(folder: string, query: string): Promise<Answer>
}

function makeStore(
  options: {
    createWorker?: KnowledgeWorkerFactory
    restMs?: number
  } = {},
): Store {
  const stopped: string[] = []
  const timings: Partial<ScannerOptions> = {
    sliceRestMs: options.restMs ?? 0,
    batchFiles: 4,
    onIdle: () => woken(),
  }
  const createWorker: KnowledgeWorkerFactory =
    options.createWorker ??
    ((data, scanning) => {
      const inner = inKnowledgeWorker(data, scanning)
      return {
        postMessage: (request) => inner.postMessage(request),
        onMessage: (listener) => inner.onMessage(listener),
        onExit: (listener) => inner.onExit(listener),
        terminate: async () => {
          stopped.push(data.root)
          await inner.terminate()
        },
      }
    })
  const store = new KnowledgeStore({
    dataPath,
    platform: process.platform,
    exec: noGit,
    env: { ready: async () => {} },
    createWorker,
    log: (level, message) => logs.push({ level, message }),
    scanTimings: timings,
    now: () => clock,
  })
  stores.push(store)
  const find = (folder: string, query: string): Promise<Answer> =>
    store.search(folder, query) as Promise<Answer>
  return {
    store,
    stopped,
    folder: (name: string, files: readonly (readonly [string, string])[]) => {
      const base = mkdtempSync(path.join(os.tmpdir(), `kettu-knowledge-${name}-`))
      dirs.push(base)
      const folder = path.join(base, name)
      mkdirSync(folder)
      for (const [file, text] of files) writeFileSync(path.join(folder, file), text)
      return folder
    },
    find,
    settled: async (folder, query) => {
      // The first answer names a build under way; the rest is the index once it is built.
      for (let attempt = 0; ; attempt++) {
        const answer = await find(folder, query)
        if (answer.indexing === null || attempt > 100) return answer
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
  }
}

beforeEach(() => {
  dataPath = mkdtempSync(path.join(os.tmpdir(), 'kettu-knowledge-store-'))
  dirs.push(dataPath)
  clock = 0
  logs.length = 0
})

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
  logs.length = 0
})

/** The one index folder under the data path, checked for the claim it holds. */
function indexDirOf(folder: string): string {
  const names = readdirSync(dataPath)
  expect(names).toHaveLength(1)
  const dir = path.join(dataPath, names[0]!)
  expect(JSON.parse(readFileSync(path.join(dir, 'project.json'), 'utf8'))).toEqual({
    version: 1,
    path: realpathSync(folder),
  })
  return dir
}

it('routes two folders to two indexes, without cross-talk', async () => {
  const s = makeStore()
  const left = s.folder('left', [
    ['a.ts', 'the needle of the left\n'],
    ['b.ts', 'plain text\n'],
  ])
  const right = s.folder('right', [['a.ts', 'only right words\n']])
  const fromLeft = await s.settled(left, 'needle')
  expect(fromLeft.matches).toEqual([{ path: 'a.ts', line: 1, text: 'the needle of the left' }])
  expect((await s.settled(right, 'needle')).matches).toEqual([])
  expect((await s.settled(right, 'right')).matches).toEqual([
    { path: 'a.ts', line: 1, text: 'only right words' },
  ])
  expect(readdirSync(dataPath)).toHaveLength(2)
})

it('answers nothing for a folder that is not on disk, and makes no folder for it', async () => {
  const s = makeStore()
  const answer = await s.find(path.join(dataPath, 'gone'), 'anything')
  expect(answer).toEqual({ matches: [], capped: false, indexing: null })
  expect(readdirSync(dataPath)).toEqual([])
  expect(logs).toContainEqual({
    level: 'info',
    message: `The code index was asked for a folder that is not on disk: ${path.join(
      dataPath,
      'gone',
    )}`,
  })
})

it('keeps the claim of the index folder it makes', async () => {
  const s = makeStore()
  const folder = s.folder('claim', [['a.ts', 'words\n']])
  await s.settled(folder, 'words')
  const dir = indexDirOf(folder)
  expect(path.basename(dir)).toMatch(/^claim-[0-9a-f]{12}$/)
  expect(readdirSync(dir)).toContain('code-1.db')
})

it('answers nothing when the worker fails twice, and the next search works', async () => {
  const s = makeStore({ createWorker: failingWorker(2) })
  const folder = s.folder('failing', [['a.ts', 'the words to find\n']])
  const answer = await s.find(folder, 'words')
  // Nothing is fatal: the answer is empty while the fresh worker still builds its index.
  expect(answer.matches).toEqual([])
  expect(answer.capped).toBe(false)
  expect(logs).toContainEqual(
    expect.objectContaining({ level: 'warn', message: expect.stringContaining('on purpose') }),
  )
  expect((await s.settled(folder, 'words')).matches).toEqual([
    { path: 'a.ts', line: 1, text: 'the words to find' },
  ])
})

it('closes the least recently used worker for a new one, never one whose build runs', async () => {
  // The rests between batches hold each build open long enough to overlap the searches.
  const s = makeStore({ restMs: 60 })
  const folders = [
    s.folder('first', [['a.ts', 'the needle\n']]),
    s.folder('second', [['b.ts', 'the needle\n']]),
    s.folder('third', [['c.ts', 'the needle\n']]),
  ]
  for (const folder of folders) {
    await s.find(folder, 'needle')
    await quiet()
    // The reply that says the build ended unpins the worker.
    await s.find(folder, 'needle')
    clock += 1
  }
  const busy = s.folder(
    'busy',
    Array.from({ length: 12 }, (_, n): [string, string] => [`f${n}.ts`, `busy needle ${n}\n`]),
  )
  await s.find(busy, 'needle')
  const fourth = s.folder('fourth', [['d.ts', 'the needle\n']])
  await s.find(fourth, 'needle')
  await quiet()
  // Each folder past the cap closes the least recently used worker that is not building.
  expect(s.stopped).toEqual([folders[0], folders[1]])
  expect(s.stopped).not.toContain(busy)
})
