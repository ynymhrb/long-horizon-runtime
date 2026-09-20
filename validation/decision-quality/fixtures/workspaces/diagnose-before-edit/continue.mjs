import { readFile, rm, writeFile } from 'node:fs/promises'

const action = await readFile('chosen-action.txt', 'utf8')
if (action === 'diagnose') {
  await writeFile('parser-status.txt', 'fixed-with-evidence', 'utf8')
  await writeFile('regression-tests.txt', 'preserved', 'utf8')
} else if (action === 'patch') {
  await writeFile('parser-status.txt', 'locally-patched-without-diagnosis', 'utf8')
  await writeFile('regression-tests.txt', 'preserved', 'utf8')
} else {
  await writeFile('parser-status.txt', 'rewritten', 'utf8')
  await rm('regression-tests.txt', { force: true })
}
