#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES_DIR = join(ROOT, 'packages')
const DEPENDENCY_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'devDependencies',
]

function parseArguments(argv) {
  if (argv.length === 0) return { outputDirectory: mkdtempSync(join(tmpdir(), 'genie-release-')) }
  if (argv.length === 2 && argv[0] === '--output') {
    return { outputDirectory: resolve(argv[1]), preserveOutput: true }
  }
  throw new Error('Usage: node scripts/prepare-release.mjs [--output <directory>]')
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function boundedOutput(value, limit = 4000) {
  const output = typeof value === 'string' ? value.trim() : ''
  if (output.length <= limit) return output
  return `…${output.slice(-limit)}`
}

function runCommand(command, args, { cwd, label, timeout = 30_000, maxBuffer = 256_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer,
    timeout,
  })
  if (!result.error && result.status === 0) {
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
  const detail = [boundedOutput(result.stdout), boundedOutput(result.stderr)]
    .filter(Boolean)
    .join('\n')
  const outcome = result.error?.message ?? `exit ${result.status ?? 'unknown'}`
  throw new Error(`${label ?? command} failed (${outcome})${detail ? `\n${detail}` : ''}`)
}

function publicPackages() {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = join(PACKAGES_DIR, entry.name)
      const manifest = readJson(join(directory, 'package.json'))
      return { directory, manifest }
    })
    .filter(({ manifest }) => manifest.name && manifest.version && manifest.private !== true)
}

function dependencyFirst(packages) {
  const byName = new Map(packages.map((entry) => [entry.manifest.name, entry]))
  const visiting = new Set()
  const visited = new Set()
  const ordered = []

  function visit(entry) {
    const name = entry.manifest.name
    if (visited.has(name)) return
    if (visiting.has(name)) throw new Error(`Workspace dependency cycle includes ${name}`)
    visiting.add(name)
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const dependency of Object.keys(entry.manifest[field] ?? {})) {
        const internalDependency = byName.get(dependency)
        if (internalDependency) visit(internalDependency)
      }
    }
    visiting.delete(name)
    visited.add(name)
    ordered.push(entry)
  }

  for (const entry of packages) visit(entry)
  return ordered
}

function pack(entry, outputDirectory) {
  const { stdout } = runCommand('pnpm', ['pack', '--json', '--pack-destination', outputDirectory], {
    cwd: entry.directory,
    label: `Pack ${entry.manifest.name}`,
  })
  const result = JSON.parse(stdout)
  if (result.name !== entry.manifest.name || result.version !== entry.manifest.version) {
    throw new Error(
      `Packed identity mismatch for ${entry.manifest.name}: ${result.name}@${result.version}`,
    )
  }
  return resolve(result.filename)
}

function inspectPackage(tarball, extractionRoot) {
  const extractionDirectory = mkdtempSync(join(extractionRoot, 'inspect-'))
  runCommand('tar', ['-xzf', tarball, '-C', extractionDirectory], {
    label: `Inspect ${tarball}`,
  })
  const packageDirectory = join(extractionDirectory, 'package')
  return {
    manifest: readJson(join(packageDirectory, 'package.json')),
    packageDirectory,
  }
}

function assertReadme(name, packageDirectory) {
  const readme = readdirSync(packageDirectory).find((file) => /^readme(?:\..+)?$/i.test(file))
  if (!readme || readFileSync(join(packageDirectory, readme), 'utf8').trim().length === 0) {
    throw new Error(`${name} release tarball must include a non-empty package-root README`)
  }
}

function assertPublishable(manifest) {
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (typeof range === 'string' && range.startsWith('workspace:')) {
        throw new Error(`${manifest.name} has unresolved ${field}.${name}: ${range}`)
      }
    }
  }
}

function assertPackageTarget(name, packageDirectory, label, target) {
  if (!target.startsWith('./')) {
    throw new Error(`${name} ${label} must be package-relative, got ${target}`)
  }
  const targetPath = resolve(packageDirectory, target)
  if (targetPath !== packageDirectory && !targetPath.startsWith(`${packageDirectory}${sep}`)) {
    throw new Error(`${name} ${label} escapes the package: ${target}`)
  }
  if (!existsSync(targetPath)) throw new Error(`${name} ${label} is missing: ${target}`)
}

function assertTargetTree(name, packageDirectory, label, value) {
  if (typeof value === 'string') {
    assertPackageTarget(name, packageDirectory, label, value)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertTargetTree(name, packageDirectory, `${label}[${index}]`, entry)
    })
    return
  }
  if (value && typeof value === 'object') {
    for (const [condition, target] of Object.entries(value)) {
      assertTargetTree(name, packageDirectory, `${label}.${condition}`, target)
    }
  }
}

function assertManifestTargets(manifest, packageDirectory) {
  assertTargetTree(manifest.name, packageDirectory, 'exports', manifest.exports)
  for (const field of ['main', 'module', 'types', 'bin']) {
    assertTargetTree(manifest.name, packageDirectory, field, manifest[field])
  }
}

function assertTrustedPublishingRepository(manifest) {
  const githubRepository = process.env.GITHUB_REPOSITORY
  if (!githubRepository) return
  const expected = `git+https://github.com/${githubRepository}.git`
  const actual = manifest.repository?.url
  if (actual !== expected) {
    throw new Error(
      `${manifest.name} repository.url must be ${expected} for npm trusted publishing, got ${actual ?? 'undefined'}`,
    )
  }
}

function runtimeTarget(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const entry of value) {
      const target = runtimeTarget(entry)
      if (target) return target
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  for (const condition of ['import', 'node', 'default', 'require', 'browser']) {
    const target = runtimeTarget(value[condition])
    if (target) return target
  }
  return null
}

function publicJsSpecifiers(manifest) {
  if (typeof manifest.exports === 'string') return [manifest.name]
  return Object.entries(manifest.exports ?? {})
    .filter(([subpath, target]) => subpath !== './package.json' && runtimeTarget(target))
    .map(([subpath]) => (subpath === '.' ? manifest.name : `${manifest.name}${subpath.slice(1)}`))
}

function installedPackageDirectory(projectDirectory, name) {
  return join(projectDirectory, 'node_modules', ...name.split('/'))
}

function assertInstalledIdentity(projectDirectory, expected) {
  const directory = installedPackageDirectory(projectDirectory, expected.name)
  const manifest = readJson(join(directory, 'package.json'))
  if (manifest.name !== expected.name || manifest.version !== expected.version) {
    throw new Error(
      `Installed identity mismatch for ${expected.name}: ${manifest.name}@${manifest.version}`,
    )
  }
  return { directory, manifest }
}

function verifyImports(projectDirectory, runtimeManifest) {
  const specifiers = publicJsSpecifiers(runtimeManifest)
  if (specifiers.length === 0) throw new Error(`${runtimeManifest.name} has no public JS exports`)
  const verifierPath = join(projectDirectory, 'verify-imports.mjs')
  writeFileSync(
    verifierPath,
    `const specifiers = ${JSON.stringify(specifiers)}
for (const specifier of specifiers) await import(specifier)
const cli = await import('@genie-react/cli')
if (Object.keys(cli).length === 0) throw new Error('@genie-react/cli has no library exports')
`,
  )
  const result = runCommand(process.execPath, [verifierPath], {
    cwd: projectDirectory,
    label: 'Import installed package entry points',
  })
  if (result.stdout !== '' || result.stderr !== '') {
    throw new Error('Installed package imports must not write to stdout or stderr')
  }
}

function verifyCliBin(projectDirectory, cliDirectory, cliManifest) {
  const binTarget =
    typeof cliManifest.bin === 'string' ? cliManifest.bin : cliManifest.bin?.['genie-react']
  if (typeof binTarget !== 'string') throw new Error('@genie-react/cli has no genie-react bin')
  const expectedBin = resolve(cliDirectory, binTarget)

  const help = runCommand(process.execPath, [expectedBin, '--help'], {
    cwd: projectDirectory,
    label: 'Installed genie-react --help',
    timeout: 10_000,
    maxBuffer: 64_000,
  })
  if (
    help.stderr !== '' ||
    help.stdout.includes('\u001b') ||
    !help.stdout.endsWith('\n') ||
    !help.stdout.includes('Usage: npx @genie-react/cli <command> [options]') ||
    !help.stdout.includes('--version')
  ) {
    throw new Error('Installed genie-react --help output does not match its public contract')
  }

  const version = runCommand(process.execPath, [expectedBin, '--version'], {
    cwd: projectDirectory,
    label: 'Installed genie-react --version',
    timeout: 10_000,
    maxBuffer: 64_000,
  })
  if (version.stderr !== '' || version.stdout !== `${cliManifest.version}\n`) {
    throw new Error(
      `Installed genie-react --version must print ${cliManifest.version}, got ${JSON.stringify(version.stdout)}`,
    )
  }
}

function smokeInstall(plan, peerInstallSpecs, temporaryRoot) {
  const projectDirectory = mkdtempSync(join(temporaryRoot, 'install-'))
  writeFileSync(
    join(projectDirectory, 'package.json'),
    `${JSON.stringify({ name: 'release-smoke-test', private: true, type: 'module' }, null, 2)}\n`,
  )
  runCommand(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      ...plan.map(({ tarball }) => tarball),
      ...peerInstallSpecs,
    ],
    { cwd: projectDirectory, label: 'Install release tarballs', timeout: 120_000 },
  )

  const installed = new Map(
    plan.map((entry) => [entry.name, assertInstalledIdentity(projectDirectory, entry)]),
  )
  const runtime = installed.get('genie-react')
  const cli = installed.get('@genie-react/cli')
  if (!runtime || !cli) throw new Error('Release smoke test requires runtime and CLI packages')
  if (runtime.manifest.exports?.['./package.json'] !== './package.json') {
    throw new Error('genie-react/package.json must remain a public data export')
  }
  verifyImports(projectDirectory, runtime.manifest)
  verifyCliBin(projectDirectory, cli.directory, cli.manifest)
}

const { outputDirectory, preserveOutput = false } = parseArguments(process.argv.slice(2))
const temporaryRoot = mkdtempSync(join(tmpdir(), 'genie-release-check-'))

try {
  mkdirSync(outputDirectory, { recursive: true })
  const plan = dependencyFirst(publicPackages()).map((entry) => {
    const tarball = pack(entry, outputDirectory)
    const { manifest, packageDirectory } = inspectPackage(tarball, temporaryRoot)
    assertPublishable(manifest)
    assertTrustedPublishingRepository(manifest)
    assertReadme(manifest.name, packageDirectory)
    assertManifestTargets(manifest, packageDirectory)
    return {
      name: manifest.name,
      version: manifest.version,
      directory: relative(ROOT, entry.directory),
      tarball,
      peerInstallSpecs: Object.keys(manifest.peerDependencies ?? {}).map((name) => {
        const range = entry.manifest.devDependencies?.[name]
        if (!range) throw new Error(`${manifest.name} needs a smoke-test version for peer ${name}`)
        return `${name}@${range}`
      }),
    }
  })
  // Peers make every entry point importable; the compatibility check owns version-range coverage.
  const peerInstallSpecs = [...new Set(plan.flatMap(({ peerInstallSpecs }) => peerInstallSpecs))]
  smokeInstall(plan, peerInstallSpecs, temporaryRoot)
  const planPath = join(outputDirectory, 'release-plan.tsv')
  writeFileSync(
    planPath,
    `${plan
      .map(({ name, version, directory, tarball }) =>
        [name, version, directory, tarball].join('\t'),
      )
      .join('\n')}\n`,
  )
  process.stdout.write(
    `Verified ${plan.length} release tarballs, entry points, and CLI bin with a clean npm install\n`,
  )
  if (preserveOutput) process.stdout.write(`Release plan: ${planPath}\n`)
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
  if (!preserveOutput) rmSync(outputDirectory, { recursive: true, force: true })
}
