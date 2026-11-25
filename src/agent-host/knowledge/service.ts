// The knowledge worker's work, apart from the worker itself so tests can run it in their own
// thread: it answers searches from the committed state of the index while the scan it kicked
// goes on in the background, so a search never waits for a build.

import { queryWords } from '@shared/search-fold'
import { CodeIndex, type CodeMatch } from './index'
import { Scanner, type ScannerOptions } from './scan'
import type {
  CodeSearchAnswer,
  KnowledgeReply,
  KnowledgeRequest,
  KnowledgeWorkerData,
} from './protocol'

/**
 * Opens the index the worker data names, reports that it is ready, and returns the handler that
 * answers each request in the order it arrives. Nothing is fatal: what fails goes back as an
 * `error` reply, and the next request tries again.
 */
export function startKnowledgeService(
  { root, file }: KnowledgeWorkerData,
  reply: (message: KnowledgeReply) => void,
  scanning?: ScannerOptions,
): (request: KnowledgeRequest) => void {
  const log = (level: 'info' | 'warn' | 'error', message: string): void =>
    reply({ type: 'log', level, message })
  let index: CodeIndex | null = null
  let scanner: Scanner | null = null
  let rebuilt = false
  // `drop` forgets the database and `close` ends the worker; only `open` brings it back.
  const open = (): boolean => {
    if (index) return true
    try {
      const made = CodeIndex.open(file, root, log)
      rebuilt = made.rebuilt
      index = made
      scanner = new Scanner(made, file, log, scanning)
    } catch (error) {
      log('error', `Could not open the code index: ${errorText(error)}`)
    }
    return index !== null
  }
  open()
  reply({ type: 'ready' })
  // `stop` closes the index as the scanner's owner; the service only drops its references.
  const forget = (): void => {
    scanner?.stop()
    scanner = null
    index = null
  }
  return (request) => {
    const answer = (run: () => unknown): void => {
      try {
        reply({ type: 'result', id: request.id, value: run() })
      } catch (error) {
        reply({ type: 'error', id: request.id, message: errorText(error) })
      }
    }
    switch (request.op) {
      case 'open':
        answer(() => ({ opened: open(), rebuilt, root }))
        return
      case 'ensure':
        answer(() => scanner?.ensure(request.files) ?? null)
        return
      case 'search':
        answer(() =>
          index ? search(index, scanner, request.query, request.glob, request.limit) : nothing(),
        )
        return
      case 'drop':
        answer(() => {
          forget()
          CodeIndex.remove(file)
          return null
        })
        return
      case 'close':
        answer(() => {
          forget()
          return null
        })
        return
    }
  }
}

/**
 * The lines that hold every word of the query, within the files that hold them all: `limit + 1`
 * matches are gathered so the answer can say more were left out.
 */
function search(
  index: CodeIndex,
  scanner: Scanner | null,
  query: string,
  glob: string | undefined,
  limit: number,
): CodeSearchAnswer {
  const words = queryWords(query)
  const current = scanner?.current() ?? index
  const files = current.find(words)
  const matches: CodeMatch[] = []
  // One past the limit is gathered too, so an answer of exactly the limit can say nothing was
  // left out; the gather breaks off only past it.
  for (const file of files) {
    if (glob !== undefined && !file.path.startsWith(glob)) continue
    for (const line of index.lineMatches(file.text, words)) {
      if (matches.length > limit) break
      matches.push({ path: file.path, line: line.line, text: line.text })
    }
    if (matches.length > limit) break
  }
  return {
    matches: matches.slice(0, limit),
    capped: matches.length > limit,
    indexing: current.build(),
  }
}

function nothing(): CodeSearchAnswer {
  return { matches: [], capped: false, indexing: null }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
