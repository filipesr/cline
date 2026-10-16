import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ComposioError } from "./composio"
import { POST_METRICS, collect, countingComposio, projectSources, readDaily, supportedMetricsAfterError } from "./metrics"

type Call = { slug: string; args: Record<string, unknown> }

/** A Composio that answers like the Instagram/Facebook actions, wrapping Graph bodies the way the actions do. */
function fakeMeta(options: { followers?: number; oldMediaError?: boolean } = {}) {
	const calls: Call[] = []
	const followers = options.followers ?? 325
	const media = [
		{ id: "m1", caption: "Primeiro post", media_type: "IMAGE", media_product_type: "FEED", permalink: "https://instagram.com/p/AAA/", timestamp: "2026-10-10T12:00:00+0000" },
		{ id: "m2", caption: "Reel", media_type: "VIDEO", media_product_type: "REELS", permalink: "https://instagram.com/reel/BBB/", timestamp: "2026-10-12T12:00:00+0000" },
		{ id: "m-old", caption: "Antes da conversão", media_type: "IMAGE", permalink: "https://instagram.com/p/OLD/", timestamp: "2025-09-11T12:00:00+0000" },
	]
	const run = async (slug: string, _account: string | undefined, args: Record<string, unknown>): Promise<unknown> => {
		calls.push({ slug, args })
		switch (slug) {
			case "INSTAGRAM_GET_USER_INFO":
				return { response_data: { id: "17841", username: "partyshare", followers_count: followers, follows_count: 10, media_count: 3 } }
			case "INSTAGRAM_GET_IG_USER_MEDIA":
				return args.after
					? { data: [media[2]], paging: { cursors: { after: "c2" } } }
					: { data: media.slice(0, 2), paging: { cursors: { after: "c1" }, next: "https://graph/next" } }
			case "INSTAGRAM_GET_IG_MEDIA_INSIGHTS": {
				if (args.ig_media_id === "m-old" && options.oldMediaError !== false) {
					throw new ComposioError(slug, "The media was posted before the most recent time that the user's account was converted to a business account")
				}
				const metrics = args.metric as string[]
				return { data: metrics.map((name, i) => ({ name, period: "lifetime", values: [{ value: 10 + i }] })) }
			}
			case "INSTAGRAM_GET_USER_INSIGHTS": {
				// The real action wants a numeric ig_user_id or none at all.
				if ("ig_user_id" in args && !/^\d+$/.test(String(args.ig_user_id))) throw new ComposioError(slug, "ig_user_id must be numeric")
				if ((args.metric as string[])[0] === "follower_demographics" && !args.timeframe) throw new ComposioError(slug, "timeframe is required")
				const metric = args.metric as string[]
				if (metric[0] === "follower_count") {
					const values = []
					for (let t = args.since as number; t < (args.until as number); t += 86_400) {
						// Meta stamps a day with its end, 07:00 UTC.
						values.push({ value: 2, end_time: new Date((t + 86_400 + 4 * 3600) * 1000).toISOString().replace(".000Z", "+0000") })
					}
					return { data: [{ name: "follower_count", period: "day", values }] }
				}
				if (metric[0] === "follower_demographics") {
					return {
						data: [{ name: "follower_demographics", total_value: { breakdowns: [{ results: [{ dimension_values: [String(args.breakdown)], value: 7 }] }] } }],
					}
				}
				return { data: metric.map((name) => ({ name, period: "day", total_value: { value: Number(args.since) % 97 } })) }
			}
			case "FACEBOOK_GET_PAGE_DETAILS":
				return { id: "page1", name: "Party Share", followers_count: 4, fan_count: 3 }
			case "FACEBOOK_GET_PAGE_INSIGHTS": {
				// The real action rejects numbers here.
				if (typeof args.since !== "string" || typeof args.until !== "string") throw new ComposioError(slug, "Input should be a valid string on parameter `since`")
				const metrics = String(args.metrics).split(",")
				return {
					data: metrics.map((name) => {
						const values = []
						for (let t = Number(args.since); t < Number(args.until); t += 86_400) {
							values.push({ value: 1, end_time: new Date((t + 86_400 + 4 * 3600) * 1000).toISOString().replace(".000Z", "+0000") })
						}
						return { name, period: "day", values }
					}),
				}
			}
			case "FACEBOOK_GET_PAGE_POSTS":
				return { data: [{ id: "page1_p1", message: "Olá", created_time: "2026-10-11T10:00:00+0000", permalink_url: "https://facebook.com/p1" }] }
			case "FACEBOOK_GET_POST_INSIGHTS":
				return { data: String(args.metrics).split(",").map((name) => ({ name, period: "lifetime", values: [{ value: 3 }] })) }
			default:
				throw new ComposioError(slug, "unexpected slug in fake")
		}
	}
	return { run, calls }
}

let root: string
let dir: string
let projectsDir: string

beforeEach(() => {
	// Never read the real keys from a test.
	process.env.INSTAGRAM_ENV_FILE = join(tmpdir(), "no-such-instagram.env")
	root = mkdtempSync(join(tmpdir(), "ig-metrics-"))
	dir = join(root, "metrics")
	projectsDir = join(root, "projects")
	const postDir = join(projectsDir, "partyshare", "posts", "2026-10-10-telao")
	mkdirSync(postDir, { recursive: true })
	writeFileSync(
		join(postDir, "post.json"),
		JSON.stringify({
			project: "partyshare",
			slug: "telao",
			date: "2026-10-10",
			code: "E01",
			publishing: { instagram: { mediaId: "m1", permalink: "https://instagram.com/p/AAA/" }, facebook: { postId: "page1_p1" } },
		}),
	)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const at = (iso: string) => new Date(iso)

describe("collect", () => {
	test("two runs in a row keep one entry per post and per day, and log both runs with their calls", async () => {
		const meta = fakeMeta()
		const run = (now: string) =>
			collect({ composio: countingComposio(meta.run), dir, projectsDir, project: "partyshare", instagram: { account: "ca_instagram" }, now: at(now), lookbackDays: 3, facebook: { account: "ca_facebook", pageId: "page1" } })

		const first = await run("2026-10-15T09:00:00-03:00")
		const second = await run("2026-10-15T09:05:00-03:00")

		expect(readdirSync(dir).sort()).toEqual(["2026-10-12.json", "2026-10-13.json", "2026-10-14.json", "2026-10-15.json"])
		const today = readDaily(dir, "2026-10-15")!
		expect(Object.keys(today.instagram!.posts!).sort()).toEqual(["m-old", "m1", "m2"])
		expect(Object.keys(today.facebook!.posts!)).toEqual(["page1_p1"])
		expect(today.runs).toHaveLength(2)
		expect(today.instagram!.account!.day).toBeUndefined()

		// First run: profile, 2 media pages, 3 post insights, 3 days, follower series, 4 demographics;
		// Page: details, insights, posts, 1 post insights.
		expect(first.run.composioCalls.total).toBe(1 + 2 + 3 + 3 + 1 + 4 + 4)
				// Second run: the pre-conversion post and last week's demographics are skipped; day 12 already exists.
		expect(second.run.composioCalls.total).toBe(1 + 2 + 2 + 2 + 1 + 0 + 4)
		expect(second.run.composioCalls.bySlug.INSTAGRAM_GET_IG_MEDIA_INSIGHTS).toBe(2)
		expect(today.runs.map((r) => r.composioCalls.total)).toEqual([first.run.composioCalls.total, second.run.composioCalls.total])
		expect(second.run.status).toBe("ok")

		for (const date of ["2026-10-12", "2026-10-13", "2026-10-14"]) {
			const file = readDaily(dir, date)!
			expect(file.runs).toEqual([])
			expect(file.instagram!.account!.day!.reach).toBeNumber()
			expect(file.instagram!.account!.day!.new_followers).toBe(2)
			expect(file.facebook!.page!.day!.page_media_view).toBe(1)
		}
	})

	test("the next day adds a new snapshot file without rewriting older days beyond the refresh window", async () => {
		const meta = fakeMeta()
		const run = (now: string) => collect({ composio: countingComposio(meta.run), dir, projectsDir, project: "partyshare", instagram: { account: "ca_instagram" }, now: at(now), lookbackDays: 3 })
		await run("2026-10-15T09:00:00-03:00")
		const before = readDaily(dir, "2026-10-12")!
		const next = await run("2026-10-16T09:00:00-03:00")

		expect(next.run.accountDays).toEqual(["2026-10-14", "2026-10-15"])
		expect(readDaily(dir, "2026-10-12")).toEqual(before)
		expect(readDaily(dir, "2026-10-15")!.instagram!.account!.day).toBeDefined()
		expect(readDaily(dir, "2026-10-15")!.runs).toHaveLength(1)
		expect(readDaily(dir, "2026-10-16")!.runs).toHaveLength(1)
		expect(Object.keys(readDaily(dir, "2026-10-16")!.instagram!.posts!)).toHaveLength(3)
	})

	test("posts carry their metrics and the calendar item they came from", async () => {
		const meta = fakeMeta()
		const { file } = await collect({ composio: countingComposio(meta.run), dir, projectsDir, project: "partyshare", instagram: { account: "ca_instagram" }, now: at("2026-10-15T09:00:00-03:00"), facebook: { account: "ca_facebook", pageId: "page1" } })
		const m1 = file.instagram!.posts!.m1
		expect(Object.keys(m1.metrics!)).toEqual(POST_METRICS)
		expect(m1.metrics!.views).toBe(10)
		expect(m1.calendar).toEqual({ project: "partyshare", post: "projects/partyshare/posts/2026-10-10-telao/post.json", slug: "telao", date: "2026-10-10", code: "E01" })
		expect(file.instagram!.posts!.m2.calendar).toBeNull()
		expect(file.instagram!.posts!["m-old"].insightsUnavailable?.permanent).toBe(true)
		expect(file.facebook!.posts!.page1_p1.calendar?.code).toBe("E01")
		expect(file.facebook!.posts!.page1_p1.metrics).toEqual({ post_media_view: 3, post_total_media_view_unique: 3 })
		const asked = meta.calls.find((c) => c.slug === "INSTAGRAM_GET_IG_MEDIA_INSIGHTS")!.args.metric as string[]
		expect(asked).not.toContain("impressions")
		expect(asked).not.toContain("plays")
	})

	test("under 100 followers there are no demographics and no follower series, and the file says why", async () => {
		const meta = fakeMeta({ followers: 12 })
		const { file, run } = await collect({ composio: countingComposio(meta.run), dir, projectsDir, project: "partyshare", instagram: { account: "ca_instagram" }, now: at("2026-10-15T09:00:00-03:00"), lookbackDays: 2 })
		expect(file.instagram!.account!.demographics).toMatchObject({ available: false })
		expect(run.composioCalls.bySlug.INSTAGRAM_GET_USER_INSIGHTS).toBe(2)
		expect(readDaily(dir, "2026-10-14")!.instagram!.account!.day!.new_followers).toBeNull()
		expect(run.status).toBe("ok")
	})

	test("a profile failure marks the run failed but still records it with its calls", async () => {
		const broken = countingComposio(async (slug) => {
			throw new ComposioError(slug, "HTTP 401")
		})
		const { run } = await collect({ composio: broken, dir, projectsDir, project: "partyshare", instagram: { account: "ca_instagram" }, now: at("2026-10-15T09:00:00-03:00") })
		expect(run.status).toBe("failed")
		expect(run.composioCalls).toMatchObject({ total: 1, failed: 1 })
		expect(readDaily(dir, "2026-10-15")!.runs).toHaveLength(1)
	})
})

describe("project sources", () => {
	test("the accounts come from the project's publishing.json; a Page without composioAccount uses the default account", () => {
		writeFileSync(
			join(projectsDir, "partyshare", "publishing.json"),
			JSON.stringify({
				utcOffset: "-03:00",
				instagram: { composioAccount: null, igUserId: null },
				facebook: { mirror: true, composioAccount: null, pageId: "1351629444696145" },
			}),
		)
		const sources = projectSources(projectsDir, "partyshare")
		expect(sources.instagram).toBeUndefined()
		expect(sources.facebook).toEqual({ pageId: "1351629444696145" })
		expect(projectSources(projectsDir, "other").config).toBeUndefined()
	})

	test("with Instagram pending, the Page alone makes an ok run", async () => {
		const meta = fakeMeta()
		const { file, run } = await collect({
			composio: countingComposio(meta.run),
			dir,
			projectsDir,
			project: "partyshare",
			facebook: { account: "ca_facebook", pageId: "page1" },
			now: at("2026-10-15T09:00:00-03:00"),
		})
		expect(run.status).toBe("ok")
		expect(file.instagram).toBeUndefined()
		expect(meta.calls.some((c) => c.slug.startsWith("INSTAGRAM_"))).toBe(false)
	})

	test("a numeric igUserId goes to every Instagram call", async () => {
		const meta = fakeMeta({ followers: 12 })
		await collect({
			composio: countingComposio(meta.run),
			dir,
			projectsDir,
			project: "partyshare",
			instagram: { account: "ca_instagram", igUserId: "17841" },
			now: at("2026-10-15T09:00:00-03:00"),
			lookbackDays: 1,
		})
		expect(meta.calls.filter((c) => c.slug.startsWith("INSTAGRAM_GET_USER")).every((c) => c.args.ig_user_id === "17841")).toBe(true)
	})
})

describe("supportedMetricsAfterError", () => {
	test("drops a metric Meta says it does not support", () => {
		expect(supportedMetricsAfterError("does not support the saved metric for this media product type", POST_METRICS)).toEqual(
			POST_METRICS.filter((m) => m !== "saved"),
		)
	})
	test("keeps only the allowed list", () => {
		expect(supportedMetricsAfterError("metric[0] must be one of the following values: reach, views", POST_METRICS)).toEqual(["views", "reach"])
	})
	test("gives up on unrelated errors", () => {
		expect(supportedMetricsAfterError("HTTP 500", POST_METRICS)).toBeUndefined()
	})
})
