import { readFile } from 'node:fs/promises'
const terminal = JSON.parse(await readFile('terminal.json', 'utf8'))
process.exit(terminal.success && terminal.preserved ? 0 : 1)
