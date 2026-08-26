import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { TaskControlApi } from './task-api.js';
import { TaskUiApi } from './task-ui-api.js';
/** Browser-safe host query surface; payloads deliberately remain JSON values. */
export class LongTaskRemote extends TypertRemoteService {
    runtime;
    ui;
    constructor(ctx, runtime) {
        super(ctx, 'longTasks');
        this.runtime = runtime;
        this.ui = new TaskUiApi(runtime, new TaskControlApi(runtime));
        for (const initialize of remoteInitializers)
            initialize.call(this);
    }
    get(taskId) { return this.runtime.getStatus(taskId) ?? null; }
    list() { return this.runtime.listGoals(); }
    listTasks(input) { return this.ui.listTasks(input); }
    getTask(input) { return this.ui.getTask(input); }
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
export const inject = ['longTaskRuntime'];
export function apply(ctx) {
    const runtime = ctx.get('longTaskRuntime');
    if (runtime === undefined)
        throw new Error('longTaskRuntime service is unavailable');
    new LongTaskRemote(ctx, runtime);
}
// The host's Remote decorator uses the standard decorator initializer API.
// Invoke the same public API explicitly so this source stays executable by
// Node's strip-only TypeScript loader during DSH/plugin test composition.
const remoteInitializers = [];
Remote('get')(LongTaskRemote.prototype.get, {
    kind: 'method', name: 'get', static: false, private: false,
    addInitializer(initializer) { remoteInitializers.push(initializer); },
    access: { has: () => true, get: (object) => object.get },
    metadata: undefined,
});
Remote('list')(LongTaskRemote.prototype.list, {
    kind: 'method', name: 'list', static: false, private: false,
    addInitializer(initializer) { remoteInitializers.push(initializer); },
    access: { has: () => true, get: (object) => object.list },
    metadata: undefined,
});
Remote('listTasks')(LongTaskRemote.prototype.listTasks, {
    kind: 'method', name: 'listTasks', static: false, private: false,
    addInitializer(initializer) { remoteInitializers.push(initializer); },
    access: { has: () => true, get: (object) => object.listTasks }, metadata: undefined,
});
Remote('getTask')(LongTaskRemote.prototype.getTask, {
    kind: 'method', name: 'getTask', static: false, private: false,
    addInitializer(initializer) { remoteInitializers.push(initializer); },
    access: { has: () => true, get: (object) => object.getTask }, metadata: undefined,
});
Remote('getTaskGraph')(LongTaskRemote.prototype.getTaskGraph, {
    kind: 'method', name: 'getTaskGraph', static: false, private: false,
    addInitializer(initializer) { remoteInitializers.push(initializer); },
    access: { has: () => true, get: (object) => object.getTaskGraph }, metadata: undefined,
});
Remote('listTaskEvents')(LongTaskRemote.prototype.listTaskEvents, {
    kind: 'method', name: 'listTaskEvents', static: false, private: false,
    addInitializer(initializer) { remoteInitializers.push(initializer); },
    access: { has: () => true, get: (object) => object.listTaskEvents }, metadata: undefined,
});
Remote('getCurrentTaskForSession')(LongTaskRemote.prototype.getCurrentTaskForSession, {
    kind: 'method', name: 'getCurrentTaskForSession', static: false, private: false,
    addInitializer(initializer) { remoteInitializers.push(initializer); },
    access: { has: () => true, get: (object) => object.getCurrentTaskForSession }, metadata: undefined,
});
Remote('updateTask')(LongTaskRemote.prototype.updateTask, {
    kind: 'method', name: 'updateTask', static: false, private: false,
    addInitializer(initializer) { remoteInitializers.push(initializer); },
    access: { has: () => true, get: (object) => object.updateTask }, metadata: undefined,
});
Remote('attachCurrentSession')(LongTaskRemote.prototype.attachCurrentSession, {
    kind: 'method', name: 'attachCurrentSession', static: false, private: false,
    addInitializer(initializer) { remoteInitializers.push(initializer); },
    access: { has: () => true, get: (object) => object.attachCurrentSession }, metadata: undefined,
});
Remote('setCurrentSession')(LongTaskRemote.prototype.setCurrentSession, {
    kind: 'method', name: 'setCurrentSession', static: false, private: false,
    addInitializer(initializer) { remoteInitializers.push(initializer); },
    access: { has: () => true, get: (object) => object.setCurrentSession }, metadata: undefined,
});
Remote('clearCurrentSession')(LongTaskRemote.prototype.clearCurrentSession, {
    kind: 'method', name: 'clearCurrentSession', static: false, private: false,
    addInitializer(initializer) { remoteInitializers.push(initializer); },
    access: { has: () => true, get: (object) => object.clearCurrentSession }, metadata: undefined,
});
Remote('rejectReplan')(LongTaskRemote.prototype.rejectReplan, {
    kind: 'method', name: 'rejectReplan', static: false, private: false,
    addInitializer(initializer) { remoteInitializers.push(initializer); },
    access: { has: () => true, get: (object) => object.rejectReplan }, metadata: undefined,
});
for (const method of ['editTaskGoal', 'acceptReplan', 'archiveTask', 'restoreTask', 'getTaskNavigation'])
    Remote(method)(LongTaskRemote.prototype[method], {
        kind: 'method', name: method, static: false, private: false,
        addInitializer(initializer) { remoteInitializers.push(initializer); },
        access: { has: () => true, get: (object) => object[method] }, metadata: undefined,
    });
