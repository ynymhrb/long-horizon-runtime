import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { TaskControlApi } from './task-api.js';
import { TaskUiApi } from './task-ui-api.js';
import { longTaskRemote } from '../client/remote-contract.js';
/** Browser-safe host query surface; payloads deliberately remain JSON values. */
export class LongTaskRemote extends TypertRemoteService {
    runtime;
    ui;
    constructor(ctx, runtime) {
        super(ctx, 'longTasks');
        this.runtime = runtime;
        this.ui = new TaskUiApi(runtime, new TaskControlApi(runtime));
    }
    get(taskId) { return this.runtime.getStatus(taskId) ?? null; }
    list() { return this.runtime.listGoals(); }
    listTasks(input) { return this.ui.listTasks(input); }
    getTask(input) { return this.ui.getTask(input); }
    getTaskAudit(input) { return this.ui.getTaskAudit(input); }
    getTaskGraph(input) { return this.ui.getTaskGraph(input); }
    listTaskEvents(input) { return this.ui.listTaskEvents(input); }
    getCurrentTaskForSession(input) { return this.ui.getCurrentTaskForSession(input); }
    updateTask(input) { return this.ui.updateTask(input); }
    attachCurrentSession(input) { return this.ui.attachCurrentSession(input); }
    setCurrentSession(input) { return this.ui.setCurrentSession(input); }
    clearCurrentSession(input) { return this.ui.clearCurrentSession(input); }
    rejectReplan(input) { return this.ui.rejectReplan(input); }
    editTaskGoal(input) { return this.ui.editTaskGoal(input); }
    acceptReplan(input) { return this.ui.acceptReplan(input); }
    archiveTask(input) { return this.ui.archiveTask(input); }
    restoreTask(input) { return this.ui.restoreTask(input); }
    getTaskNavigation(input) { return this.ui.getTaskNavigation(input); }
}
/** Separate host-plane loader row: Gateway can enumerate this active Service. */
export const name = 'long-task-runtime-remote';
export const inject = ['longTaskRuntime', 'typert'];
export function apply(ctx) {
    const runtime = ctx.get('longTaskRuntime');
    if (runtime === undefined)
        throw new Error('longTaskRuntime service is unavailable');
    const registry = ctx.get('typert');
    if (registry === undefined)
        throw new Error('Typert registry is unavailable');
    new LongTaskRemote(ctx, runtime);
    registry.register({
        package: longTaskRemote.package, face: 'host', schemas: [],
        model: { services: [], events: [], objects: [] }, invocations: longTaskRemote.descriptors,
    });
}
