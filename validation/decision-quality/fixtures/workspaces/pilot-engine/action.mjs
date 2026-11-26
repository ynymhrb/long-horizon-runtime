import { writeFile } from 'node:fs/promises'
const action = process.argv[2]
if (!['inspect', 'patch', 'rewrite'].includes(action)) process.exit(2)
await writeFile('chosen.txt', action, 'utf8')
