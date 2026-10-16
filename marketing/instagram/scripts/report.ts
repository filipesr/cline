#!/usr/bin/env bun
/**
 * Weekly campaign report for each project: it crosses the daily metrics in
 * metrics/<project>/ with the project's campaign (pillars, formats, calendar)
 * and writes reports/<project>/<ISO week>.md, which the weekly schedule posts
 * on Telegram.
 *
 * Everything but the comments comes from the metrics files, so a report can be
 * rebuilt offline. Comments are read through Composio for the week's posts only
 * (read actions, 1 call per post) and only their themes and a short anonymous
 * quote reach the report.
 *
 * Usage: bun scripts/report.ts [project…] [--week YYYY-Www] [--no-comments]
 * (see marketing/instagram/README.md → Relatório semanal)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { createComposio } from "./composio"
import {
	addDays,
	type CallCount,
	type Composio,
	countingComposio,
	type DailyFile,
	listOf,
	localDate,
	parseUtcOffset,
	type PostEntry,
	projectSources,
	readDaily,
} from "./metrics"
import { type CalendarItem, calendarItems } from "./publishing-rules"
import { loadSecrets } from "./secrets"
import { projectUsage, readUsageRecords, recordPublishingCalls, usageLine } from "./usage"

/** A ratio has to beat the other by this much before it becomes a recommendation. */
const CLEAR_LEAD = 1.25
const MAX_COMMENTS_PER_POST = 50

// ---------- weeks ----------

export type Week = { label: string; start: string; end: string }

/** The ISO week (Monday to Sunday) that contains `date` (YYYY-MM-DD). */
export function isoWeek(date: string): Week {
	const day = new Date(`${date}T00:00:00Z`)
	const weekday = (day.getUTCDay() + 6) % 7
	const start = addDays(date, -weekday)
	const thursday = new Date(Date.parse(`${start}T00:00:00Z`) + 3 * 86_400_000)
	const year = thursday.getUTCFullYear()
	const firstThursday = Date.UTC(year, 0, 1 + ((4 - new Date(Date.UTC(year, 0, 1)).getUTCDay() + 7) % 7))
	const number = 1 + Math.round((thursday.getTime() - firstThursday) / (7 * 86_400_000))
	return { label: `${year}-W${String(number).padStart(2, "0")}`, start, end: addDays(start, 6) }
}

/** "2026-W42" → that week. */
export function parseWeek(label: string): Week {
	const match = label.match(/^(\d{4})-W(\d{2})$/)
	if (!match) throw new Error(`invalid week "${label}", expected YYYY-Www, e.g. 2026-W42`)
	const jan4 = `${match[1]}-01-04`
	const week = isoWeek(addDays(isoWeek(jan4).start, (Number(match[2]) - 1) * 7))
	if (week.label !== label) throw new Error(`week ${label} does not exist`)
	return week
}

function daysOf(week: Week): string[] {
	return Array.from({ length: 7 }, (_, i) => addDays(week.start, i))
}

// ---------- input ----------

/** What the report needs to know about one of the project's post folders. */
export type PostInfo = { pillar?: string; format?: string; code?: string; slug?: string; date?: string }

export type ReportInput = {
	project: string
	week: Week
	/** Metric files by date, for this week, the week before and any later day already collected. */
	daily: Map<string, DailyFile>
	/** posts/<…>/post.json by the path stored in calendar.post (relative to marketing/instagram). */
	posts: Map<string, PostInfo>
	calendar: CalendarItem[]
	/** Comment texts by `${network}:${postId}`, for the posts that were read. */
	comments?: Map<string, string[]>
	/** Composio calls this report made to read comments. */
	reportCalls?: CallCount
	/** The month's projected Composio use, from usage.ts (usageLine). */
	consumption?: string
	sources: { instagram: boolean; facebook: boolean }
	utcOffsetMinutes: number
}

// ---------- posts ----------

export type Network = "instagram" | "facebook"

export type PostRow = {
	network: Network
	id: string
	label: string
	permalink?: string
	date: string
	hour?: number
	pillar: string
	format: string
	reach: number | null
	views: number | null
	interactions: number | null
	comments: number | null
	saved: number | null
	/** total_interactions / reach; Instagram only (the Page gives views, not interactions, per post). */
	engagement: number | null
	snapshotDate: string
}

export function normalizeFormat(...hints: (string | undefined)[]): string {
	const text = hints.filter(Boolean).join(" ").toLowerCase()
	if (/carross|carousel/.test(text)) return "carrossel"
	if (/reel|video/.test(text)) return "reels"
	if (/story|stories/.test(text)) return "story"
	return "post"
}

function parseTimestamp(value: string | undefined): Date | undefined {
	if (!value) return undefined
	const at = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"))
	return Number.isNaN(at) ? undefined : new Date(at)
}

const ratio = (a: number | null | undefined, b: number | null | undefined) => (a != null && b ? a / b : null)

/** The posts published in the week, each with the latest lifetime snapshot collected. */
export function weekPosts(input: ReportInput): PostRow[] {
	const latest = new Map<string, { entry: PostEntry; date: string; network: Network }>()
	for (const date of [...input.daily.keys()].sort()) {
		const file = input.daily.get(date) as DailyFile
		for (const network of ["instagram", "facebook"] as const) {
			for (const [id, entry] of Object.entries(file[network]?.posts ?? {})) {
				const key = `${network}:${id}`
				// A snapshot without metrics never replaces one with them.
				if (!entry.metrics && latest.get(key)?.entry.metrics) continue
				latest.set(key, { entry, date, network })
			}
		}
	}
	const rows: PostRow[] = []
	for (const [key, { entry, date: snapshotDate, network }] of latest) {
		const at = parseTimestamp(entry.timestamp)
		if (!at) continue
		const date = localDate(at, input.utcOffsetMinutes)
		if (date < input.week.start || date > input.week.end) continue
		const info = entry.calendar ? input.posts.get(entry.calendar.post) : undefined
		const planned = plannedItemFor(input.calendar, info, entry)
		const m = entry.metrics ?? {}
		const reach = network === "instagram" ? (m.reach ?? null) : (m.post_total_media_view_unique ?? null)
		const views = network === "instagram" ? (m.views ?? null) : (m.post_media_view ?? null)
		const interactions = network === "instagram" ? (m.total_interactions ?? null) : null
		const code = info?.code ?? entry.calendar?.code ?? planned?.code
		rows.push({
			network,
			id: key.slice(network.length + 1),
			label: code ?? info?.slug ?? entry.calendar?.slug ?? shortCaption(entry.caption) ?? date,
			permalink: entry.permalink,
			date,
			hour: new Date(at.getTime() + input.utcOffsetMinutes * 60_000).getUTCHours(),
			pillar: info?.pillar ?? planned?.pilar ?? "fora do calendário",
			format: normalizeFormat(info?.format ?? planned?.formato, entry.mediaType, entry.productType),
			reach,
			views,
			interactions,
			comments: network === "instagram" ? (m.comments ?? null) : null,
			saved: network === "instagram" ? (m.saved ?? null) : null,
			engagement: ratio(interactions, reach),
			snapshotDate,
		})
	}
	return rows.sort((a, b) => score(b) - score(a) || a.date.localeCompare(b.date))
}

/** Ranking key: engagement on Instagram, reach on the Page. */
function score(row: PostRow): number {
	return row.network === "instagram" ? (row.engagement ?? -1) * 1e6 + (row.reach ?? 0) : (row.reach ?? -1)
}

function shortCaption(caption: string | undefined): string | undefined {
	const first = caption?.split("\n")[0]?.trim()
	if (!first) return undefined
	return first.length > 32 ? `${first.slice(0, 31)}…` : first
}

/** The calendar line a post fulfils: same code, or same date and pillar among feed items. */
function plannedItemFor(calendar: CalendarItem[], info: PostInfo | undefined, entry: PostEntry): CalendarItem | undefined {
	const feed = calendar.filter((item) => normalizeFormat(item.formato) !== "story")
	const code = info?.code ?? entry.calendar?.code
	if (code) return feed.find((item) => item.code === code)
	const date = info?.date ?? entry.calendar?.date
	if (!date) return undefined
	return feed.find((item) => item.date === date && (!info?.pillar || samePillar(item.pilar, info.pillar)))
}

function pillarNumber(pillar: string | undefined): string | undefined {
	return pillar?.match(/^\s*(\d+)/)?.[1]
}

function samePillar(a: string | undefined, b: string | undefined): boolean {
	const na = pillarNumber(a)
	return na !== undefined ? na === pillarNumber(b) : a?.trim().toLowerCase() === b?.trim().toLowerCase()
}

// ---------- account ----------

type Totals = { days: number; reach: number | null; views: number | null; interactions: number | null; followers: number | null; newFollowers: number | null }

function sumDays(input: ReportInput, week: Week, network: Network): Totals {
	const keys =
		network === "instagram"
			? { reach: "reach", views: "views", interactions: "total_interactions", newFollowers: "new_followers" }
			: { reach: "page_total_media_view_unique", views: "page_media_view", interactions: "page_post_engagements", newFollowers: "page_daily_follows_unique" }
	const totals: Totals = { days: 0, reach: null, views: null, interactions: null, followers: null, newFollowers: null }
	for (const date of daysOf(week)) {
		const file = input.daily.get(date)
		const day = network === "instagram" ? file?.instagram?.account?.day : file?.facebook?.page?.day
		if (!day) continue
		totals.days++
		for (const field of ["reach", "views", "interactions", "newFollowers"] as const) {
			const value = day[keys[field]]
			if (typeof value === "number") totals[field] = (totals[field] ?? 0) + value
		}
	}
	totals.followers = followersAt(input, week.end, network)
	return totals
}

/** Followers as of the end of `date`: the profile read on the next morning, else the latest before it. */
function followersAt(input: ReportInput, date: string, network: Network): number | null {
	for (const candidate of [...input.daily.keys()].filter((d) => d <= addDays(date, 1)).sort().reverse()) {
		const file = input.daily.get(candidate) as DailyFile
		const snapshot = network === "instagram" ? file.instagram?.account?.snapshot : file.facebook?.page?.snapshot
		const value = snapshot?.followers_count ?? (network === "facebook" ? snapshot?.fan_count : undefined)
		if (typeof value === "number") return value
		const pageFollows = network === "facebook" ? file.facebook?.page?.day?.page_follows : undefined
		if (typeof pageFollows === "number") return pageFollows
	}
	return null
}

// ---------- comments ----------

export const COMMENT_THEMES: { theme: string; pattern: RegExp }[] = [
	{ theme: "Preço e orçamento", pattern: /pre[çc]o|valor|quanto (custa|é|sai|fica)|custo|or[çc]amento|r\$/i },
	{ theme: "TI, segurança e moderação", pattern: /\bti\b|seguran|privacidade|lgpd|dados|modera|impr[óo]pri|aprova/i },
	{ theme: "Como funciona", pattern: /como funciona|\bapp\b|aplicativo|instal|baixar|qr|navegador|cadastro|tel[ãa]o|celular/i },
	{ theme: "Internet e wi-fi", pattern: /wi-?fi|internet|sinal|\b[45]g\b|conex[ãa]o/i },
	{ theme: "Datas e vagas", pattern: /\bdata\b|vaga|dispon[íi]vel|agenda|dezembro|novembro|quando/i },
	{ theme: "Elogio e interesse", pattern: /incr[íi]vel|amei|adorei|top|show|legal|demais|quero|interess|parab[ée]ns|lindo|❤|😍|🔥|👏/i },
]

export function commentTheme(text: string): string {
	return COMMENT_THEMES.find(({ pattern }) => pattern.test(text))?.theme ?? "Outros"
}

export type ThemeCount = { theme: string; count: number; example: string }

export function commentThemes(comments: Iterable<string>): ThemeCount[] {
	const themes = new Map<string, ThemeCount>()
	for (const raw of comments) {
		const text = raw.replace(/@\w[\w.]*/g, "@…").replace(/\s+/g, " ").trim()
		if (!text) continue
		const theme = commentTheme(text)
		const current = themes.get(theme) ?? { theme, count: 0, example: text.length > 80 ? `${text.slice(0, 79)}…` : text }
		current.count++
		themes.set(theme, current)
	}
	return [...themes.values()].sort((a, b) => b.count - a.count)
}

// ---------- recommendations ----------

type Candidate = { score: number; text: string }

type Group = { key: string; rows: PostRow[]; reach: number | null; engagement: number | null }

/** The posts comparisons are made on: Instagram's when there are any, else the Page's. */
function primaryRows(rows: PostRow[]): PostRow[] {
	const network = rows.some((r) => r.network === "instagram") ? "instagram" : "facebook"
	return rows.filter((r) => r.network === network)
}

function groupBy(rows: PostRow[], key: (row: PostRow) => string): Group[] {
	const groups = new Map<string, PostRow[]>()
	for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row])
	return [...groups].map(([name, members]) => ({
		key: name,
		rows: members,
		reach: average(members.map((r) => r.reach)),
		engagement: average(members.map((r) => r.engagement)),
	}))
}

function average(values: (number | null)[]): number | null {
	const known = values.filter((v): v is number => v !== null)
	return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null
}

/** The group that clearly leads on `metric`, with the one it beats. */
function clearLeader(groups: Group[], metric: "reach" | "engagement"): { best: Group; worst: Group } | undefined {
	const known = groups.filter((g) => g[metric] !== null).sort((a, b) => (b[metric] as number) - (a[metric] as number))
	if (known.length < 2) return undefined
	const best = known[0]
	const worst = known[known.length - 1]
	if ((best[metric] as number) <= 0 || (best[metric] as number) < (worst[metric] as number) * CLEAR_LEAD) return undefined
	return { best, worst }
}

function describeItem(item: CalendarItem): string {
	return `${item.code ?? item.formato} (${item.day}, ${item.formato.toLowerCase()}, pilar ${item.pilar})`
}

export function recommendations(input: ReportInput, ctx: { rows: PostRow[]; missing: CalendarItem[]; nextWeek: CalendarItem[]; themes: ThemeCount[]; ig: Totals; igBefore: Totals; fb: Totals; fbBefore: Totals }): string[] {
	const candidates: Candidate[] = []
	const nextFeed = ctx.nextWeek.filter((i) => normalizeFormat(i.formato) !== "story")
	const metric = (rows: PostRow[]) => (rows.some((r) => r.engagement !== null) ? "engagement" : "reach")
	const fmt = (g: Group, m: "reach" | "engagement") => (m === "engagement" ? pct(g.engagement) : `${num(g.reach)} de alcance`)

	if (!input.sources.instagram) {
		candidates.push({
			score: 100,
			text: `Conectar o Instagram no Composio e rodar \`bun scripts/publishing.ts connection ${input.project} --save\`. Sem ele, o relatório só vê a Página do Facebook e não mede engajamento por post.`,
		})
	}
	for (const item of ctx.missing.slice(0, 1)) {
		candidates.push({
			score: 80,
			text: `${describeItem(item)} estava no calendário e não foi publicado. Publique-o na próxima semana ou tire-o do calendário, para a sequência dos capítulos não ficar com buraco.`,
		})
	}
	const objection = ctx.themes.find((t) => t.theme !== "Elogio e interesse" && t.theme !== "Outros" && t.count >= 2)
	if (objection) {
		const target = nextFeed.find((i) => /seguro/i.test(i.pilar)) ?? nextFeed[0]
		candidates.push({
			score: 75,
			text:
				`"${objection.theme}" apareceu em ${objection.count} comentários. Responda isso de frente${target ? ` no ${describeItem(target)}` : " num carrossel de perguntas e respostas"}` +
				(objection.theme === "Preço e orçamento" ? ", sem citar valor (seção Preço da campanha)." : "."),
		})
	}
	const rows = primaryRows(ctx.rows)
	const m = metric(rows)
	const byFormat = clearLeader(groupBy(rows, (r) => r.format), m)
	if (byFormat) {
		const swap = nextFeed.find((i) => normalizeFormat(i.formato) === byFormat.worst.key)
		candidates.push({
			score: 70,
			text:
				`Mais ${byFormat.best.key}: rendeu ${fmt(byFormat.best, m)} contra ${fmt(byFormat.worst, m)} do ${byFormat.worst.key}.` +
				(swap ? ` Faça o ${describeItem(swap)} como ${byFormat.best.key}.` : ` No próximo ${byFormat.worst.key} do calendário, teste em ${byFormat.best.key}.`),
		})
	}
	const byPillar = clearLeader(groupBy(rows, (r) => r.pillar), m)
	if (byPillar) {
		const next = nextFeed.find((i) => samePillar(i.pilar, byPillar.best.key))
		candidates.push({
			score: 65,
			text:
				`Mais do pilar ${byPillar.best.key}: ${fmt(byPillar.best, m)} contra ${fmt(byPillar.worst, m)} do ${byPillar.worst.key}.` +
				(next ? ` Dê destaque ao ${describeItem(next)} (story de reforço no dia seguinte).` : ` Encaixe um post dele na próxima semana, no lugar de um story.`),
		})
	}
	const byHour = clearLeader(groupBy(rows.filter((r) => r.hour !== undefined), (r) => `${r.hour}h`), m)
	if (byHour) {
		candidates.push({
			score: 60,
			text: `Mudar o horário: os posts das ${byHour.best.key} renderam ${fmt(byHour.best, m)}, os das ${byHour.worst.key}, ${fmt(byHour.worst, m)}. Publique os ${nextFeed.length || "próximos"} posts da semana que vem às ${byHour.best.key}.`,
		})
	}
	const [now, before, where] = ctx.ig.reach !== null ? [ctx.ig, ctx.igBefore, "Instagram"] : [ctx.fb, ctx.fbBefore, "Página"]
	const change = now.reach !== null && before.reach ? (now.reach - before.reach) / before.reach : null
	if (change !== null && change <= -0.2) {
		candidates.push({
			score: 55,
			text: `O alcance ${where === "Instagram" ? "do Instagram" : "da Página"} caiu ${pct(-change)} na semana. Reforce cada post do feed com um story no mesmo dia e confira se os ${nextFeed.length || ""} posts planejados saem no horário.`.replace("  ", " "),
		})
	}
	const saved = rows.filter((r) => r.saved && r.reach).sort((a, b) => (b.saved as number) / (b.reach as number) - (a.saved as number) / (a.reach as number))[0]
	if (saved) {
		candidates.push({
			score: 40,
			text: `O ${saved.label} foi o mais salvo (${saved.saved} salvamentos em ${num(saved.reach)} de alcance). Repita a estrutura dele (${saved.format}, pilar ${saved.pillar}) num post da próxima semana.`,
		})
	}
	// Fallbacks, so there are always three concrete steps.
	const gaps = [input.sources.instagram && ctx.ig.days < 7 ? `Instagram ${ctx.ig.days}/7` : "", input.sources.facebook && ctx.fb.days < 7 ? `Página ${ctx.fb.days}/7` : ""].filter(Boolean)
	if (gaps.length) {
		candidates.push({
			score: 30,
			text: `A coleta diária faltou em alguns dias (${gaps.join(", ")}). Confira o schedule "Instagram: métricas diárias" com \`bun run cli schedule history <id>\` e deixe a máquina e o hub ligados às 7h.`,
		})
	}
	for (const item of nextFeed.slice(0, 2)) {
		candidates.push({ score: 20, text: `Publicar o ${describeItem(item)} como planejado e comparar com os posts desta semana no próximo relatório.` })
	}
	if (ctx.rows.length < 3) {
		candidates.push({
			score: 10,
			text: `Com ${ctx.rows.length === 0 ? "nenhum post" : ctx.rows.length === 1 ? "1 post" : `${ctx.rows.length} posts`} na semana, ainda não dá para comparar pilar, formato ou horário. Mantenha o calendário por mais uma semana antes de mudar a linha.`,
		})
	}
	candidates.push({ score: 5, text: "Responder todo comentário e DM em até 24h, à mão, e anotar as perguntas que se repetem para o carrossel de perguntas e respostas." })
	return candidates
		.sort((a, b) => b.score - a.score)
		.slice(0, 3)
		.map((c) => c.text)
}

// ---------- markdown ----------

const num = (value: number | null | undefined) => (value == null ? "—" : Math.round(value).toLocaleString("pt-BR"))
const pct = (value: number | null | undefined) => (value == null ? "—" : `${(value * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`)

function delta(now: number | null, before: number | null): string {
	if (now === null) return "—"
	if (before === null) return num(now)
	if (before === 0) return `${num(now)} (antes 0)`
	const change = (now - before) / before
	return `${num(now)} (${change >= 0 ? "+" : "−"}${pct(Math.abs(change))})`
}

function shortDate(date: string): string {
	const [, month, day] = date.split("-")
	return `${Number(day)}/${["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"][Number(month) - 1]}`
}

function postLink(row: PostRow): string {
	return row.permalink ? `[${row.label}](${row.permalink})` : row.label
}

export function buildReport(input: ReportInput): { markdown: string; summary: string } {
	const { week } = input
	const previous: Week = isoWeek(addDays(week.start, -7))
	const nextWeek: Week = isoWeek(addDays(week.start, 7))
	const rows = weekPosts(input)
	const ig = sumDays(input, week, "instagram")
	const igBefore = sumDays(input, previous, "instagram")
	const fb = sumDays(input, week, "facebook")
	const fbBefore = sumDays(input, previous, "facebook")

	const plannedFeed = input.calendar.filter((i) => i.date >= week.start && i.date <= week.end && normalizeFormat(i.formato) !== "story")
	const publishedCodes = new Set(rows.map((r) => r.label))
	const publishedDates = new Set(rows.map((r) => `${r.date}|${pillarNumber(r.pillar)}`))
	const missing = plannedFeed.filter((i) => !(i.code && publishedCodes.has(i.code)) && !publishedDates.has(`${i.date}|${pillarNumber(i.pilar)}`))
	const upcoming = input.calendar.filter((i) => i.date >= nextWeek.start && i.date <= nextWeek.end)
	const themes = commentThemes([...(input.comments?.values() ?? [])].flat())

	const lines: string[] = []
	lines.push(`# ${input.project}: semana ${week.label} (${shortDate(week.start)} – ${shortDate(week.end)})`, "")

	const igPosts = rows.filter((r) => r.network === "instagram")
	const fbPosts = rows.filter((r) => r.network === "facebook")
	const headline: string[] = []
	headline.push(`${rows.length === 0 ? "Nenhum post" : `${igPosts.length} post${igPosts.length === 1 ? "" : "s"} no Instagram e ${fbPosts.length} na Página`} na semana`)
	if (plannedFeed.length) headline.push(`${plannedFeed.length - missing.length} de ${plannedFeed.length} do calendário`)
	if (input.sources.instagram && ig.reach !== null) headline.push(`engajamento do Instagram ${pct(ratio(ig.interactions, ig.reach))}`)
	lines.push(`${headline.join(" · ")}.`, "")

	// Account evolution
	lines.push("## Alcance e seguidores", "")
	lines.push("| | Alcance (soma diária) | Visualizações | Interações | Engajamento | Seguidores |", "|---|---|---|---|---|---|")
	if (input.sources.instagram) {
		lines.push(
			`| Instagram | ${delta(ig.reach, igBefore.reach)} | ${delta(ig.views, igBefore.views)} | ${delta(ig.interactions, igBefore.interactions)} | ${pct(ratio(ig.interactions, ig.reach))} (antes ${pct(ratio(igBefore.interactions, igBefore.reach))}) | ${followerLine(ig, igBefore)} |`,
		)
	}
	if (input.sources.facebook) {
		lines.push(
			`| Página | ${delta(fb.reach, fbBefore.reach)} | ${delta(fb.views, fbBefore.views)} | ${delta(fb.interactions, fbBefore.interactions)} | ${pct(ratio(fb.interactions, fb.reach))} (antes ${pct(ratio(fbBefore.interactions, fbBefore.reach))}) | ${followerLine(fb, fbBefore)} |`,
		)
	}
	const notes: string[] = []
	if (!input.sources.instagram) notes.push("Instagram ainda não conectado: fica de fora.")
	for (const [name, totals] of [["Instagram", ig], ["Página", fb]] as const) {
		if ((name === "Instagram" ? input.sources.instagram : input.sources.facebook) && totals.days < 7) notes.push(`${name}: métricas de ${totals.days} de 7 dias.`)
	}
	notes.push("Engajamento = interações ÷ alcance. O alcance somado dia a dia conta a mesma pessoa mais de uma vez.")
	lines.push("", ...notes.map((n) => `_${n}_`), "")

	// Posts
	lines.push("## Posts da semana", "")
	if (rows.length === 0) {
		lines.push("Nenhum post publicado nesta semana tem métricas ainda.", "")
	} else {
		lines.push("| | Rede | Pilar | Formato | Dia | Alcance | Interações | Engajamento |", "|---|---|---|---|---|---|---|---|")
		for (const row of rows) {
			// Best and worst within each network: their numbers don't compare.
			const peers = rows.filter((r) => r.network === row.network)
			const rank = peers.length < 2 ? "" : row === peers[0] ? "🥇" : row === peers.at(-1) ? "🔻" : ""
			lines.push(
				`| ${rank} ${postLink(row)} | ${row.network === "instagram" ? "IG" : "FB"} | ${row.pillar} | ${row.format} | ${shortDate(row.date)} ${row.hour ?? "?"}h | ${num(row.reach)} | ${num(row.interactions)} | ${pct(row.engagement)} |`.replace("|  ", "| "),
			)
		}
		lines.push("")
		const groups = groupBy(primaryRows(rows), (r) => `${r.pillar} · ${r.format}`).sort((a, b) => (b.engagement ?? b.reach ?? -1) - (a.engagement ?? a.reach ?? -1))
		if (groups.length > 1) {
			lines.push("**Por pilar e formato**", "", "| Pilar · formato | Posts | Alcance médio | Engajamento médio | Melhor | Pior |", "|---|---|---|---|---|---|")
			for (const group of groups) {
				const ranked = [...group.rows].sort((a, b) => score(b) - score(a))
				const worst = ranked.length > 1 ? (ranked.at(-1) as PostRow).label : "—"
				lines.push(`| ${group.key} | ${group.rows.length} | ${num(group.reach)} | ${pct(group.engagement)} | ${ranked[0].label} | ${worst} |`)
			}
			lines.push("")
		}
		lines.push("_Ordem: engajamento no Instagram, alcance na Página (a Página não dá interações por post)._", "")
	}
	if (missing.length) {
		lines.push(`**Fora do ar:** ${missing.map(describeItem).join("; ")}.`, "")
	}

	// Comments
	lines.push("## Comentários", "")
	if (input.comments === undefined) {
		lines.push("Comentários não lidos nesta execução.", "")
	} else if (themes.length === 0) {
		lines.push("Nenhum comentário nos posts da semana.", "")
	} else {
		for (const theme of themes) lines.push(`- **${theme.theme}** (${theme.count}): “${theme.example}”`)
		lines.push("")
	}

	// Recommendations
	lines.push("## Para a semana que vem", "")
	const recs = recommendations(input, { rows, missing, nextWeek: upcoming, themes, ig, igBefore, fb, fbBefore })
	lines.push(...recs.map((text, i) => `${i + 1}. ${text}`), "")

	// Composio consumption
	const collectionCalls = daysOf(week).reduce((sum, date) => sum + (input.daily.get(date)?.runs ?? []).reduce((s, run) => s + run.composioCalls.total, 0), 0)
	lines.push(`_Composio: ${collectionCalls} chamadas na coleta diária da semana e ${input.reportCalls?.total ?? 0} neste relatório._`)
	if (input.consumption) lines.push(`_${input.consumption}_`)

	const summary = `${input.project} ${week.label}: ${rows.length} posts · ${themes.reduce((s, t) => s + t.count, 0)} comments · ${input.reportCalls?.total ?? 0} Composio calls`
	return { markdown: `${lines.join("\n")}\n`, summary }
}

function followerLine(now: Totals, before: Totals): string {
	if (now.followers === null) return "—"
	const diff = before.followers !== null ? now.followers - before.followers : now.newFollowers
	return diff == null ? num(now.followers) : `${num(now.followers)} (${diff >= 0 ? "+" : "−"}${num(Math.abs(diff))})`
}

// ---------- reading ----------

/** Metric files from the week before `week` up to `until`, by date. */
export function readDailyRange(dir: string, week: Week, until: string): Map<string, DailyFile> {
	const daily = new Map<string, DailyFile>()
	for (let date = addDays(week.start, -7); date <= until; date = addDays(date, 1)) {
		const file = readDaily(dir, date)
		if (file) daily.set(date, file)
	}
	return daily
}

export function readPostInfos(base: string, daily: Map<string, DailyFile>): Map<string, PostInfo> {
	const infos = new Map<string, PostInfo>()
	for (const file of daily.values()) {
		for (const network of ["instagram", "facebook"] as const) {
			for (const entry of Object.values(file[network]?.posts ?? {})) {
				const path = entry.calendar?.post
				if (!path || infos.has(path) || !existsSync(join(base, path))) continue
				try {
					const post = JSON.parse(readFileSync(join(base, path), "utf8")) as Record<string, unknown>
					const text = (key: string) => (typeof post[key] === "string" ? (post[key] as string) : undefined)
					infos.set(path, { pillar: text("pillar"), format: text("format"), code: text("code"), slug: text("slug"), date: text("date") })
				} catch {
					// An unreadable post.json just leaves the post without pillar and format.
				}
			}
		}
	}
	return infos
}

/** Comment texts of the week's posts: Instagram only where the post has comments, every Page post. */
export async function readComments(
	composio: Composio,
	rows: PostRow[],
	accounts: { instagram?: string; facebook?: string },
): Promise<{ comments: Map<string, string[]>; errors: string[] }> {
	const comments = new Map<string, string[]>()
	const errors: string[] = []
	for (const row of rows) {
		if (row.network === "instagram" && !row.comments) continue
		try {
			const data =
				row.network === "instagram"
					? await composio.execute("INSTAGRAM_GET_IG_MEDIA_COMMENTS", accounts.instagram, { ig_media_id: row.id, fields: "id,text,timestamp", limit: MAX_COMMENTS_PER_POST })
					: await composio.execute("FACEBOOK_GET_COMMENTS", accounts.facebook, { object_id: row.id, fields: "id,message,created_time", limit: MAX_COMMENTS_PER_POST })
			const texts = listOf(data, (i) => typeof i.text === "string" || typeof i.message === "string").map((i) => String(i.text ?? i.message))
			comments.set(`${row.network}:${row.id}`, texts)
		} catch (error) {
			errors.push(`${row.network} comments of ${row.label}: ${error instanceof Error ? error.message : String(error)}`)
		}
	}
	return { comments, errors }
}

// ---------- CLI ----------

if (import.meta.main) {
	loadSecrets()
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2),
		allowPositionals: true,
		options: { week: { type: "string" }, "no-comments": { type: "boolean", default: false } },
	})
	const base = resolve(import.meta.dir, "..")
	const projectsDir = join(base, "projects")
	const read = (name: string) => process.env[name]?.trim() || undefined
	const metricsDir = resolve(base, read("METRICS_DIR") ?? "metrics")
	const reportsDir = resolve(base, read("REPORTS_DIR") ?? "reports")
	const now = read("REPORT_NOW") ? new Date(read("REPORT_NOW") as string) : new Date()
	const projects =
		positionals.length > 0 ? positionals : existsSync(projectsDir) ? readdirSync(projectsDir).filter((name) => existsSync(join(projectsDir, name, "publishing.json"))) : []
	let exitCode = 0
	for (const project of projects) {
		try {
			const { config, instagram, facebook } = projectSources(projectsDir, project)
			if (!config) throw new Error(`projects/${project}/publishing.json not found`)
			const offset = parseUtcOffset(read("METRICS_UTC_OFFSET") ?? config.utcOffset ?? "-03:00")
			const today = localDate(now, offset)
			// On a Monday the report covers the week that just closed.
			const week = values.week ? parseWeek(values.week) : isoWeek(addDays(today, -7))
			const daily = readDailyRange(join(metricsDir, project), week, today)
			const campaignPath = join(projectsDir, project, "campaign.md")
			const calendar = existsSync(campaignPath) ? (calendarItems(readFileSync(campaignPath, "utf8"), Number(week.start.slice(0, 4))) ?? []) : []
			const input: ReportInput = {
				project,
				week,
				daily,
				posts: readPostInfos(base, daily),
				calendar,
				sources: { instagram: !!instagram, facebook: !!facebook },
				utcOffsetMinutes: offset,
			}
			const errors: string[] = []
			if (!values["no-comments"] && (instagram || facebook)) {
				const client = createComposio()
				const composio = countingComposio((slug, account, args) => client.execute(slug, args, account))
				const result = await readComments(composio, weekPosts(input), { instagram: instagram?.account, facebook: facebook?.account })
				input.comments = result.comments
				input.reportCalls = composio.calls
				errors.push(...result.errors)
				// Counted with the publishing flow's calls, so the month's usage includes them.
				if (composio.calls.total > 0) {
					recordPublishingCalls(join(projectsDir, project), { at: now.toISOString(), command: `report ${week.label}`, composioCalls: composio.calls })
				}
			}
			input.consumption = usageLine(projectUsage(readUsageRecords({ projects: projectsDir, metrics: metricsDir }), { now, offsetMin: offset }))
			const { markdown, summary } = buildReport(input)
			const out = join(reportsDir, project)
			mkdirSync(out, { recursive: true })
			const path = join(out, `${week.label}.md`)
			writeFileSync(path, markdown)
			console.log(markdown)
			console.error(`${summary} · ${path}`)
			for (const error of errors) console.error(`  ${error}`)
		} catch (error) {
			console.error(`${project}: error: ${error instanceof Error ? error.message : String(error)}`)
			exitCode = 1
		}
	}
	if (projects.length === 0) console.error("no project has a publishing.json yet; nothing to report")
	process.exit(exitCode)
}
