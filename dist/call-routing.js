import { AsyncLocalStorage } from 'node:async_hooks';
class CallAdmission {
    waiting = new Set();
    async acquire(choices, signal) {
        signal.throwIfAborted();
        return new Promise((resolve, reject) => {
            const waiter = {
                choices,
                grant: () => {
                    const lane = waiter.choices.filter(choice => choice.active < choice.limit)
                        .sort((a, b) => a.active / a.limit - b.active / b.limit)[0];
                    if (lane === undefined)
                        return false;
                    this.waiting.delete(waiter);
                    signal.removeEventListener('abort', abort);
                    lane.active++;
                    let released = false;
                    resolve({ id: lane.id, release: () => {
                            if (released)
                                return;
                            released = true;
                            lane.active--;
                            this.dispatch();
                        } });
                    return true;
                },
            };
            const abort = () => {
                this.waiting.delete(waiter);
                reject(signal.reason);
            };
            signal.addEventListener('abort', abort, { once: true });
            this.waiting.add(waiter);
            this.dispatch();
        });
    }
    dispatch() {
        for (const waiter of this.waiting)
            waiter.grant();
    }
}
export class CallRouter {
    children = new AsyncLocalStorage();
    nestedTool = new AsyncLocalStorage();
    admission = new CallAdmission();
    models = new Map();
    tools = new Map();
    constructor(endpoints, tools = []) {
        const routes = new Set();
        for (const endpoint of endpoints) {
            const route = JSON.stringify([endpoint.provider, endpoint.model]);
            if (!endpoint.provider?.trim() || !endpoint.model?.trim() || !Array.isArray(endpoint.roles) || endpoint.roles.length === 0
                || endpoint.roles.some(role => typeof role !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(role)) || routes.has(route)) {
                throw new Error('无效或重复的 LLM 端点：' + endpoint.id);
            }
            const lane = newLane(endpoint.id, endpoint.maxConcurrent, this.models.has(endpoint.id));
            this.models.set(endpoint.id, { endpoint, lane });
            routes.add(route);
        }
        for (const entry of tools)
            this.tools.set(entry.name, newLane(entry.name, entry.maxConcurrent, this.tools.has(entry.name)));
    }
    run(role, parent, work) {
        const scope = { role, parent, call: undefined };
        return this.children.run(scope, async () => {
            try {
                return await work();
            }
            finally {
                // A failed prepareCall never starts a stream. Active streams own their release.
                if (scope.call?.started === false)
                    scope.call.permit.release();
            }
        });
    }
    async route(sessionId, signal, config) {
        const scope = this.children.getStore();
        if (scope === undefined || scope.parent === sessionId || (scope.child !== undefined && scope.child !== sessionId))
            return config;
        scope.child = sessionId;
        const candidates = [...this.models.values()].filter(item => item.endpoint.roles.includes(scope.role));
        if (candidates.length === 0)
            return config;
        if (scope.call?.started === true)
            throw new Error('子 Agent 重叠启动模型请求');
        scope.call?.permit.release();
        scope.call = undefined;
        const permit = await this.admission.acquire(candidates.map(candidate => candidate.lane), signal);
        const endpoint = this.models.get(permit.id).endpoint;
        scope.call = { endpoint, permit, started: false };
        if (endpoint.provider === config.provider && endpoint.model === config.model)
            return config;
        const { reasoningEffort: _previousEffort, ...rest } = config;
        return { ...rest, provider: endpoint.provider, model: endpoint.model };
    }
    stream(sessionId, provider, model, next) {
        const scope = this.children.getStore();
        const call = scope?.child === sessionId ? scope.call : undefined;
        if (call === undefined)
            return next();
        return (async function* () {
            call.started = true;
            try {
                if (call.endpoint.provider !== provider || call.endpoint.model !== model)
                    throw new Error('DSH 模型路由与预留端点不一致');
                yield* next();
            }
            finally {
                call.permit.release();
                if (scope.call === call)
                    scope.call = undefined;
            }
        })();
    }
    async tool(sessionId, name, signal, next) {
        const scope = this.children.getStore();
        const lane = scope?.child === sessionId ? this.tools.get(name) : undefined;
        if (lane === undefined)
            return next();
        if (this.nestedTool.getStore() === true)
            throw new Error('受限工具不能嵌套调用另一受限工具');
        const permit = await this.admission.acquire([lane], signal);
        try {
            signal.throwIfAborted();
            return await this.nestedTool.run(true, next);
        }
        finally {
            permit.release();
        }
    }
    install(ctx) {
        ctx.on('agent/request', async ({ agent, signal }, next) => this.route(String(agent.id), signal, await next()), { global: true, prepend: true });
        ctx.on('llm/stream', (options, next) => this.stream(String(options.sessionId), options.provider, options.model, next), { global: true });
        ctx.on('tools/execute', (exec, next) => this.tool(String(exec.agent?.id), exec.name, exec.signal, next), { global: true });
    }
}
function newLane(id, limit, exists) {
    if (!id?.trim() || exists || !Number.isSafeInteger(limit) || limit < 1)
        throw new Error('无效或重复的并发配置：' + id);
    return { id, limit, active: 0 };
}
