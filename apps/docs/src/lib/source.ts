import { docs } from 'collections/server'
import { loader } from 'fumadocs-core/source'
import { lucideIconsPlugin } from 'fumadocs-core/source/lucide-icons'
import { docsRoute } from './shared'

export const source = loader({
  source: docs.toFumadocsSource(),
  baseUrl: docsRoute,
  plugins: [lucideIconsPlugin()],
})

export function markdownPathToSlugs(segments: string[]) {
  if (segments.length === 0) return []

  const slugs = [...segments]
  const lastIndex = slugs.length - 1
  slugs[lastIndex] = slugs[lastIndex]?.replace(/\.md$/, '') ?? ''
  if (slugs.length === 1 && slugs[0] === 'index') slugs.pop()
  return slugs
}

export function slugsToMarkdownPath(slugs: string[]) {
  const segments = [...slugs]
  const lastIndex = segments.length - 1

  if (segments.length === 0) {
    segments.push('index.md')
  } else {
    segments[lastIndex] = `${segments[lastIndex]}.md`
  }

  return {
    segments,
    url: `${docsRoute}/${segments.join('/')}`,
  }
}

export async function getLLMText(page: (typeof source)['$inferPage']) {
  const processed = await page.data.getText('processed')
  return `# ${page.data.title} (${page.url})\n\n${processed}`
}
