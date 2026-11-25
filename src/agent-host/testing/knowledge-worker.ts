// The knowledge service in the test's own thread, behind the worker interface: messages are
// cloned and delivered later, as between threads, but no bundled worker file is needed.

import type { ScannerOptions } from '../knowledge/scan'
import type { KnowledgeReply, KnowledgeRequest, KnowledgeWorkerData } from '../knowledge/protocol'
import { startKnowledgeService } from '../knowledge/service'
import type { KnowledgeWorker } from '../knowledge/store'

export function inKnowledgeWorker(
  data: KnowledgeWorkerData,
  scanning?: Partial<ScannerOptions>,
): KnowledgeWorker {
  let onMessage: ((reply: KnowledgeReply) => void) | null = null
  let onExit: ((error: Error | null) => void) | null = null
  let handle: ((request: KnowledgeRequest) => void) | null = null
  let stopped = false
  const deliver = (reply: KnowledgeReply): void => {
    const copy = structuredClone(reply)
    setImmediate(() => {
      if (!stopped) onMessage?.(copy)
    })
  }
  // Started like a real worker: after the caller has attached its listeners.
  setImmediate(() => {
    if (!stopped) handle = startKnowledgeService(data, deliver, scanning)
  })
  return {
    postMessage: (request) => {
      const copy = structuredClone(request)
      setImmediate(() => {
        if (!stopped) handle?.(copy)
      })
    },
    onMessage: (listener) => {
      onMessage = listener
    },
    onExit: (listener) => {
      onExit = listener
    },
    terminate: async () => {
      if (stopped) return
      stopped = true
      handle?.({ id: 0, op: 'close' })
      onExit?.(null)
    },
  }
}
