import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

test('draws one line per window with usage', async ($, on) => {
  on('session.usage', async () => ({
    value: {
    startedAt: 0,
    context: { window: 1000, tokens: 250, percent: 25, breakdown: { autoCompactThreshold: 500 } },
    rateLimits: [{ kind: 'five_hour', percentUsed: 60, resetsAt: '2026-01-01T02:05:30Z' }],
  } }))

  // Nothing else draws into the band: an empty tree stands for it.
  on('ui.render', async ($, e) => h($.ui.resolve(e).Box, {}))
  const mounted = await $.ui.mount({
    plugin: 'usage-bar',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false } as never,
  })
  const tree = JSON.stringify(await mounted.drawn())
  expect(tree).toContain('Context 250')
  expect(tree).toContain('"label":"Compact"')
  expect(tree).toContain('750 left')
  expect(tree).toContain('5h limit 60%')
})

test('leaves out the 5h limit when the provider reports none', async ($, on) => {
  on('session.usage', async () => ({
    value: { startedAt: 0, context: { window: 1000, tokens: 250, percent: 25 }, rateLimits: [] },
  }))

  // Nothing else draws into the band: an empty tree stands for it.
  on('ui.render', async ($, e) => h($.ui.resolve(e).Box, {}))
  const mounted = await $.ui.mount({
    plugin: 'usage-bar',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false } as never,
  })
  const tree = JSON.stringify(await mounted.drawn())
  expect(tree).not.toContain('5h limit')
  expect(tree).toContain('Context 250')
})

test('pressing Compact compacts the session', async ($, on) => {
  on('session.usage', async () => ({
    value: { startedAt: 0, context: { window: 1000, tokens: 250, percent: 25 }, rateLimits: [] },
  }))
  let compacted = 0
  on('command.run', { command: 'compact' }, async () => {
    compacted++
    return { value: { text: '' } } as never
  })

  // Nothing else draws into the band: an empty tree stands for it.
  on('ui.render', async ($, e) => h($.ui.resolve(e).Box, {}))
  const mounted = await $.ui.mount({
    plugin: 'usage-bar',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false } as never,
  })
  await mounted.press({ key: 'Compact' })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(compacted).toBe(1)
})

test('keeps what another plugin drew into the band, above the usage line', async ($, on) => {
  on('session.usage', async () => ({
    value: { startedAt: 0, context: { window: 1000, tokens: 250, percent: 25 }, rateLimits: [] },
  }))

  on('ui.render', async ($, e) => h($.ui.resolve(e).Text, {}, 'crew: 1 running'))
  const mounted = await $.ui.mount({
    plugin: 'usage-bar',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false } as never,
  })
  const tree = JSON.stringify(await mounted.drawn())
  expect(tree).toContain('crew: 1 running')
  expect(tree.indexOf('crew: 1 running')).toBeLessThan(tree.indexOf('Context 250'))
})

const idle = { value: { startedAt: 0, context: { window: 1000, tokens: 250, percent: 25 }, rateLimits: [] } }

// One step of the turn, read to its end; a subagent's carries its agentId.
async function step($: Parameters<TestBody>[0], agentId?: string) {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1, ...(agentId ? { agentId } : {}) })
  for await (const _ of stream) {
  }
}

async function band($: Parameters<TestBody>[0], surface: 'desktop' | 'vscode') {
  return $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: { hasSurvey: false } as never })
}

test('counts the cache down from the last main-thread request, on desktop only', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.usage', async () => idle)
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [] } as never
  })
  on('ui.render', async ($, e) => h($.ui.resolve(e).Box, {}))

  await step($)
  await clock.advance(23 * 60_000 + 30_000)
  await step($, 'sub-1')

  expect(JSON.stringify(await (await band($, 'desktop')).drawn())).toContain('Cache 36m')
  expect(JSON.stringify(await (await band($, 'vscode')).drawn())).not.toContain('Cache')

  await clock.advance(37 * 60_000)
  expect(JSON.stringify(await (await band($, 'desktop')).drawn())).toContain('Cache expired')
})

test('redraws the countdown each minute while idle', async ($, on) => {
  const clock = mock.clock(on)
  on('session.usage', async () => idle)
  on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as never)
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [] } as never
  })
  on('ui.render', async ($, e) => h($.ui.resolve(e).Box, {}))

  on('session.start', async () => ({ cwd: '/' }) as never)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await step($)
  const mounted = await band($, 'desktop')
  expect(JSON.stringify(await mounted.drawn())).toContain('Cache 60m')

  await clock.advance(5 * 60_000)
  expect(JSON.stringify(await mounted.drawn())).toContain('Cache 55m')
})
