export type Usage = {
  compact: number
  compactLeft: number
  contextTokens: number | null
  fiveHour: number | null
  fiveHourReset: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'usage-bar': { tick: number; threshold: number | null; branch: string | null; compacting: boolean; utcOffset: number | null; lastRequest: number | null }
  }
}
