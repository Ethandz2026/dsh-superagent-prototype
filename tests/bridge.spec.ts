/** The bridge Source: dispatch cards on the memory bridge become Triggers, and only the cards addressed to this agent. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgeKind, bridgeTrigger, pollBridge, BRIDGE_KV } from '../src/sources/bridge.ts'
import { readBridgeCards, BRIDGE_SOURCE } from '../src/sources/bridge-read.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { SettingsSchema } from '../src/policy.ts'
import { Store } from '../src/app/store.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { Commands } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'
import type { Trigger } from '../src/core/index.ts'

let dir: string
let database: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-'))
  database = join(dir, 'bridge.db')
  const db = new DatabaseSync(database)
  db.exec(`CREATE TABLE contexts (id TEXT PRIMARY KEY, content TEXT, type TEXT, source_surface TEXT,
    project TEXT, tags TEXT, created_at TEXT, updated_at TEXT)`)
  db.close()
})
// The bridge database stays open while the store holds it, so the directory is removed on the next run instead.
afterEach(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) } catch { /* Windows keeps the file locked briefly. */ } })

/** Writes one context row, the way the bridge stores a card. */
function card(id: string, at: string, tags: string[], content: string): void {
  const db = new DatabaseSync(database)
  db.prepare('INSERT INTO contexts (id,content,type,source_surface,project,tags,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, content, 'workflow', 'code', '阑夜行Agent集群', JSON.stringify(tags), at, at)
  db.close()
}

function host(config: Record<string, unknown> = {}) {
  const store = new Store(join(dir, 'db.sqlite'))
  const settings = SettingsSchema.parse({
    policy: { sources: { bridge: { allowed: [], bots: [{ id: '缪诗漪' }] } } },
    eval: { mode: 'auto' },
    sources: { bridge: { enabled: true, config: { database, ...config } } },
  })
  store.saveSettings(settings)
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(bridgeKind)
  const receive = vi.fn(async (_trigger: Trigger) => ({ status: 'accepted' as const }))
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  // The bridge Source reads the bridge database and reports health; it needs no engine or outbox.
  const parts = { store, sources, deployment: testDeployment(), ready: Promise.resolve(), configured: () => true,
    receive, commands } as unknown as SourceContextDeps
  return { store, sources, board, receive, context: sourceContextOf(parts, bridgeKind) }
}

describe('reading dispatch cards', () => {
  it('reads only cards carrying the dispatch tag', () => {
    card('c1', '2026-11-01T00:00:00.000Z', ['派单', 'to:缪诗漪', 'agent:顾洛谛'], 'do the thing')
    card('c2', '2026-11-01T00:00:01.000Z', ['交卡'], 'a report')
    const cards = readBridgeCards({ database, dispatchTag: '派单', agent: '' }, undefined)
    expect(cards.map(c => c.id)).toEqual(['c1'])
    expect(cards[0]!.text).toBe('do the thing')
    expect(cards[0]!.agent).toBe('顾洛谛')
  })

  it('reads only the cards addressed to the configured agent', () => {
    card('c1', '2026-11-01T00:00:00.000Z', ['派单', 'to:缪诗漪', 'agent:顾洛谛'], 'mine')
    card('c2', '2026-11-01T00:00:01.000Z', ['派单', 'to:乔宛杼', 'agent:顾洛谛'], 'yours')
    const cards = readBridgeCards({ database, dispatchTag: '派单', agent: '乔宛杼' }, undefined)
    expect(cards.map(c => c.id)).toEqual(['c2'])
  })

  it('names the agent that wrote a card, not the one it is addressed to', () => {
    card('c1', '2026-11-01T00:00:00.000Z', ['派单', 'to:黛思菡', 'agent:缪诗漪MuseAi'], 'a card')
    const cards = readBridgeCards({ database, dispatchTag: '派单', agent: '黛思菡' }, undefined)
    expect(cards.map(c => c.id)).toEqual(['c1'])
    // The actor is the author, so the Policy sees who dispatched the card.
    expect(cards[0]!.agent).toBe('缪诗漪MuseAi')
  })

  it('reads only the cards newer than the cursor', () => {
    card('c1', '2026-11-01T00:00:00.000Z', ['派单'], 'old')
    card('c2', '2026-11-02T00:00:00.000Z', ['派单'], 'new')
    const cards = readBridgeCards({ database, dispatchTag: '派单', agent: '' }, '2026-11-01T12:00:00.000Z')
    expect(cards.map(c => c.id)).toEqual(['c2'])
  })

  it('ignores a card whose tags are not JSON', () => {
    const db = new DatabaseSync(database)
    db.prepare('INSERT INTO contexts (id,content,type,source_surface,project,tags,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('c1', 'x', 'workflow', 'code', 'p', 'not json', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')
    db.close()
    expect(readBridgeCards({ database, dispatchTag: '派单', agent: '' }, undefined)).toEqual([])
  })
})

describe('the bridge Trigger', () => {
  it('names the card and its agent', () => {
    const trigger = bridgeTrigger({ id: 'card-1', at: '2026-11-01T00:00:00.000Z', agent: '缪诗漪', text: 'do it', project: 'p', tags: ['派单'] })
    expect(trigger.source).toBe(BRIDGE_SOURCE)
    expect(trigger.actor).toEqual({ source: BRIDGE_SOURCE, id: '缪诗漪' })
    expect(trigger.threads[0]!.id).toBe('card:card-1')
    expect(trigger.text).toBe('do it')
    // A card is written by an agent, not a person, so it may never make an explicit request.
    expect(trigger.human).toBe(false)
    expect(trigger.addressed).toBeUndefined()
    expect(trigger.meta.cardId).toBe('card-1')
  })

  it('gives the same id for the same card, so a re-read is a no-op', () => {
    const card = { id: 'card-1', at: '2026-11-01T00:00:00.000Z', agent: 'a', text: 't', project: 'p', tags: [] as string[] }
    expect(bridgeTrigger(card).id).toBe(bridgeTrigger(card).id)
  })
})

describe('polling the bridge', () => {
  it('turns new dispatch cards into Triggers and advances the cursor', async () => {
    card('c1', '2026-11-01T00:00:00.000Z', ['派单'], 'first')
    card('c2', '2026-11-01T00:00:01.000Z', ['派单'], 'second')
    const h = host()
    const count = await pollBridge(h.context, new AbortController().signal)
    expect(count).toBe(2)
    expect(h.receive).toHaveBeenCalledTimes(2)
    expect(h.context.state.get(BRIDGE_KV.since)).toBe('2026-11-01T00:00:01.000Z')
  })

  it('does not receive the same card twice', async () => {
    card('c1', '2026-11-01T00:00:00.000Z', ['派单'], 'first')
    const h = host()
    await pollBridge(h.context, new AbortController().signal)
    const second = await pollBridge(h.context, new AbortController().signal)
    expect(second).toBe(0)
    expect(h.receive).toHaveBeenCalledTimes(1)
  })

  it('reports the bridge as paused while the Source is off', async () => {
    const h = host()
    h.store.saveSettings(SettingsSchema.parse({ sources: { bridge: { enabled: false, config: { database } } } }))
    const count = await pollBridge(h.context, new AbortController().signal)
    expect(count).toBe(0)
    expect(h.board.all['bridge']?.state).toBe('paused')
  })
})
