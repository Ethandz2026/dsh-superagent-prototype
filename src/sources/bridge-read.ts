/** Reads dispatch cards from the Acheron memory bridge database. */
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

export const BRIDGE_SOURCE = 'bridge'

/** One dispatch card on the bridge. */
export interface BridgeCard {
  id: string
  at: string
  agent: string
  text: string
  project: string
  tags: string[]
}

/** The bridge's `contexts` rows, as stored. */
const ContextRowSchema = z.object({
  id: z.string(),
  content: z.string(),
  type: z.string(),
  project: z.string().default(''),
  tags: z.string().default(''),
  created_at: z.string(),
})

/** Parses the bridge's tag column, which holds a JSON array. */
function tagsOf(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed.filter((tag): tag is string => typeof tag === 'string')
  } catch { /* Tags that are not JSON are ignored. */ }
  return []
}

/** The agent that wrote a card, from its `agent:<name>` tag; the first one found wins. */
function authorOf(tags: string[]): string {
  for (const tag of tags) {
    const match = /^agent:(.+)$/.exec(tag)
    if (match) return match[1]!
  }
  return ''
}

/** The agent a card is addressed to, from its `to:<name>` tag; the first one found wins. */
function recipientOf(tags: string[]): string {
  for (const tag of tags) {
    const match = /^to:(.+)$/.exec(tag)
    if (match) return match[1]!
  }
  return ''
}

/**
 * Reads dispatch cards newer than `since`, newest last.
 * A card is a dispatch card when its tags carry the dispatch tag. `agent` narrows it to the cards addressed to that
 * agent, which is the recipient in the card's `to:` tag; a card that agent wrote for someone else is not its work.
 */
export function readBridgeCards(config: { database: string; dispatchTag: string; agent: string }, since: string | undefined,
  signal?: AbortSignal): BridgeCard[] {
  const db = new DatabaseSync(config.database, { readOnly: true })
  try {
    const rows = db.prepare(
      `SELECT id, content, type, project, tags, created_at FROM contexts
       WHERE created_at > ? ORDER BY created_at ASC LIMIT 500`).all(since ?? '')
    return rows.flatMap((row) => {
      if (signal?.aborted) return []
      const parsed = ContextRowSchema.safeParse(row)
      if (!parsed.success) return []
      const row_ = parsed.data
      const tags = tagsOf(row_.tags)
      if (!tags.includes(config.dispatchTag)) return []
      if (config.agent && recipientOf(tags) !== config.agent) return []
      return [{ id: row_.id, at: row_.created_at, agent: authorOf(tags), text: row_.content, project: row_.project, tags }]
    })
  } finally {
    db.close()
  }
}

/** The card a Trigger was built from, when its meta still carries it. */
export function bridgeCard(meta: Record<string, unknown>): BridgeCard | undefined {
  const id = meta.cardId
  if (typeof id !== 'string') return undefined
  return { id, at: String(meta.at ?? ''), agent: String(meta.agent ?? ''), text: String(meta.text ?? ''),
    project: String(meta.project ?? ''), tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [] }
}
