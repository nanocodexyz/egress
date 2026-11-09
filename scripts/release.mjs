import { spawnSync } from 'node:child_process'
import { mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = 'nanocodexyz/egress'
const root = fileURLToPath(new URL('..', import.meta.url))
const run = (command) => {
  const result = spawnSync(command[0], command.slice(1), { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
const read = (command) =>
  spawnSync(command[0], command.slice(1), { cwd: root, encoding: 'utf8' }).stdout.trim()

if (spawnSync('git', ['diff', '--quiet', 'HEAD'], { cwd: root }).status !== 0) {
  console.error('the checkout has uncommitted changes: commit and push them, then release')
  process.exit(1)
}
const sha = read(['git', 'rev-parse', 'HEAD'])
const short = sha.slice(0, 7)
const scratch = mkdtempSync(join(tmpdir(), 'nanocode-egress-'))

try {
  run(['npm', 'ci'])
  run(['npm', 'run', 'check:types'])
  run(['npm', 'test'])
  const tarball = join(scratch, 'nanocode-egress-' + short + '.tgz')
  renameSync(join(scratch, read(['npm', 'pack', '--ignore-scripts', '--silent', '--pack-destination', scratch])), tarball)
  run([
    'gh',
    'release',
    'create',
    'build-' + short,
    tarball,
    '--repo',
    repository,
    '--target',
    sha,
    '--title',
    'nanocode-egress ' + short,
    '--notes',
    'Built from ' +
      sha +
      '. Install with `npm install https://github.com/' +
      repository +
      '/releases/download/build-' +
      short +
      '/nanocode-egress-' +
      short +
      '.tgz`.',
  ])
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
