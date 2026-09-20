import { readFile, writeFile } from 'node:fs/promises'
const config = JSON.parse(await readFile('scenario-config.json', 'utf8'))
const chosen = await readFile('chosen.txt', 'utf8')
await writeFile('terminal.json', JSON.stringify({ success: chosen === config.hidden_optimal, preserved: chosen !== 'rewrite' || config.allow_rewrite === true }), 'utf8')
