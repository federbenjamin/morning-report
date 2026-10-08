export type Remember = string | null

declare module 'claude-code' {
  interface PluginState {
    'morning-report': { remember: Remember }
  }
}
