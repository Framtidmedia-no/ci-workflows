// Har claude-review lagt inn et blokkerende funn? (FRA-1976)
// claude-review.yml merker funn med [KRITISK], [HØY] eller [MIDDELS]. De to første stopper automerge.
//
// CLI: node scripts/sentry-agent/review-funn.mjs < kommentarer.json ([{body}])  →  true | false
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BLOKKERENDE = /\[(KRITISK|HØY|HOY)\]/i

export function harBlokkerendeFunn(kommentarer) {
  if (!Array.isArray(kommentarer)) return false
  return kommentarer.some((k) => typeof k?.body === 'string' && BLOKKERENDE.test(k.body))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(harBlokkerendeFunn(JSON.parse(readFileSync(0, 'utf8')))) + '\n')
}
