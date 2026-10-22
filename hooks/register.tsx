import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Usage } from '../types'

// Bumped so the band redraws; the figures themselves are read live while drawing.
const tick = atom({ plugin: 'usage-bar', key: 'tick' } as const, 0)
// Token count at which auto-compaction runs; null until measured or when it is off.
const threshold = atom({ plugin: 'usage-bar', key: 'threshold' } as const, null as number | null)
// '' until first read; null when the session is not in a git repository.
const branch = atom({ plugin: 'usage-bar', key: 'branch' } as const, '' as string | null)
// True from a Compact press until /compact finishes.
const compacting = atom({ plugin: 'usage-bar', key: 'compacting' } as const, false)
// When the main thread's last API request started, in $.clock.now() milliseconds; null before the first.
const lastRequest = atom({ plugin: 'usage-bar', key: 'lastRequest' } as const, null as number | null)

// Each request renews the prompt cache for this long.
const cacheTtlMs = 60 * 60_000

// Commands that can move the auto-compact threshold or the token count.
const usageCommands = new Set(['autocompact', 'model', 'compact', 'clear'])

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)))

const kilo = (tokens: number) => (tokens < 1000 ? `${tokens}` : `${Math.round(tokens / 1000)}k`)

// 0% used -> hue 120 (green); 100% used -> hue 0 (red).
// The host's UTC offset in minutes; the module's own clock has no time zone. null until read.
const utcOffset = atom({ plugin: 'usage-bar', key: 'utcOffset' } as const, null as number | null)

// Local wall-clock time of an epoch, as '14:05'.
const clockTime = (epochMs: number, offsetMinutes: number) => {
  const local = new Date(epochMs + offsetMinutes * 60_000)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`
}

async function refreshUtcOffset($: EngineInterface) {
  const run = await $.process.run(['date', '+%z'])
  const match = /^([+-])(\d{2})(\d{2})$/.exec(run.stdout.trim())
  if (run.exitCode === 0 && match) {
    const minutes = Number(match[2]) * 60 + Number(match[3])
    await update($, utcOffset, () => (match[1] === '-' ? -minutes : minutes))
  }
}

const greenToRed = (used: number) => `hsl(${Math.round((100 - used) * 1.2)}, 80%, 45%)`

// 0% used -> blue; 100% used -> red; straight RGB blend, so it passes through purple.
const blueToRed = (used: number) => {
  const t = used / 100
  const from = [59, 130, 246]
  const to = [239, 68, 68]
  const [r, g, b] = from.map((f, i) => Math.round(f + (to[i]! - f) * t))

  return `rgb(${r}, ${g}, ${b})`
}

async function readBranch($: EngineInterface): Promise<string | null> {
  const named = await $.process.run(['git', 'symbolic-ref', '--short', '-q', 'HEAD'])
  if (named.exitCode === 0 && named.stdout.trim() !== '') {
    return named.stdout.trim()
  }
  // Detached HEAD shows the short commit; outside a repository this fails too.
  const short = await $.process.run(['git', 'rev-parse', '--short', 'HEAD'])

  return short.exitCode === 0 ? short.stdout.trim() : null
}

async function refreshBranch($: EngineInterface) {
  try {
    const name = await readBranch($)
    await update($, branch, () => name)
  } catch {
    // git missing or unreadable: keep the last label rather than fail the caller
  }
}

async function refreshThreshold($: EngineInterface) {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  const at = context.breakdown?.autoCompactThreshold ?? context.breakdown?.rawMaxTokens ?? null
  await update($, threshold, () => at)
}

async function measure($: EngineInterface, compactAt: number | null, offset: number | null): Promise<Usage> {
  const usage = await $.session.usage()
  const five = usage.rateLimits.find(l => l.kind === 'five_hour')
  const tokens = usage.context.tokens ?? null
  const limit = compactAt ?? usage.context.window
  const resetsAt = five?.resetsAt ? Date.parse(five.resetsAt) : Number.NaN

  return {
    compact: clamp(((tokens ?? 0) / limit) * 100),
    compactLeft: Math.max(0, limit - (tokens ?? 0)),
    contextTokens: tokens,
    fiveHour: five ? clamp(five.percentUsed) : null,
    fiveHourReset: Number.isNaN(resetsAt) || offset === null ? null : clockTime(resetsAt, offset),
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await refreshThreshold($)
    await refreshBranch($)
    await refreshUtcOffset($)
    // Redraws the cache countdown while the session is idle; a reload runs this again with the old timer gone.
    $.clock.every(60_000, () => update($, tick, n => n + 1))

    return next(e)
  })

  // A subagent's requests run on a cache of their own: only the main thread's renew this one.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, lastRequest, () => now)
    }

    return yield* next(e)
  })

  on('command.run', async ($, e, next) => {
    const ran = await next(e)
    if (usageCommands.has(e.command)) {
      await refreshThreshold($)
      await update($, tick, n => n + 1)
    }

    return ran
  })

  // Keeps the figures current during a long turn, which fires turn.complete only at its end.
  // Also before the call: one waiting on the user, such as a question, can run for minutes.
  on('tool.call', async ($, e, next) => {
    await update($, tick, n => n + 1)
    const result = await next(e)
    await refreshBranch($)
    await update($, tick, n => n + 1)

    return result
  })

  on('turn.complete', async ($, e, next) => {
    await refreshThreshold($)
    await refreshBranch($)
    await update($, tick, n => n + 1)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    const { Box, Button, Text } = $.ui.resolve(e)
    await read($, tick)
    const branchName = await read($, branch)
    const { compact, compactLeft, contextTokens, fiveHour, fiveHourReset } = await measure(
      $,
      await read($, threshold),
      await read($, utcOffset),
    )
    const isCompacting = await read($, compacting)
    // VS Code shows a countdown of its own.
    const requestedAt = e.surface === 'desktop' ? await read($, lastRequest) : null
    const offset = await read($, utcOffset)
    const cacheLeftMs = requestedAt === null ? 0 : requestedAt + cacheTtlMs - (await $.clock.now())
    // Runs /compact as if typed: $.session.compact is not available in an SDK session such as the VS Code panel.
    const startCompaction = async () => {
      await update($, compacting, () => true)
      // Not awaited: the command waits for the session to go idle, which may wait for this handler.
      void $.command
        .run({ command: 'compact', args: '' })
        .then(async () => {
          await refreshThreshold($)
          await update($, tick, n => n + 1)
        })
        .catch(async (error: unknown) => {
          await $.ui.toast(`Cannot compact: ${error instanceof Error ? error.message : String(error)}`)
        })
        .finally(() => update($, compacting, () => false))
    }

    // Another plugin may draw into this band too (crew): keep its tree, above this line.
    const above = await next(e)

    // No width on a Box around the engine's own tree: the engine refuses that.
    return (
      <Box flexDirection="column">
      {above}
      <Box alignItems="center" width="100%">
        <Box gap={3} flexShrink={0}>
          {fiveHour !== null && (
            <Text color={greenToRed(fiveHour)}>
              {fiveHourReset === null ? `5h limit ${fiveHour}%` : `5h limit ${fiveHour}% @ ${fiveHourReset}`}
            </Text>
          )}
          {contextTokens === null ? (
            <Text dimColor>Context: n/a</Text>
          ) : (
            <Text>{`Context ${kilo(contextTokens)}`}</Text>
          )}
          <Box gap={1}>
            {isCompacting ? (
              <Text dimColor>Compacting…</Text>
            ) : (
              <Button plain dimColor label="Compact" onPress={startCompaction} />
            )}
            <Text color={blueToRed(compact)}>{`${kilo(compactLeft)} left`}</Text>
          </Box>
          {requestedAt !== null &&
            (cacheLeftMs > 0 ? (
              <Text color={greenToRed(clamp(100 - (cacheLeftMs / cacheTtlMs) * 100))}>
                {offset === null
                  ? `Cache ${Math.floor(cacheLeftMs / 60_000)}m`
                  : `Cache ${Math.floor(cacheLeftMs / 60_000)}m @ ${clockTime(requestedAt + cacheTtlMs, offset)}`}
              </Text>
            ) : (
              <Text dimColor>Cache expired</Text>
            ))}
        </Box>
        {branchName !== '' && (
          <Box flexGrow={1} flexShrink={1} minWidth={0} justifyContent="flex-end" marginLeft={3}>
            <Text dimColor={branchName === null} wrap="truncate-end">
              {branchName === null ? 'not in repo' : `⎇ ${branchName}`}
            </Text>
          </Box>
        )}
      </Box>
      </Box>
    )
  })
}
