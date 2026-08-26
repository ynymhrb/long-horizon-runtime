import type { DatabaseSync } from 'node:sqlite';
import type { RuntimeEvent } from './event-store.js';
/** Creates read models which are deliberately disposable: runtime_events is authoritative. */
export declare function createProjectionSchema(db: DatabaseSync): void;
/** Applies exactly one durable event to materialized views. */
export declare function projectEvent(db: DatabaseSync, event: RuntimeEvent, seq: number): void;
