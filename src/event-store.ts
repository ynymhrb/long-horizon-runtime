import { DatabaseSync } from 'node:sqlite'

/** Durable event accepted by the runtime event log. */
export interface RuntimeEvent {
  readonly type: string
  readonly goalId: string
  readonly taskId?: string
  readonly payload: Record<string, unknown>
}

/** Read model for a goal. */
export interface GoalProjection {
  readonly id: string
  readonly objective: string
  readonly state: string
  readonly revision: number
}

/** SQLite append-only event log with rebuildable projections. */
export class RuntimeEventStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        type TEXT NOT NULL,
        goal_id TEXT NOT NULL,
        task_id TEXT,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        objective TEXT NOT NULL,
        state TEXT NOT NULL,
        revision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_attempts (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        state TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runtime_events_goal_seq ON runtime_events(goal_id, seq);
      CREATE INDEX IF NOT EXISTS task_attempts_task ON task_attempts(task_id);
    `)
  }

  /** Append events and update projections within the current transaction. */
  append(events: readonly RuntimeEvent[]): void {
    const insert = this.db.prepare('INSERT INTO runtime_events (type, goal_id, task_id, payload_json) VALUES (?, ?, ?, ?)')
    for (const event of events) {
      insert.run(event.type, event.goalId, event.taskId ?? null, JSON.stringify(event.payload))
      this.project(event)
    }
  }

  /** Run a group of event writes atomically. */
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Rebuild all materialized views exclusively from the append-only log. */
  rebuild(): void {
    this.transaction(() => {
      this.db.exec('DELETE FROM goals; DELETE FROM task_attempts;')
      const events = this.db.prepare('SELECT type, goal_id, task_id, payload_json FROM runtime_events ORDER BY seq').all() as Array<{
        type: string; goal_id: string; task_id: string | null; payload_json: string
      }>
      for (const row of events) this.project({
        type: row.type,
        goalId: row.goal_id,
        ...(row.task_id === null ? {} : { taskId: row.task_id }),
        payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      })
    })
  }

  /** Query the goal projection. */
  getGoal(goalId: string): GoalProjection | undefined {
    const row = this.db.prepare('SELECT id, objective, state, revision FROM goals WHERE id = ?').get(goalId) as GoalProjection | undefined
    return row
  }

  /** List attempts for a logical task in creation order. */
  listAttempts(taskId: string): Array<{ id: string; state: string }> {
    return this.db.prepare('SELECT id, state FROM task_attempts WHERE task_id = ? ORDER BY rowid').all(taskId) as Array<{ id: string; state: string }>
  }

  /** Close the owned SQLite connection. */
  close(): void {
    this.db.close()
  }

  private project(event: RuntimeEvent): void {
    switch (event.type) {
      case 'GoalCreated':
        this.db.prepare('INSERT INTO goals (id, objective, state, revision) VALUES (?, ?, ?, ?)').run(
          event.goalId, String(event.payload.objective), 'DRAFT', 0,
        )
        return
      case 'PlanApplied':
        this.db.prepare('UPDATE goals SET state = ?, revision = ? WHERE id = ?').run('RUNNING', Number(event.payload.revision), event.goalId)
        return
      case 'TaskAttemptStarted':
        if (event.taskId === undefined) throw new Error('TaskAttemptStarted requires taskId')
        this.db.prepare('INSERT INTO task_attempts (id, goal_id, task_id, state) VALUES (?, ?, ?, ?)').run(
          String(event.payload.attemptId), event.goalId, event.taskId, 'RUNNING',
        )
        return
      case 'TaskCompleted':
        this.db.prepare('UPDATE task_attempts SET state = ? WHERE id = ?').run('SUCCEEDED', String(event.payload.attemptId))
        return
      default:
        return
    }
  }
}
