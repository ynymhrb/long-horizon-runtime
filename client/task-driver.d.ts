export declare const DRIVER_REDRIVE_GRACE_MS: number

export interface SessionDriverStatus {
  readonly outcome: 'pending' | 'injected' | 'failed'
  readonly at: number
  readonly reason?: string
}

export interface DriveBoundSessionInput {
  readonly sessionId: string
  readonly taskId: string
  readonly controlRevision: number
  readonly objective?: string
  readonly drive: (sessionId: string, taskId: string, objective?: string) => Promise<boolean>
  readonly now?: number
  readonly graceMs?: number
}

export interface DriveBoundSessionResult {
  readonly outcome: 'injected' | 'failed' | 'skipped'
  readonly status: SessionDriverStatus | undefined
}

export function sessionDriverKey(sessionId: string, taskId: string, controlRevision: number): string
export function sessionDriverStatus(sessionId: string, taskId: string, controlRevision: number): SessionDriverStatus | undefined
export function canDriveSessionDriver(status: SessionDriverStatus | undefined, now?: number, graceMs?: number): boolean
export function driveBoundSessionOnce(input: DriveBoundSessionInput): Promise<DriveBoundSessionResult>
