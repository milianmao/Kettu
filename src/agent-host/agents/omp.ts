import type { AgentDefinition } from '../catalog'

export const OMP: AgentDefinition = {
  id: 'omp',
  limitsReason: 'not-yet-supported',
  name: 'OMP',
  registryId: 'omp',
  // OMP takes its approval policy at startup and lists the flags in its top-level help.
  launch: {
    kind: 'binary',
    command: 'omp',
    args: ['acp'],
    perSession: true,
    sessionFlag: '--approval-mode=yolo',
    sessionDefaultFlag: '--approval-mode=always-ask',
    rootFlagHelp: true,
  },
  install: {
    hint: 'detect.hint.omp',
    url: 'https://omp.sh',
  },
  // The routes its README lists for macOS and Linux, checked on 2026-11-03. The Windows script is
  // PowerShell, which is not a route.
  installs: {
    script: 'https://omp.sh/install',
    scriptShell: 'sh',
    scriptBin: ['.local', 'bin'],
    scriptHome: ['.local', 'bin'],
    brew: 'can1357/tap/omp',
    order: ['script', 'brew'],
  },
}
