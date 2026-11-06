/** Bridge source kind definition: reads dispatch cards from the Acheron memory bridge and turns them into domain Triggers. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { record } from '../kv.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import { bridgeCard, BRIDGE_SOURCE, readBridgeCards, type BridgeCard } from './bridge-read.ts'
import type { Localized, SourceKind } from './kind.ts'

/** Config of the bridge Source: where the bridge database lives and which cards become work. */
const BridgeConfigSchema = z.object({
  database: z.string().trim().min(1).default(''),
  dispatchTag: z.string().trim().min(1).default('派单'),
  agent: z.string().trim().default(''),
  pollSeconds: z.number().int().min(10).max(3600).default(60),
}).strict()
export type BridgeConfig = z.infer<typeof BridgeConfigSchema>

/** KV keys the bridge Source owns: the last card timestamp it read, and the cards it already turned into Triggers. */
export const BRIDGE_KV = {
  since: record<string>('bridge-since'),
  seen: record<string[]>('bridge-seen'),
}

export const bridgeKind: SourceKind<BridgeConfig> = {
  kind: BRIDGE_SOURCE,
  title: { zh: '记忆桥', en: 'Memory bridge' },
  description: { zh: '读取记忆桥上的派单卡，把派给本智能体的卡片变成工单。', en: 'Reads dispatch cards from the memory bridge and turns the ones addressed to this agent into Tickets.' },
  schema: BridgeConfigSchema,
  fields: [
    { key: 'database', type: 'text', label: { zh: '桥库路径', en: 'Bridge database' },
      hint: { zh: '记忆桥的 bridge.db 绝对路径。桥库里的派单卡（标签含「派单」）会成为候选。', en: 'Absolute path of the bridge database. Dispatch cards on it (tagged 派单) become candidates.' } },
    { key: 'dispatchTag', type: 'text', label: { zh: '派单标签', en: 'Dispatch tag' },
      hint: { zh: '桥上标记派单卡的标签，默认「派单」。', en: 'The tag marking a dispatch card on the bridge; 派单 by default.' } },
    { key: 'agent', type: 'text', label: { zh: '收件智能体', en: 'Recipient agent' },
      hint: { zh: '只接派给这个名字的卡片（匹配标签 agent:<名字> 或 to:<名字>）；留空则接所有派单卡。', en: 'Only cards addressed to this agent (matching the tag agent:<name> or to:<name>); empty takes every dispatch card.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 10, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: ['bridge'],
  // The bridge receives every dispatch card it produces; the Policy decides which of them may originate work.
  scope: ({ meta }) => meta.kind === 'dispatch' ? { listened: true, observed: true, row: 'dispatch' } : { listened: false, reason: 'not_a_dispatch_card' },
  // A bridge card has no outbound channel: replies go back onto the bridge, not to a chat.
  threadContext: {
    messageId: trigger => String(trigger.meta.cardId ?? ''),
    read: async (_commands, trigger) => {
      const card = bridgeCard(trigger.meta)
      const messages = card ? [{ id: card.id, from: card.agent, at: card.at, text: card.text }] : []
      return { messages, body: { messages } }
    },
  },
  find: query => ({ threads: [], terms: [...new Set(query.match(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/gi) ?? [])] }),
  policy: {
    // A dispatch card is written by an agent, not a person, so it is a bot message: it needs an entry in the `bots`
    // list to be admitted at all, and then only as an inferred candidate.
    unnamed: { person: { zh: '桥上智能体', en: 'Bridge agent' }, bot: { zh: '桥上智能体', en: 'Bridge agent' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().trim().min(1), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate agent ids').default([]),
      bots: z.array(z.object({ id: z.string().trim().min(1), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate bot ids').optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的智能体', en: 'Agents that may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: '智能体', en: 'Agent' } },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      { key: 'bots', type: 'rows', label: { zh: '派单卡可以成为候选的智能体', en: 'Agents whose dispatch cards may become candidates' },
        hint: { zh: '名单里的智能体在桥上派的单会成为推断的候选，交给评估；它们不能发起明确的请求，也不能停止工单。其他智能体的卡不接收。', en: 'Cards dispatched by an agent on this list become inferred candidates for an assessment; they never make an explicit request or stop a ticket. Cards of other agents are not received.' },
        columns: [{ key: 'id', type: 'text', label: { zh: '智能体', en: 'Agent' } },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '名单内的智能体在桥上派单。', en: 'An agent on the list dispatches a card on the bridge.' },
    rows: () => [{ id: 'dispatch', label: { zh: '派单卡', en: 'Dispatch cards' }, note: { zh: '桥上派单', en: 'Dispatched on the bridge' },
      cells: { listedUnaddressed: true, unlistedAddressed: false, unlistedUnaddressed: false } }],
  },
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_BRIDGE_CARD', description: {
      zh: '接下工单的桥上派单卡 ID；工单不是从记忆桥来的时为空',
      en: 'ID of the bridge dispatch card that started the ticket; empty when the ticket did not start on the bridge' } }],
    values: ({ trigger }) => ({ DSH_SUPERAGENT_BRIDGE_CARD: trigger?.source === BRIDGE_SOURCE ? String(trigger.meta.cardId ?? '') : '' }),
  },
  facts: (deployment): Record<string, Localized | string> => ({ database: { zh: '桥库由来源配置指定', en: 'The bridge database is set on the Source' } }),
}

/** Health of the bridge Source: paused while off, ready once it read cards. */
export function bridgeHealth(state: Health['state'], detail: string): Health {
  return { state, detail }
}

/** Builds the Trigger of one dispatch card. */
export function bridgeTrigger(card: BridgeCard): Trigger {
  const thread = `card:${card.id}`
  const channel: ChannelRef = { source: BRIDGE_SOURCE, thread: `bridge:${thread}`, address: { cardId: card.id } }
  return { id: key(BRIDGE_SOURCE, card.id), source: BRIDGE_SOURCE, threads: [{ source: BRIDGE_SOURCE, id: thread }],
    actor: { source: BRIDGE_SOURCE, id: card.agent }, human: false,
    at: card.at, text: card.text, channel,
    meta: { cardId: card.id, agent: card.agent, kind: 'dispatch', project: card.project, tags: card.tags } }
}

/** Reads dispatch cards newer than the stored cursor and turns the ones addressed to this agent into Triggers. */
export async function pollBridge(ctx: SourceContext, signal: AbortSignal): Promise<number> {
  const config = ctx.config<BridgeConfig>(BRIDGE_SOURCE)
  if (!config) { ctx.report('bridge', bridgeHealth('paused', 'sourceOff')); return 0 }
  if (!config.database) { ctx.report('bridge', bridgeHealth('paused', 'The bridge database path is not set')); return 0 }
  const since = ctx.state.get(BRIDGE_KV.since)
  const cards = await readBridgeCards(config, since, signal)
  const seen = new Set(ctx.state.get(BRIDGE_KV.seen) ?? [])
  let received = 0
  for (const card of cards) {
    if (seen.has(card.id)) continue
    seen.add(card.id)
    received += 1
    await ctx.receive(bridgeTrigger(card))
  }
  // The cursor advances to the newest card read, so a card that arrives during the read is read again next round.
  const newest = cards.at(-1)?.at
  if (newest) ctx.state.set(BRIDGE_KV.since, newest)
  // Only the newest 500 card ids are kept, so the store does not grow without bound.
  ctx.state.set(BRIDGE_KV.seen, [...seen].slice(-500))
  ctx.report('bridge', bridgeHealth('ready', `${received} new cards`))
  return received
}

export const name = 'dsh-superagent-bridge'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(bridgeKind), 'bridge: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const running = watch(sourceContext(ctx.orchestrator, bridgeKind), controller.signal)
      .catch((error: unknown) => { sourceContext(ctx.orchestrator, bridgeKind).report('bridge', bridgeHealth('error', String(error))) })
    return async () => { controller.abort(); await running }
  })
}

/** Polls the bridge until the Source is stopped; one failed round is retried on the next. */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  while (!signal.aborted) {
    const config = ctx.config<BridgeConfig>(BRIDGE_SOURCE)
    try { await pollBridge(ctx, signal) }
    catch (error) { if (!signal.aborted) ctx.report('bridge', bridgeHealth('error', String(error))) }
    await pause((config?.pollSeconds ?? 60) * 1000, signal)
  }
}
/** Waits `ms` or until `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return }
    const stop = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
    signal.addEventListener('abort', stop, { once: true })
  })
}
