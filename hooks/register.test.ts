import { expect, test } from 'claude-code/testing'

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
