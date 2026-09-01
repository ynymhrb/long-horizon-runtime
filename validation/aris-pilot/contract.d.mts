export interface PilotCommand { readonly executable: string; readonly args: string[]; readonly cwd?: string; readonly env?: Record<string, string> }
export interface PilotGroup { readonly id: 'aris_only' | 'aris_plus_long_task'; readonly longTaskPlugin: { readonly enabled: boolean }; readonly command: PilotCommand }
export interface PilotConfig { readonly version: 1; readonly id: string; readonly shared: Record<string, unknown>; readonly groups: readonly [PilotGroup, PilotGroup] }
export declare function validatePilotConfig(value: unknown): PilotConfig
export declare function assertComparable(config: PilotConfig): void
