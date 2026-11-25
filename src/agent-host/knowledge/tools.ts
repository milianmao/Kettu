// The code search tool of the artifacts service: an agent searches the text of the files in its
// session's working directory, through the host's knowledge store. The answers are the project's
// own files, which an artifact tool that reads sources needs leave for too, so it is not in the
// server's auto-allow list; the harness asks the user once.

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { Caller } from '../artifacts/tools'
import type { CodeSearchAnswer } from './protocol'

export const SEARCH_CODE_TOOL = 'search_code'

const QUERY_CHARS = 200
const LIMIT_MAX = 200
const DEFAULT_LIMIT = 50

/** Every code search tool, in the group of its own it is listed in on the Marketplace page. */
export const KNOWLEDGE_TOOLS: Tool[] = [
  {
    name: SEARCH_CODE_TOOL,
    title: 'Search the project code',
    description:
      "Searches the text of the files in this session's working directory. Returns " +
      'path:line: the line, up to 50 at a time. The index updates on demand and may lag ' +
      'the latest edits by seconds; grep yourself when you need exact freshness.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          maxLength: QUERY_CHARS,
          description: 'The words to find; a line matches when it holds every one.',
        },
        glob: {
          type: 'string',
          maxLength: QUERY_CHARS,
          description: 'A path prefix to keep, such as src/.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: LIMIT_MAX,
          description: `Lines to answer with, at most ${LIMIT_MAX}; the default is ${DEFAULT_LIMIT}.`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
]

export function isKnowledgeToolName(name: string): boolean {
  return name === SEARCH_CODE_TOOL
}

export interface KnowledgeToolsDeps {
  /**
   * Searches the folder the caller's session works in, or its project when it works in no folder
   * of its own. The index is derived, so nothing is fatal: a folder that is gone answers with
   * nothing.
   */
  search(
    folder: string,
    query: string,
    opts: { glob?: string; limit?: number },
  ): Promise<CodeSearchAnswer>
}

type Args = Record<string, unknown>

const ALLOWED: Record<string, readonly string[]> = {
  [SEARCH_CODE_TOOL]: ['query', 'glob', 'limit'],
}

function args(name: string, input: unknown): Args {
  if (input === undefined) return {}
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('The arguments must be an object.')
  }
  const unknown = Object.keys(input).find((key) => !ALLOWED[name]!.includes(key))
  if (unknown !== undefined) throw new Error(`Unknown argument ${unknown}.`)
  return input as Args
}

function queryOf(o: Args): string {
  const value = o.query
  if (typeof value !== 'string' || value.trim() === '' || value.length > QUERY_CHARS) {
    throw new Error(`query must be 1 to ${QUERY_CHARS} characters.`)
  }
  return value.trim()
}

function globOf(o: Args): string | undefined {
  const value = o.glob
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > QUERY_CHARS) {
    throw new Error(`glob must be at most ${QUERY_CHARS} characters.`)
  }
  return value
}

function limitOf(o: Args): number {
  const value = o.limit
  if (value === undefined) return DEFAULT_LIMIT
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > LIMIT_MAX) {
    throw new Error(`limit must be a whole number from 1 to ${LIMIT_MAX}.`)
  }
  return value
}

function done(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

export class KnowledgeTools {
  constructor(private readonly deps: KnowledgeToolsDeps) {}

  /** Serves a call; a bad argument becomes a tool error whose text says why. */
  async call(caller: Caller, name: string, input: unknown): Promise<CallToolResult> {
    if (!isKnowledgeToolName(name)) throw new Error(`Unknown tool ${name}`)
    const o = args(name, input)
    const answer = await this.deps.search(caller.folder ?? caller.project, queryOf(o), {
      glob: globOf(o),
      limit: limitOf(o),
    })
    const lines = answer.matches.map((match) => `${match.path}:${match.line}: ${match.text}`)
    if (answer.capped) {
      lines.push('(more lines were left out; search within a path prefix to narrow)')
    }
    if (answer.indexing !== null) {
      lines.push(
        `(the index is still being built, ${answer.indexing.done} of ${answer.indexing.total} ` +
          'files; results are partial)',
      )
    }
    return done(
      lines.length === 0
        ? 'No matches. The index may lag the latest edits by seconds.'
        : lines.join('\n'),
    )
  }
}
