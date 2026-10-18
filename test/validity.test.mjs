import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseValidity, validityIssues, listPagesWithMeta } from '../lib/pages.js'
import { buildMemoryGraph } from '../lib/graph.js'
import { collectInsights } from '../lib/insights.js'

const CLI = fileURLToPath(new URL('../scripts/memory.mjs', import.meta.url))

function run(args, store) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MEMORY_DIR: store },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** A store with two decisions; with `window`, the older one is already closed. */
function makeStore(window = false) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-validity-'))
  run(['init', dir], dir)
  const oldLines = [
    '---', 'title: 旧结论', 'date: 2026-10-01', 'type: decision', 'salience: 2',
    'last_access: 2026-10-01', 'tags: [memory]', 'summary: 一条很快会被取代的旧结论。',
  ]
  if (window) oldLines.push('invalid_at: 2026-10-18', 'superseded_by: decisions/new.md')
  oldLines.push('---', '', '旧结论的正文。', '')
  writeFileSync(join(dir, 'decisions', 'old.md'), oldLines.join('\n'), 'utf8')
  writeFileSync(join(dir, 'decisions', 'new.md'), [
    '---', 'title: 新结论', 'date: 2026-10-18', 'type: decision', 'salience: 2',
    'last_access: 2026-10-18', 'tags: [memory]', 'summary: 取代旧结论的新结论。', '---', '',
    '新结论的正文。', '',
  ].join('\n'), 'utf8')
  // Route both pages from the index: lint fails on orphans, and an orphan would
  // hide whatever else it was supposed to say about the pages under test.
  const indexPath = join(dir, 'index.md')
  writeFileSync(indexPath, `${readFileSync(indexPath, 'utf8')}\n`
    + '- [旧结论](decisions/old.md) — 一条很快会被取代的旧结论。 `salience:2`\n'
    + '- [新结论](decisions/new.md) — 取代旧结论的新结论。 `salience:2`\n', 'utf8')
  return dir
}

test('parseValidity reads a window, ignores nonsense instead of guessing', () => {
  const full = parseValidity({
    valid_from: '2026-10-01', invalid_at: '2026-10-18', superseded_by: './decisions/new.md',
  })
  assert.deepEqual(full, {
    validFrom: '2026-10-01', invalidAt: '2026-10-18', supersededBy: 'decisions/new.md', superseded: true,
  })
  assert.deepEqual(parseValidity({}), {
    validFrom: undefined, invalidAt: undefined, supersededBy: undefined, superseded: false,
  })
  // A date the formatter would have to guess at is dropped, not repaired.
  assert.equal(parseValidity({ invalid_at: 'last tuesday' }).superseded, false)
  assert.equal(parseValidity({ valid_from: '2026-10-1' }).validFrom, undefined)
})

test('validityIssues flags both halves of a half-written relationship', () => {
  const known = new Set(['decisions/new.md'])
  assert.deepEqual(validityIssues('decisions/old.md', {
    validFrom: undefined, invalidAt: '2026-10-18', supersededBy: 'decisions/new.md', superseded: true,
  }, known), [])

  const oneSided = validityIssues('a.md', parseValidity({ invalid_at: '2026-10-18' }), known)
  assert.equal(oneSided.length, 1)
  assert.match(oneSided[0], /without superseded_by/)

  const reverse = validityIssues('a.md', parseValidity({ superseded_by: 'decisions/new.md' }), known)
  assert.equal(reverse.length, 1)
  assert.match(reverse[0], /without invalid_at/)

  const dangling = validityIssues('a.md', parseValidity({
    invalid_at: '2026-10-18', superseded_by: 'decisions/gone.md',
  }), known)
  assert.equal(dangling.length, 1)
  assert.match(dangling[0], /missing page/)

  const inverted = validityIssues('a.md', parseValidity({
    valid_from: '2026-10-18', invalid_at: '2026-10-01', superseded_by: 'decisions/new.md',
  }), known)
  assert.equal(inverted.length, 1)
  assert.match(inverted[0], /after invalid_at/)
})

test('the graph draws a directed supersession edge, not a symmetric one', () => {
  const dir = makeStore(true)
  try {
    const graph = buildMemoryGraph(dir, { includeMeta: false })
    const edges = graph.edges.filter((edge) => edge.kind === 'supersede')
    assert.equal(edges.length, 1)
    assert.equal(edges[0].source, 'decisions/old.md')
    assert.equal(edges[0].target, 'decisions/new.md')
    assert.equal(edges[0].directed, true)
    assert.equal(edges[0].label, '2026-10-18')
    assert.equal(graph.stats.supersedeEdges, 1)

    const old = graph.nodes.find((node) => node.id === 'decisions/old.md')
    const fresh = graph.nodes.find((node) => node.id === 'decisions/new.md')
    assert.equal(old.superseded, true)
    assert.equal(old.supersededBy, 'decisions/new.md')
    assert.equal(fresh.superseded, false)
    assert.equal(fresh.supersededBy, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('supersede closes the window, names the successor and logs it', () => {
  const dir = makeStore()
  try {
    const out = run(['supersede', 'decisions/old', 'decisions/new'], dir)
    assert.match(out, /superseded decisions\/old\.md/)

    const old = readFileSync(join(dir, 'decisions', 'old.md'), 'utf8')
    assert.match(old, /^invalid_at: \d{4}-\d{2}-\d{2}$/m)
    assert.match(old, /^superseded_by: decisions\/new\.md$/m)
    // The rest of the page is untouched — this command edits frontmatter, not memory.
    assert.match(old, /旧结论的正文。/)
    assert.match(readFileSync(join(dir, 'decisions', 'new.md'), 'utf8'), /新结论的正文。/)

    assert.match(readFileSync(join(dir, 'log.md'), 'utf8'), /## \[2026-\d{2}-\d{2}\] supersede \| decisions\/old\.md → decisions\/new\.md/)

    // A one-sided window is what this command exists to prevent: lint must agree.
    const lint = run(['lint'], dir)
    assert.doesNotMatch(lint, /superseded_by|invalid_at/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('supersede refuses to point at a page that is itself dead', () => {
  const dir = makeStore()
  try {
    run(['supersede', 'decisions/old', 'decisions/new'], dir)
    assert.throws(
      () => run(['supersede', 'decisions/new', 'decisions/old'], dir),
      /Command failed|superseded/i,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the dashboard counts superseded pages and stops calling them stale', () => {
  const dir = makeStore()
  try {
    assert.equal(collectInsights(dir).overview.superseded, 0)
    run(['supersede', 'decisions/old', 'decisions/new'], dir)

    const insights = collectInsights(dir)
    assert.equal(insights.overview.superseded, 1)
    assert.equal(insights.overview.validityProblems, 0)
    // old.md was last touched in 2026-10-01 and would otherwise read as neglected.
    assert.equal(insights.stalePages.some((page) => page.path === 'decisions/old.md'), false)
    const check = insights.health.checks.find((entry) => entry.id === 'supersession')
    assert.equal(check.ok, true)

    const row = listPagesWithMeta(dir).find((page) => page.path === 'decisions/old.md')
    assert.equal(row.superseded, true)
    assert.equal(row.supersededBy, 'decisions/new.md')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
