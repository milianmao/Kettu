import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Exec } from '../git/exec'
import { inKnowledgeWorker } from '../testing/knowledge-worker'
import type { ScannerOptions } from './scan'
import { KnowledgeStore, type KnowledgeWorkerFactory } from './store'
import { KNOWLEDGE_TOOLS, KnowledgeTools, SEARCH_CODE_TOOL } from './tools'

// git is never found, so the store walks the folder, as it would outside a repository.
const noGit: Exec = async () => ({
  code: null,
  stdout: '',
  stderr: '',
  failure: 'not-found',
  message: 'git was not found',
})

const stores: KnowledgeStore[] = []
const dirs: string[] = []
let dir: string
let clock = 0

function toolsOf(search: KnowledgeStore): KnowledgeTools {
  return new KnowledgeTools({
    search: (folder, query, opts) => search.search(folder, query, opts),
  })
}

/** A store that runs the knowledge service in this thread, with fast scanner timings. */
function store(): KnowledgeStore {
  const createWorker: KnowledgeWorkerFactory = (data, scanning) => {
    const inner = inKnowledgeWorker(data, scanning)
    return {
      postMessage: (request) => inner.postMessage(request),
      onMessage: (listener) => inner.onMessage(listener),
      onExit: (listener) => inner.onExit(listener),
      terminate: () => inner.terminate(),
    }
  }
  const timings: Partial<ScannerOptions> = {
    sliceRestMs: 0,
    batchFiles: 4,
  }
  const made = new KnowledgeStore({
    dataPath: path.join(dir, 'knowledge'),
    platform: process.platform,
    exec: noGit,
    env: { ready: async () => {} },
    createWorker,
    log: () => {},
    scanTimings: timings,
    now: () => clock,
  })
  stores.push(made)
  return made
}

/** Finds, and keeps finding until the build it kicked is done: the answer of the index. */
async function settled(
  tools: KnowledgeTools,
  caller: { sessionId: string; project: string; folder?: string },
  query: string,
  opts: { limit?: number } = {},
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const answer = await tools.call(caller, SEARCH_CODE_TOOL, { query, ...opts })
    const text = texts(answer)
    if (!/index is still being built/.test(text) || attempt > 100) return text
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function folder(name: string, files: readonly (readonly [string, string])[]): string {
  const base = mkdtempSync(path.join(os.tmpdir(), `kettu-knowledge-tools-${name}-`))
  dirs.push(base)
  const root = path.join(base, name)
  mkdirSync(root)
  for (const [file, text] of files) writeFileSync(path.join(root, file), text)
  return root
}

const texts = (result: { content: { type: string; text?: string }[] }): string =>
  result.content.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('\n')

const CALLER = { sessionId: 's1', project: 'unused' }

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-knowledge-tools-'))
  dirs.push(dir)
  clock = 0
})

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

it('lists every tool it serves', () => {
  expect(KNOWLEDGE_TOOLS.map((tool) => tool.name)).toEqual([SEARCH_CODE_TOOL])
})

it('searches the files of the caller, answering with path, line and text', async () => {
  const root = folder('project', [
    ['a.ts', 'const needle = 1\nconst other = 2\n'],
    ['b.ts', 'no hits here\n'],
  ])
  const search = store()
  const tools = toolsOf(search)
  const caller = { ...CALLER, folder: root }
  const answer = await settled(tools, caller, 'needle')
  expect(answer).toContain('a.ts:1: const needle = 1')
  // The query is matched folded, as the session searches are.
  const folded = await settled(tools, caller, 'NEEDLE')
  expect(folded).toContain('a.ts:1: const needle = 1')
})

it('keeps the lines of one folder apart from another', async () => {
  const left = folder('left', [['a.ts', 'the needle of this folder\n']])
  const right = folder('right', [['a.ts', 'only right words\n']])
  const search = store()
  const tools = toolsOf(search)
  const fromLeft = await settled(tools, { ...CALLER, folder: left }, 'needle')
  expect(fromLeft).toContain('a.ts:1: the needle of this folder')
  const fromRight = await settled(tools, { ...CALLER, folder: right }, 'needle')
  expect(fromRight).not.toContain('the needle of this folder')
})

it('refuses unknown arguments, a wrong query and a wrong limit', async () => {
  const tools = new KnowledgeTools({
    search: async () => ({ matches: [], capped: false, indexing: null }),
  })
  await expect(tools.call(CALLER, SEARCH_CODE_TOOL, { query: 'x', extra: 1 })).rejects.toThrow(
    'Unknown argument extra',
  )
  await expect(tools.call(CALLER, SEARCH_CODE_TOOL, { query: '' })).rejects.toThrow('query')
  await expect(tools.call(CALLER, SEARCH_CODE_TOOL, { query: 'x', limit: 0 })).rejects.toThrow(
    'limit',
  )
  await expect(tools.call(CALLER, SEARCH_CODE_TOOL, { query: 'x', limit: 201 })).rejects.toThrow(
    'limit',
  )
  await expect(tools.call(CALLER, SEARCH_CODE_TOOL, { query: 'x'.repeat(201) })).rejects.toThrow(
    'query',
  )
})

it('names the build under way, and caps at the limit it was given', async () => {
  const root = folder('project', [
    ['f0.ts', 'word 0 of the build\n'],
    ['f1.ts', 'word 1 of the build\n'],
    ['f2.ts', 'word 2 of the build\n'],
  ])
  const search = store()
  const tools = toolsOf(search)
  const caller = { ...CALLER, folder: root }
  // The first search kicks the build; its answer says the index is still being built.
  const building = await tools.call(caller, SEARCH_CODE_TOOL, { query: 'word' })
  expect(texts(building)).toMatch(/index is still being built/)
  const built = await settled(tools, caller, 'word', { limit: 2 })
  const lines = built.split('\n')
  expect(lines.filter((line) => /^f\d\.ts:1:/.test(line))).toHaveLength(2)
  expect(built).toMatch(/more lines were left out/)
})
