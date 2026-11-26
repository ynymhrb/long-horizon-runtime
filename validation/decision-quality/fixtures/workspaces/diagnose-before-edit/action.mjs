import { writeFile } from 'node:fs/promises'

const action = process.argv[2]
if (!['diagnose', 'patch', 'rewrite'].includes(action)) process.exit(2)
await writeFile('chosen-action.txt', action, 'utf8')
