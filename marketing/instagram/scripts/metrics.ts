#!/usr/bin/env bun
/**
 * Daily metrics collector for each project's Instagram account and Facebook
 * Page, as the publishing flow saved them in projects/<project>/publishing.json.
 * It reads insights through Composio and keeps the history in
 * metrics/<project>/<YYYY-MM-DD>.json, because the APIs only show recent windows.
 *
 * Each value lives in exactly one place, in the file of the date it belongs to:
 * - account day metrics (reach, views, new followers…) go in the file of the
 *   day they measure, so a re-fetch or a backfill overwrites instead of adding;
 * - post metrics are lifetime totals, so each run stores a snapshot in the file
 *   of the day it ran, one entry per post id;
 * - each run appends itself to `runs` in the file of the day it ran, with the
 *   number of Composio calls it made.
 *
 * Usage: bun scripts/metrics.ts [project…]   (see marketing/instagram/README.md → Métricas diárias)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { createComposio } from "./composio"
import { loadSecrets } from "./secrets"
import type { CallCount } from "./usage"

export type { CallCount }

/** Post metrics. impressions/plays/video_views were retired by Meta in 2025. */
export const POST_METRICS = ["views", "reach", "likes", "comments", "saved", "shares", "total_interactions"]
/** INSTAGRAM_GET_USER_INSIGHTS takes no "me": without ig_user_id it reads the connected account. */
export const ACCOUNT_DAY_METRICS = ["reach", "views", "accounts_engaged", "total_interactions"]
export const DEMOGRAPHIC_BREAKDOWNS = ["age", "gender", "country", "city"]
export const PAGE_DAY_METRICS = ["page_media_view", "page_total_media_view_unique", "page_post_engagements", "page_daily_follows_unique", "page_follows"]
export const PAGE_POST_METRICS = ["post_media_view", "post_total_media_view_unique"]
/** Meta needs 100+ followers for demographics and the follower_count series. */
export const MIN_FOLLOWERS_FOR_AUDIENCE = 100
/** Meta keeps no insights for media older than two years. */
const MAX_POST_AGE_DAYS = 730
/** Day metrics settle within ~48h, so the last two days are always fetched again. */
const REFRESH_DAYS = 2
const MAX_MEDIA_PAGES = 10
const MEDIA_FIELDS = "id,caption,media_type,media_product_type,permalink,timestamp"
const PAGE_POST_FIELDS = "id,message,created_time,permalink_url"

type Metrics = Record<string, number | null>

export type CalendarRef = { project: string; post: string; slug?: string; date?: string; code?: string }

export type InsightsUnavailable = { reason: string; permanent: boolean }

export type PostEntry = {
	permalink?: string
	timestamp?: string
	mediaType?: string
	productType?: string
	caption?: string
	calendar: CalendarRef | null
	metrics: Metrics | null
	insightsUnavailable?: InsightsUnavailable
	collectedAt: string
}

export type AccountDay = { [metric: string]: number | string | null; collectedAt: string }

export type Demographics =
	| { available: true; collectedAt: string; breakdowns: Record<string, Record<string, number>> }
	| { available: false; collectedAt: string; reason: string }

export type RunRecord = {
	startedAt: string
	finishedAt: string
	status: "ok" | "partial" | "failed"
	composioCalls: CallCount
	instagramPosts: number
	facebookPosts: number
	accountDays: string[]
	errors: string[]
}

export type DailyFile = {
	schema: 1
	date: string
	utcOffset: string
	instagram?: {
		account?: {
			/** Metrics of this calendar day. */
			day?: AccountDay
			/** Profile counters read on this day. */
			snapshot?: Record<string, unknown> & { collectedAt: string }
			demographics?: Demographics
		}
		/** Lifetime metrics read on this day, by media id. */
		posts?: Record<string, PostEntry>
	}
	facebook?: {
		pageId: string
		page?: { day?: AccountDay; snapshot?: Record<string, unknown> & { collectedAt: string } }
		posts?: Record<string, PostEntry>
	}
	runs: RunRecord[]
}

export type CollectOptions = {
	composio: Composio
	/** Where this project's daily files go (marketing/instagram/metrics/<project>). */
	dir: string
	/** The project whose accounts are read and whose posts/<…>/post.json are matched. */
	project: string
	/** marketing/instagram/projects. */
	projectsDir: string
	now?: Date
	/** Minutes east of UTC that define "a day"; -180 for São Paulo. */
	utcOffsetMinutes?: number
	/** Days checked for missing account day metrics, counting back from yesterday. */
	lookbackDays?: number
	demographicsEveryDays?: number
	/**
	 * From the project's publishing.json. `account` picks the Composio connection when there
	 * are several; without it the default one is used, as in the publishing flow.
	 */
	instagram?: { account?: string; igUserId?: string }
	facebook?: { account?: string; pageId: string }
	log?: (line: string) => void
}

// ---------- Composio calls ----------

/** Runs one action on a connected account; every call is counted, failed ones included. */
export type Composio = {
	execute(slug: string, account: string | undefined, args: Record<string, unknown>): Promise<unknown>
	readonly calls: CallCount
}

export function countingComposio(
	run: (slug: string, account: string | undefined, args: Record<string, unknown>) => Promise<unknown>,
): Composio {
	const calls: CallCount = { total: 0, failed: 0, bySlug: {} }
	return {
		calls,
		async execute(slug, account, args) {
			calls.total++
			calls.bySlug[slug] = (calls.bySlug[slug] ?? 0) + 1
			try {
				return await run(slug, account, args)
			} catch (error) {
				calls.failed++
				throw error
			}
		},
	}
}

// ---------- dates ----------

export function parseUtcOffset(value: string): number {
	const match = value.trim().match(/^([+-])(\d{2}):?(\d{2})$/)
	if (!match) throw new Error(`invalid UTC offset "${value}", expected ±HH:MM`)
	const minutes = Number(match[2]) * 60 + Number(match[3])
	return match[1] === "-" ? -minutes : minutes
}

function formatOffset(minutes: number): string {
	const abs = Math.abs(minutes)
	return `${minutes < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`
}

export function localDate(at: Date, offset: number): string {
	return new Date(at.getTime() + offset * 60_000).toISOString().slice(0, 10)
}

export function addDays(date: string, days: number): string {
	return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

function dayStartUnix(date: string, offset: number): number {
	return Date.parse(`${date}T00:00:00Z`) / 1000 - offset * 60
}

/** Meta stamps a day's value with the end of that day (Pacific time); step back into the day. */
function dateOfEndTime(endTime: string, offset: number): string | undefined {
	const at = Date.parse(endTime.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"))
	return Number.isNaN(at) ? undefined : localDate(new Date(at - 12 * 3_600_000), offset)
}

// ---------- response parsing ----------

/** Depth-first search for the first value accepted by `match`; actions wrap Graph responses differently. */
function deepFind(value: unknown, match: (v: unknown) => boolean, depth = 6): unknown {
	if (match(value)) return value
	if (!value || typeof value !== "object" || depth <= 0) return undefined
	for (const child of Object.values(value as Record<string, unknown>)) {
		const found = deepFind(typeof child === "string" && /^[[{]/.test(child) ? safeParse(child) : child, match, depth - 1)
		if (found !== undefined) return found
	}
	return undefined
}

function safeParse(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return text
	}
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

type InsightItem = { name: string; values?: { value?: unknown; end_time?: string }[]; total_value?: { value?: unknown; breakdowns?: unknown } }

export function insightItems(data: unknown): InsightItem[] {
	const found = deepFind(
		data,
		(v) => Array.isArray(v) && v.length > 0 && v.every((i) => isRecord(i) && typeof i.name === "string" && ("values" in i || "total_value" in i)),
	)
	return (found as InsightItem[] | undefined) ?? []
}

function numberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** One number per metric: total_value, else the first (lifetime) value. */
export function metricTotals(data: unknown, metrics: string[]): Metrics {
	const items = insightItems(data)
	const result: Metrics = {}
	for (const metric of metrics) {
		const item = items.find((i) => i.name === metric)
		result[metric] = numberOrNull(item?.total_value?.value ?? item?.values?.[0]?.value)
	}
	return result
}

/** Per-day values of a time series, keyed by local date. */
function timeSeries(data: unknown, metric: string, offset: number): Record<string, number> {
	const item = insightItems(data).find((i) => i.name === metric)
	const series: Record<string, number> = {}
	for (const point of item?.values ?? []) {
		const date = point.end_time ? dateOfEndTime(point.end_time, offset) : undefined
		const value = numberOrNull(point.value)
		if (date && value !== null) series[date] = value
	}
	return series
}

export function listOf(data: unknown, looksLikeItem: (i: Record<string, unknown>) => boolean): Record<string, unknown>[] {
	const found = deepFind(data, (v) => Array.isArray(v) && v.length > 0 && v.every((i) => isRecord(i) && typeof i.id === "string" && looksLikeItem(i)))
	return (found as Record<string, unknown>[] | undefined) ?? []
}

function nextCursor(data: unknown): string | undefined {
	const paging = deepFind(data, (v) => isRecord(v) && isRecord(v.cursors)) as { cursors?: { after?: string }; next?: string } | undefined
	return paging?.next && paging.cursors?.after ? paging.cursors.after : undefined
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/**
 * When Meta rejects a metric for a media type, drop what it named and retry
 * once: "does not support the X metric" or "must be one of the following values: a, b".
 */
export function supportedMetricsAfterError(message: string, metrics: string[]): string[] | undefined {
	const allowed = message.match(/must be one of the following values:\s*([a-z_,\s]+)/i)?.[1]
	let kept = allowed ? metrics.filter((m) => allowed.split(/[,\s]+/).includes(m)) : metrics
	if (/not support|unsupported|incompatible|invalid/i.test(message)) {
		kept = kept.filter((m) => !new RegExp(`\\b${m}\\b`).test(message))
	}
	return kept.length > 0 && kept.length < metrics.length ? kept : undefined
}

function permanentInsightsGap(message: string): boolean {
	return /posted before the most recent time|before the account was converted|older than/i.test(message)
}

// ---------- files ----------

const DATE_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/

export function readDaily(dir: string, date: string): DailyFile | undefined {
	const path = join(dir, `${date}.json`)
	if (!existsSync(path)) return undefined
	return JSON.parse(readFileSync(path, "utf8")) as DailyFile
}

function writeDaily(dir: string, file: DailyFile) {
	mkdirSync(dir, { recursive: true })
	const path = join(dir, `${file.date}.json`)
	const temp = `${path}.tmp`
	writeFileSync(temp, `${JSON.stringify(file, null, "\t")}\n`)
	renameSync(temp, path)
}

function dailyDates(dir: string): string[] {
	if (!existsSync(dir)) return []
	return readdirSync(dir)
		.map((name) => name.match(DATE_FILE)?.[1])
		.filter((d): d is string => !!d)
		.sort()
}

/** Index of the calendar's published posts: Instagram media id, permalink and Facebook post id → post.json. */
export function calendarIndex(projectsDir: string, baseDir: string, only?: string): Map<string, CalendarRef> {
	const index = new Map<string, CalendarRef>()
	if (!existsSync(projectsDir)) return index
	for (const project of readdirSync(projectsDir, { withFileTypes: true })) {
		if (!project.isDirectory() || (only && project.name !== only)) continue
		const postsDir = join(projectsDir, project.name, "posts")
		if (!existsSync(postsDir)) continue
		for (const folder of readdirSync(postsDir, { withFileTypes: true })) {
			if (!folder.isDirectory()) continue
			const path = join(postsDir, folder.name, "post.json")
			if (!existsSync(path)) continue
			let post: Record<string, unknown>
			try {
				post = JSON.parse(readFileSync(path, "utf8"))
			} catch {
				continue
			}
			const publication = (isRecord(post.publishing) ? post.publishing : post) as Record<string, unknown>
			const instagram = isRecord(publication.instagram) ? publication.instagram : {}
			const facebook = isRecord(publication.facebook) ? publication.facebook : {}
			const ref: CalendarRef = {
				project: project.name,
				post: relative(baseDir, path),
				...(typeof post.slug === "string" ? { slug: post.slug } : {}),
				...(typeof post.date === "string" ? { date: post.date } : {}),
				...(typeof post.code === "string" ? { code: post.code } : {}),
			}
			for (const key of [instagram.mediaId, instagram.permalink, facebook.postId, facebook.permalink]) {
				if (typeof key === "string" && key) index.set(key, ref)
			}
		}
	}
	return index
}

// ---------- collection ----------

export async function collect(options: CollectOptions): Promise<{ file: DailyFile; run: RunRecord }> {
	const { composio, dir } = options
	const now = options.now ?? new Date()
	const offset = options.utcOffsetMinutes ?? -180
	const lookback = options.lookbackDays ?? 7
	const demographicsEvery = options.demographicsEveryDays ?? 7
	const log = options.log ?? (() => {})
	const startedAt = now.toISOString()
	const today = localDate(now, offset)
	const errors: string[] = []
	const stamp = () => new Date().toISOString()

	// Every file this run touches, loaded once and written at the end.
	const files = new Map<string, DailyFile>()
	const fileFor = (date: string): DailyFile => {
		let file = files.get(date)
		if (!file) {
			file = peek(date) ?? { schema: 1, date, utcOffset: formatOffset(offset), runs: [] }
			files.set(date, file)
		}
		return file
	}
	// Earlier files are read at most once.
	const readCache = new Map<string, DailyFile | undefined>()
	const peek = (date: string): DailyFile | undefined => {
		if (files.has(date)) return files.get(date)
		if (!readCache.has(date)) readCache.set(date, readDaily(dir, date))
		return readCache.get(date)
	}
	const todayFile = fileFor(today)
	const previousDates = dailyDates(dir).filter((d) => d < today)
	const calendar = calendarIndex(options.projectsDir, resolve(options.projectsDir, ".."), options.project)

	// The two last days always, plus any day in the window that has no metrics yet.
	const daysWanted = (has: (file: DailyFile | undefined) => boolean): string[] => {
		const days: string[] = []
		for (let back = lookback; back >= 1; back--) {
			const date = addDays(today, -back)
			if (back <= REFRESH_DAYS || !has(peek(date))) days.push(date)
		}
		return days
	}

	// The latest known state of a post, from today's earlier run or the last day that had it.
	const lastPostState = (section: "instagram" | "facebook", id: string): PostEntry | undefined => {
		for (const date of [today, ...[...previousDates].reverse()]) {
			const entry = peek(date)?.[section]?.posts?.[id]
			if (entry) return entry
		}
		return undefined
	}

	const postInsights = async (
		slug: string,
		accountId: string | undefined,
		args: (metrics: string[]) => Record<string, unknown>,
		metrics: string[],
	): Promise<{ metrics: Metrics } | { unavailable: InsightsUnavailable }> => {
		try {
			return { metrics: metricTotals(await composio.execute(slug, accountId, args(metrics)), metrics) }
		} catch (error) {
			const message = errorMessage(error)
			const retry = supportedMetricsAfterError(message, metrics)
			if (retry) {
				try {
					const partial = metricTotals(await composio.execute(slug, accountId, args(retry)), retry)
					return { metrics: Object.fromEntries(metrics.map((m) => [m, partial[m] ?? null])) }
				} catch (retryError) {
					return { unavailable: { reason: errorMessage(retryError), permanent: permanentInsightsGap(errorMessage(retryError)) } }
				}
			}
			return { unavailable: { reason: message, permanent: permanentInsightsGap(message) } }
		}
	}

	const tooOld = (timestamp: unknown) =>
		typeof timestamp === "string" && now.getTime() - Date.parse(timestamp) > MAX_POST_AGE_DAYS * 86_400_000

	let instagramPosts = 0
	let facebookPosts = 0
	const accountDays = new Set<string>()
	// A run fails only when no configured source answered; one source down is a partial run.
	let instagramDown = false
	let facebookUp = false

	// ----- Instagram -----
	if (options.instagram) {
		const account = options.instagram.account
		// Profile and media accept "me"; the user insights action only takes a numeric id, or none for the connected account.
		const igUserId = options.instagram.igUserId
		const insightsUser = igUserId && /^\d+$/.test(igUserId) ? { ig_user_id: igUserId } : {}
		const ig = (todayFile.instagram ??= {})
		const igAccountState = (ig.account ??= {})

		let followers: number | null = null
		try {
			const info = await composio.execute("INSTAGRAM_GET_USER_INFO", account, {
				ig_user_id: igUserId ?? "me",
				fields: "id,username,followers_count,follows_count,media_count",
			})
			const profile = (deepFind(info, (v) => isRecord(v) && "followers_count" in v) ?? {}) as Record<string, unknown>
			followers = numberOrNull(profile.followers_count)
			igAccountState.snapshot = {
				username: profile.username ?? null,
				followers_count: followers,
				follows_count: numberOrNull(profile.follows_count),
				media_count: numberOrNull(profile.media_count),
				collectedAt: stamp(),
			}
		} catch (error) {
			errors.push(`instagram profile: ${errorMessage(error)}`)
			instagramDown = true
		}

		if (!instagramDown) {
			// Posts: list everything, then one insights call per post that can still have insights.
			const media: Record<string, unknown>[] = []
			try {
				let after: string | undefined
				for (let page = 0; page < MAX_MEDIA_PAGES; page++) {
					const data = await composio.execute("INSTAGRAM_GET_IG_USER_MEDIA", account, {
						ig_user_id: igUserId ?? "me",
						fields: MEDIA_FIELDS,
						limit: 50,
						...(after ? { after } : {}),
					})
					media.push(...listOf(data, (i) => "timestamp" in i || "permalink" in i || "media_type" in i))
					after = nextCursor(data)
					if (!after) break
				}
			} catch (error) {
				errors.push(`instagram media list: ${errorMessage(error)}`)
			}

			const posts: Record<string, PostEntry> = {}
			for (const item of media) {
				const id = item.id as string
				const previous = lastPostState("instagram", id)
				const entry: PostEntry = {
					permalink: item.permalink as string | undefined,
					timestamp: item.timestamp as string | undefined,
					mediaType: item.media_type as string | undefined,
					productType: item.media_product_type as string | undefined,
					caption: typeof item.caption === "string" ? item.caption.slice(0, 120) : undefined,
					calendar: calendar.get(id) ?? calendar.get(String(item.permalink ?? "")) ?? null,
					metrics: null,
					collectedAt: stamp(),
				}
				if (tooOld(item.timestamp)) {
					entry.insightsUnavailable = { reason: "Meta keeps no insights for media older than two years", permanent: true }
				} else if (previous?.insightsUnavailable?.permanent) {
					entry.insightsUnavailable = previous.insightsUnavailable
				} else {
					const result = await postInsights(
						"INSTAGRAM_GET_IG_MEDIA_INSIGHTS",
						account,
						(metric) => ({ ig_media_id: id, metric }),
						POST_METRICS,
					)
					if ("metrics" in result) entry.metrics = result.metrics
					else {
						entry.insightsUnavailable = result.unavailable
						if (!result.unavailable.permanent) errors.push(`instagram post ${id}: ${result.unavailable.reason}`)
					}
				}
				// A failed re-run keeps the numbers an earlier run of the same day got.
				const sameDay = ig.posts?.[id]
				if (!entry.metrics && sameDay?.metrics) {
					entry.metrics = sameDay.metrics
					entry.collectedAt = sameDay.collectedAt
					delete entry.insightsUnavailable
				}
				posts[id] = entry
			}
			if (media.length > 0 || !ig.posts) ig.posts = { ...ig.posts, ...posts }
			instagramPosts = Object.keys(posts).length

			// Account day metrics: one call per day, so every day keeps its own total.
			const days = daysWanted((file) => !!file?.instagram?.account?.day)
			for (const date of days) {
				try {
					const data = await composio.execute("INSTAGRAM_GET_USER_INSIGHTS", account, {
						...insightsUser,
						metric: ACCOUNT_DAY_METRICS,
						period: "day",
						metric_type: "total_value",
						since: dayStartUnix(date, offset),
						until: dayStartUnix(addDays(date, 1), offset),
					})
					const dayFile = fileFor(date)
					const accountState = ((dayFile.instagram ??= {}).account ??= {})
					accountState.day = {
						...metricTotals(data, ACCOUNT_DAY_METRICS),
						new_followers: accountState.day?.new_followers ?? null,
						collectedAt: stamp(),
					}
					accountDays.add(date)
				} catch (error) {
					errors.push(`instagram account ${date}: ${errorMessage(error)}`)
				}
			}

			// New followers per day come in one time series; Meta only has it with 100+ followers.
			if (days.length > 0 && followers !== null && followers >= MIN_FOLLOWERS_FOR_AUDIENCE) {
				try {
					const data = await composio.execute("INSTAGRAM_GET_USER_INSIGHTS", account, {
						...insightsUser,
						metric: ["follower_count"],
						period: "day",
						metric_type: "time_series",
						since: dayStartUnix(days[0], offset),
						until: dayStartUnix(today, offset),
					})
					const series = timeSeries(data, "follower_count", offset)
					for (const date of days) {
						const day = fileFor(date).instagram?.account?.day
						if (day && date in series) day.new_followers = series[date]
					}
				} catch (error) {
					errors.push(`instagram follower_count: ${errorMessage(error)}`)
				}
			}

			// Demographics change slowly: refresh weekly, and say why when there are none.
			if (followers !== null && followers < MIN_FOLLOWERS_FOR_AUDIENCE) {
				igAccountState.demographics = {
					available: false,
					collectedAt: stamp(),
					reason: `Meta only reports demographics for accounts with ${MIN_FOLLOWERS_FOR_AUDIENCE}+ followers (now ${followers})`,
				}
			} else if (followers !== null) {
				const last = [...previousDates]
					.reverse()
					.find((d) => peek(d)?.instagram?.account?.demographics?.available === true)
				const sameDay = igAccountState.demographics?.available === true
				if (!sameDay && (!last || addDays(last, demographicsEvery) <= today)) {
					const breakdowns: Record<string, Record<string, number>> = {}
					for (const breakdown of DEMOGRAPHIC_BREAKDOWNS) {
						try {
							const data = await composio.execute("INSTAGRAM_GET_USER_INSIGHTS", account, {
						...insightsUser,
								metric: ["follower_demographics"],
								period: "lifetime",
								metric_type: "total_value",
								breakdown,
								timeframe: "this_month",
							})
							breakdowns[breakdown] = demographicBuckets(data)
						} catch (error) {
							errors.push(`instagram demographics ${breakdown}: ${errorMessage(error)}`)
						}
					}
					igAccountState.demographics =
						Object.keys(breakdowns).length > 0
							? { available: true, collectedAt: stamp(), breakdowns }
							: { available: false, collectedAt: stamp(), reason: "Meta returned no demographics" }
				}
			}
		}
	}

	// ----- Facebook Page -----
	if (options.facebook) {
		const { pageId, account } = options.facebook
		const fb = (todayFile.facebook ??= { pageId })
		const page = (fb.page ??= {})
		try {
			const details = await composio.execute("FACEBOOK_GET_PAGE_DETAILS", account, {
				page_id: pageId,
				fields: "id,name,followers_count,fan_count",
			})
			const info = (deepFind(details, (v) => isRecord(v) && ("followers_count" in v || "fan_count" in v)) ?? {}) as Record<string, unknown>
			page.snapshot = {
				name: info.name ?? null,
				followers_count: numberOrNull(info.followers_count),
				fan_count: numberOrNull(info.fan_count),
				collectedAt: stamp(),
			}
			facebookUp = true
		} catch (error) {
			errors.push(`facebook page: ${errorMessage(error)}`)
		}

		// Page day metrics come as daily series, so one call covers every wanted day.
		const days = daysWanted((file) => !!file?.facebook?.page?.day)
		if (days.length > 0) {
			try {
				const data = await composio.execute("FACEBOOK_GET_PAGE_INSIGHTS", account, {
					page_id: pageId,
					metrics: PAGE_DAY_METRICS.join(","),
					period: "day",
					since: String(dayStartUnix(days[0], offset)),
					until: String(dayStartUnix(today, offset)),
				})
				const series = Object.fromEntries(PAGE_DAY_METRICS.map((m) => [m, timeSeries(data, m, offset)]))
				for (const date of days) {
					if (!PAGE_DAY_METRICS.some((m) => date in series[m])) continue
					const dayFile = fileFor(date)
					const dayPage = ((dayFile.facebook ??= { pageId }).page ??= {})
					dayPage.day = {
						...Object.fromEntries(PAGE_DAY_METRICS.map((m) => [m, series[m][date] ?? null])),
						collectedAt: stamp(),
					}
					accountDays.add(date)
				}
			} catch (error) {
				errors.push(`facebook page insights: ${errorMessage(error)}`)
			}
		}

		try {
			const data = await composio.execute("FACEBOOK_GET_PAGE_POSTS", account, {
				page_id: pageId,
				fields: PAGE_POST_FIELDS,
				limit: 50,
			})
			const posts: Record<string, PostEntry> = {}
			for (const item of listOf(data, (i) => "created_time" in i)) {
				const id = item.id as string
				const previous = lastPostState("facebook", id)
				const entry: PostEntry = {
					permalink: item.permalink_url as string | undefined,
					timestamp: item.created_time as string | undefined,
					caption: typeof item.message === "string" ? item.message.slice(0, 120) : undefined,
					calendar: calendar.get(id) ?? calendar.get(String(item.permalink_url ?? "")) ?? null,
					metrics: null,
					collectedAt: stamp(),
				}
				if (tooOld(item.created_time)) {
					entry.insightsUnavailable = { reason: "Meta keeps no insights for posts older than two years", permanent: true }
				} else if (previous?.insightsUnavailable?.permanent) {
					entry.insightsUnavailable = previous.insightsUnavailable
				} else {
					const result = await postInsights(
						"FACEBOOK_GET_POST_INSIGHTS",
						account,
						(metrics) => ({ post_id: id, metrics: metrics.join(","), period: "lifetime" }),
						PAGE_POST_METRICS,
					)
					if ("metrics" in result) entry.metrics = result.metrics
					else {
						entry.insightsUnavailable = result.unavailable
						if (!result.unavailable.permanent) errors.push(`facebook post ${id}: ${result.unavailable.reason}`)
					}
				}
				const sameDay = fb.posts?.[id]
				if (!entry.metrics && sameDay?.metrics) {
					entry.metrics = sameDay.metrics
					entry.collectedAt = sameDay.collectedAt
					delete entry.insightsUnavailable
				}
				posts[id] = entry
			}
			fb.posts = { ...fb.posts, ...posts }
			facebookPosts = Object.keys(posts).length
		} catch (error) {
			errors.push(`facebook posts: ${errorMessage(error)}`)
		}
	}

	const run: RunRecord = {
		startedAt,
		finishedAt: stamp(),
		status: (!options.instagram || instagramDown) && (!options.facebook || !facebookUp) ? "failed" : errors.length > 0 ? "partial" : "ok",
		composioCalls: structuredClone(composio.calls),
		instagramPosts,
		facebookPosts,
		accountDays: [...accountDays].sort(),
		errors,
	}
	todayFile.runs.push(run)
	for (const file of files.values()) writeDaily(dir, file)
	log(
		`${options.project} ${today}: ${run.status} · ${run.composioCalls.total} Composio calls (${run.composioCalls.failed} failed) · ` +
			`${instagramPosts} Instagram posts · ${facebookPosts} Facebook posts · days ${run.accountDays.join(", ") || "none"}`,
	)
	for (const error of errors) log(`  ${error}`)
	return { file: todayFile, run }
}

function demographicBuckets(data: unknown): Record<string, number> {
	const buckets: Record<string, number> = {}
	const results = deepFind(data, (v) => Array.isArray(v) && v.length > 0 && v.every((r) => isRecord(r) && Array.isArray(r.dimension_values)))
	for (const result of (results as { dimension_values: string[]; value: unknown }[] | undefined) ?? []) {
		const value = numberOrNull(result.value)
		if (value !== null) buckets[result.dimension_values.join(" / ")] = value
	}
	return buckets
}

// ---------- CLI ----------

type ProjectConfig = {
	utcOffset?: string
	instagram?: { composioAccount?: string | null; igUserId?: string | null }
	facebook?: { composioAccount?: string | null; pageId?: string | null }
}

/** The accounts a project collects from, as the publishing flow saved them in its publishing.json. */
export function projectSources(projectsDir: string, project: string): {
	config?: ProjectConfig
	instagram?: CollectOptions["instagram"]
	facebook?: CollectOptions["facebook"]
} {
	const path = join(projectsDir, project, "publishing.json")
	if (!existsSync(path)) return {}
	const config = JSON.parse(readFileSync(path, "utf8")) as ProjectConfig
	const ig = config.instagram
	const fb = config.facebook
	return {
		config,
		// Instagram counts as set up once connection --save stored its account or user id; the Page, once it has an id.
		instagram:
			ig?.composioAccount || ig?.igUserId
				? { ...(ig.composioAccount ? { account: ig.composioAccount } : {}), ...(ig.igUserId ? { igUserId: ig.igUserId } : {}) }
				: undefined,
		facebook: fb?.pageId ? { ...(fb.composioAccount ? { account: fb.composioAccount } : {}), pageId: fb.pageId } : undefined,
	}
}

if (import.meta.main) {
	loadSecrets()
	const base = resolve(import.meta.dir, "..")
	const projectsDir = join(base, "projects")
	const read = (name: string) => process.env[name]?.trim() || undefined
	const wanted = process.argv.slice(2).filter((arg) => !arg.startsWith("-"))
	const projects = wanted.length > 0 ? wanted : existsSync(projectsDir) ? readdirSync(projectsDir).filter((name) => existsSync(join(projectsDir, name, "publishing.json"))) : []
	let exitCode = 0
	for (const project of projects) {
		try {
			const { config, instagram, facebook } = projectSources(projectsDir, project)
			if (!config) throw new Error(`projects/${project}/publishing.json not found`)
			if (!instagram && !facebook) {
				console.log(`${project}: no account in publishing.json yet (run "publishing.ts connection ${project} --save"); skipped`)
				continue
			}
			const { run } = await collect({
				// One client per project, so each run counts only its own calls.
				composio: (() => {
					const client = createComposio()
					return countingComposio((slug, account, args) => client.execute(slug, args, account))
				})(),
				dir: join(resolve(base, read("METRICS_DIR") ?? "metrics"), project),
				project,
				projectsDir,
				instagram,
				facebook,
				now: read("METRICS_NOW") ? new Date(read("METRICS_NOW") as string) : undefined,
				utcOffsetMinutes: parseUtcOffset(read("METRICS_UTC_OFFSET") ?? config.utcOffset ?? "-03:00"),
				lookbackDays: Number(read("METRICS_LOOKBACK_DAYS") ?? 7),
				log: (line) => console.log(line),
			})
			if (!instagram) console.log("  instagram: no connected account in publishing.json yet; skipped")
			if (!facebook) console.log("  facebook: no Page in publishing.json; skipped")
			if (run.status === "failed") exitCode = 1
		} catch (error) {
			console.error(`${project}: error: ${errorMessage(error)}`)
			exitCode = 1
		}
	}
	if (projects.length === 0) console.log("no project has a publishing.json yet; nothing to collect")
	process.exit(exitCode)
}
