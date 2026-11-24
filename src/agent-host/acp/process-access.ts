// OMP and Antigravity expose ordinary modes over ACP but take Full access as a process flag.
// Kettu's session router changes that flag for one session at a time.

import { ANTIGRAVITY_FULL_ACCESS, OMP_FULL_ACCESS } from '@shared/agents'
import { isConfigValue, type ConfigOption } from '@shared/thread'
import { t } from '../i18n'
import { compareVersions } from '../versions'
import { MODE_OPTION } from './agy-plan'

export const FULL_ACCESS = ANTIGRAVITY_FULL_ACCESS
export type ProcessAccessMode = typeof FULL_ACCESS | typeof OMP_FULL_ACCESS
export const FULL_ACCESS_VERSION = '1.5.9'
/** agy's own mode while its process runs with the flag: Plan mode would still only plan. */
export const HELD_MODE = 'default'
/**
 * Where the session router names the flag `agy acp --help` lists in `initialize`'s answer, and
 * where a request asks it to start the session's process with it (`SESSION_FLAG_META` there).
 */
export const SESSION_FLAG_META = 'sh.kettu/session-flag'

/** Whether agy offers full access: a version it was checked on, behind a router that found the flag. */
export function offersFullAccess(version: string | null, meta: unknown): boolean {
  if (version === null || compareVersions(version, FULL_ACCESS_VERSION) < 0) return false
  const flag = (meta as Record<string, unknown> | null | undefined)?.[SESSION_FLAG_META]
  return typeof flag === 'string' && flag !== ''
}

/** Recognizes the permission flag the session router located in OMP's top-level help. */
export function offersOmpFullAccess(meta: unknown): boolean {
  return (
    (meta as Record<string, unknown> | null | undefined)?.[SESSION_FLAG_META] ===
    '--approval-mode=yolo'
  )
}

/** Adds the process-backed selection to the harness's own modes. */
export function withFullAccess(
  config: readonly ConfigOption[],
  mode: ProcessAccessMode,
  full: boolean,
): ConfigOption[] {
  return config.map((option) => {
    if (option.id !== MODE_OPTION || option.type !== 'select') return option
    const choices = (option.choices ?? []).filter((choice) => choice.value !== mode)
    choices.push({
      value: mode,
      name: t('antigravity.mode.fullAccess.name'),
      description:
        mode === OMP_FULL_ACCESS
          ? t('omp.fullAccessDescription')
          : t('antigravity.mode.fullAccess.description'),
    })
    const value = full ? mode : option.value === mode ? HELD_MODE : option.value
    return { ...option, choices, value }
  })
}

/**
 * The session's values to set again on a new process, in order: the model first, since the levels
 * it offers follow it, then the rest; never the mode, which the switch sets itself.
 */
export function restoreOrder(before: readonly ConfigOption[]): ConfigOption[] {
  return before
    .filter((option) => option.id !== MODE_OPTION)
    .toSorted((a, b) => Number(b.category === 'model') - Number(a.category === 'model'))
}

/** Whether `config` lacks `option`'s value and offers it. */
export function lacks(config: readonly ConfigOption[], option: ConfigOption): boolean {
  const now = config.find((candidate) => candidate.id === option.id)
  return !!now && now.value !== option.value && isConfigValue(now, option.value)
}
