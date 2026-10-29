import { spawn } from 'node:child_process';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
export class AcceptanceEngine {
    options;
    constructor(options) {
        this.options = options;
    }
    async evaluate(input) {
        const startedAt = new Date().toISOString();
        const checks = [];
        for (const check of input.checks)
            checks.push(await this.check(input.workspace, check));
        return { id: createHash('sha256').update(`${input.attemptId}:${startedAt}`).digest('hex'), attemptId: input.attemptId, verdict: checks.every(check => check.ok) ? 'passed' : 'failed', checks, startedAt, finishedAt: new Date().toISOString() };
    }
    async check(workspace, check) {
        if (check.kind === 'command') {
            const template = this.options.commandTemplates[check.templateId];
            if (template === undefined)
                return { id: check.id, kind: check.kind, ok: false, summary: `unknown command template: ${check.templateId}` };
            const outcome = await command(template, check.args, workspace);
            return { id: check.id, kind: check.kind, ok: outcome.exitCode === check.expectedExitCode, exitCode: outcome.exitCode, summary: `command exited ${outcome.exitCode}` };
        }
        if (check.kind === 'file') {
            const path = safePath(workspace, check.path);
            try {
                const bytes = await readFile(path);
                const hash = createHash('sha256').update(bytes).digest('hex');
                const ok = check.sha256 === undefined || check.sha256 === hash;
                return { id: check.id, kind: check.kind, ok, summary: ok ? 'file exists' : 'file hash mismatch' };
            }
            catch {
                return { id: check.id, kind: check.kind, ok: false, summary: 'file is unavailable' };
            }
        }
        return { id: check.id, kind: check.kind, ok: false, summary: `${check.kind} acceptance is not configured` };
    }
}
function safePath(workspace, file) { const base = resolve(workspace); const result = resolve(base, file); if (relative(base, result).startsWith('..'))
    throw new Error('file check escapes workspace'); return result; }
function command(template, args, cwd) { return new Promise(resolveResult => { const child = spawn(template.executable, [...template.argsPrefix, ...args], { cwd, shell: false, windowsHide: true }); const timer = setTimeout(() => child.kill(), template.maxTimeoutMs); child.once('close', code => { clearTimeout(timer); resolveResult({ exitCode: code ?? 1 }); }); child.once('error', () => { clearTimeout(timer); resolveResult({ exitCode: 1 }); }); }); }
