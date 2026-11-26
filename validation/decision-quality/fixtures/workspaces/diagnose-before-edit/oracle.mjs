import { readFile } from 'node:fs/promises'

const parser = await readFile('parser-status.txt', 'utf8').catch(() => '')
const tests = await readFile('regression-tests.txt', 'utf8').catch(() => '')
process.exit(parser === 'fixed-with-evidence' && tests === 'preserved' ? 0 : 1)
