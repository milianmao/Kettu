// Entry of the knowledge worker, a worker_threads thread of the agent host that owns a project's
// code index. Main builds it with `?modulePath` and passes its path in `host:init`.

import { parentPort, workerData } from 'node:worker_threads'
import type { KnowledgeRequest, KnowledgeWorkerData } from './protocol'
import { startKnowledgeService } from './service'

const port = parentPort!
const handle = startKnowledgeService(workerData as KnowledgeWorkerData, (reply) =>
  port.postMessage(reply),
)
port.on('message', (request: KnowledgeRequest) => handle(request))
