import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'

// Publishes each non-private workspace package with `npm publish` rather than `changeset publish`,
// which in a pnpm workspace shells out to `pnpm publish` — whose OIDC trusted-publishing path 404s
// (pnpm/pnpm#11513). npm's OIDC + provenance works. Versions are already bumped by `changeset version`.

const alreadyPublished = (spec) => {
  try {
    execFileSync('npm', ['view', spec, 'version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

for (const name of readdirSync('packages')) {
  const dir = `packages/${name}`
  let pkg
  try {
    pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'))
  } catch {
    continue
  }
  if (pkg.private || !pkg.name) continue

  const spec = `${pkg.name}@${pkg.version}`
  if (alreadyPublished(spec)) {
    console.log(`${spec} already published — skipping`)
    continue
  }

  execFileSync('npm', ['publish', '--access', 'public'], { cwd: dir, stdio: 'inherit' })
  console.log(`New tag: ${spec}`)
}
