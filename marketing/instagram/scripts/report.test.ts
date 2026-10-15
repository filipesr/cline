import { describe, expect, test } from "bun:test"
import type { DailyFile, PostEntry } from "./metrics"
import { countingComposio } from "./metrics"
import { itensDoCalendario } from "./publicacao-regras"
import { buildReport, commentTheme, isoWeek, parseWeek, type ReportInput, readComments, weekPosts } from "./report"

const CAMPAIGN = `# Campanha

## 10. Calendário

| Data | Pilar | Formato | Ideia | CTA | Pub. |
|---|---|---|---|---|---|
| ter 20/out | 1. Telão | Reels 20s | **E01:** o telão recebendo a foto | Solicitar proposta corporativa | 2 |
| qua 21/out | 2. Confraternização | Story | Enquete | — | 1 |
| qui 22/out | 2. Confraternização | Carrossel 6 cards | **E02:** a confraternização que a empresa pagou e não guardou | Solicitar proposta corporativa | 2 |
| sex 23/out | 3. Seguro | Card | **E09:** card avulso de TI | Agendar 20 minutos | 1 |
| ter 27/out | 4. De perto | Carrossel 5 cards (texto) | **E03:** carta do fundador | Agendar 20 minutos | 2 |
| qui 29/out | 3. Seguro | Carrossel 5 cards | **E04:** o que a TI precisa saber | Solicitar proposta corporativa | 2 |

## 11. Em aberto
`

function post(timestamp: string, calendar: PostEntry["calendar"], metrics: PostEntry["metrics"], extra: Partial<PostEntry> = {}): PostEntry {
	return { timestamp, calendar, metrics, collectedAt: "2026-10-26T10:00:00Z", ...extra }
}

const ref = (slug: string, date: string) => ({ project: "partyshare", post: `projects/partyshare/posts/${date}-${slug}/post.json`, slug, date })

/** A week of collected metrics: week 43 (19–25/out), plus the week before for the comparison. */
function exampleDaily(): Map<string, DailyFile> {
	const daily = new Map<string, DailyFile>()
	const day = (date: string, reach: number, interactions: number, followers: number, pageReach: number): DailyFile => ({
		schema: 1,
		date,
		utcOffset: "-03:00",
		instagram: {
			account: {
				day: { reach, views: reach * 3, accounts_engaged: Math.round(interactions / 2), total_interactions: interactions, new_followers: null, collectedAt: "x" },
				snapshot: { followers_count: followers, collectedAt: "x" },
			},
		},
		facebook: {
			pageId: "page1",
			page: { day: { page_total_media_view_unique: pageReach, page_media_view: pageReach * 2, page_post_engagements: 3, collectedAt: "x" }, snapshot: { followers_count: 40, collectedAt: "x" } },
		},
		runs: [{ startedAt: "x", finishedAt: "x", status: "ok", composioCalls: { total: 9, failed: 0, bySlug: {} }, instagramPosts: 3, facebookPosts: 2, accountDays: [], errors: [] }],
	})
	for (let i = 0; i < 7; i++) {
		const before = `2026-10-${String(12 + i).padStart(2, "0")}`
		daily.set(before, day(before, 100, 6, 300 + i, 20))
		const date = `2026-10-${String(19 + i).padStart(2, "0")}`
		daily.set(date, day(date, 150, 12, 310 + i * 2, 30))
	}
	// Monday's run: the lifetime totals of the week's posts.
	const monday = day("2026-10-26", 150, 12, 324, 30)
	monday.instagram = {
		...monday.instagram,
		posts: {
			ig1: post("2026-10-20T23:00:00+0000", ref("telao", "2026-10-20"), { reach: 400, views: 900, likes: 20, comments: 2, saved: 3, shares: 1, total_interactions: 26 }, { mediaType: "VIDEO", productType: "REELS", permalink: "https://instagram.com/reel/E01/" }),
			ig2: post("2026-10-22T23:00:00+0000", ref("confraternizacao", "2026-10-22"), { reach: 500, views: 1400, likes: 50, comments: 4, saved: 12, shares: 4, total_interactions: 70 }, { mediaType: "CAROUSEL_ALBUM", permalink: "https://instagram.com/p/E02/" }),
			ig3: post("2026-10-24T15:00:00+0000", null, { reach: 300, views: 500, likes: 8, comments: 0, saved: 0, shares: 0, total_interactions: 8 }, { mediaType: "IMAGE", caption: "Bastidor do ensaio do telão" }),
			old: post("2026-10-14T23:00:00+0000", null, { reach: 999, views: 999, likes: 99, comments: 0, saved: 0, shares: 0, total_interactions: 99 }, { mediaType: "IMAGE" }),
		},
	}
	monday.facebook = {
		...(monday.facebook as NonNullable<DailyFile["facebook"]>),
		posts: {
			fb2: post("2026-10-22T23:00:00+0000", ref("confraternizacao", "2026-10-22"), { post_media_view: 80, post_total_media_view_unique: 60 }),
		},
	}
	daily.set("2026-10-26", monday)
	return daily
}

function exampleInput(overrides: Partial<ReportInput> = {}): ReportInput {
	return {
		project: "partyshare",
		week: parseWeek("2026-W43"),
		daily: exampleDaily(),
		posts: new Map([
			["projects/partyshare/posts/2026-10-20-telao/post.json", { pilar: "1. Telão", formato: "post", slug: "telao", data: "2026-10-20" }],
			["projects/partyshare/posts/2026-10-22-confraternizacao/post.json", { pilar: "2. Confraternização", formato: "carrossel", slug: "confraternizacao", data: "2026-10-22" }],
		]),
		calendar: itensDoCalendario(CAMPAIGN, 2026) ?? [],
		comments: new Map([
			["instagram:ig1", ["Quanto custa para 200 pessoas?", "@ana.rh olha isso", "Incrível!"]],
			["instagram:ig2", ["E o preço?", "A TI da empresa libera?"]],
			["facebook:fb2", ["Qual o valor do pacote?"]],
		]),
		reportCalls: { total: 3, failed: 0, bySlug: {} },
		consumption: "Composio out/2026: 66 chamadas até 26/10",
		sources: { instagram: true, facebook: true },
		utcOffsetMinutes: -180,
		...overrides,
	}
}

describe("weeks", () => {
	test("ISO weeks start on Monday", () => {
		expect(isoWeek("2026-10-26")).toEqual({ label: "2026-W44", start: "2026-10-26", end: "2026-11-01" })
		expect(isoWeek("2026-10-25").label).toBe("2026-W43")
		expect(parseWeek("2026-W43")).toEqual({ label: "2026-W43", start: "2026-10-19", end: "2026-10-25" })
		expect(isoWeek("2027-01-01").label).toBe("2026-W53")
		expect(() => parseWeek("2026-43")).toThrow("AAAA-Www")
	})
})

describe("posts of the week", () => {
	test("ranks the week's posts with pillar and format from post.json, the calendar or the media type", () => {
		const rows = weekPosts(exampleInput())
		expect(rows.map((r) => [r.network, r.label, r.pilar, r.formato, r.hour])).toEqual([
			["instagram", "E02", "2. Confraternização", "carrossel", 20],
			// E01 comes from the calendar line of that date and pillar; the media type wins over post.json.
			["instagram", "E01", "1. Telão", "reels", 20],
			["instagram", "Bastidor do ensaio do telão", "fora do calendário", "post", 12],
			["facebook", "E02", "2. Confraternização", "carrossel", 20],
		])
		expect(rows[0].engagement).toBeCloseTo(0.14)
	})

	test("a later snapshot without metrics keeps the last one that had them", () => {
		const daily = exampleDaily()
		const later = structuredClone(daily.get("2026-10-26") as DailyFile)
		later.date = "2026-10-27"
		for (const entry of Object.values(later.instagram?.posts ?? {})) entry.metrics = null
		daily.set("2026-10-27", later)
		expect(weekPosts(exampleInput({ daily })).find((r) => r.id === "ig2")?.reach).toBe(500)
	})
})

describe("comments", () => {
	test("themes come from the words of the comment", () => {
		expect(commentTheme("Quanto custa?")).toBe("Preço e orçamento")
		expect(commentTheme("A TI libera?")).toBe("TI, segurança e moderação")
		expect(commentTheme("precisa instalar app?")).toBe("Como funciona")
		expect(commentTheme("e se cair o wi-fi")).toBe("Internet e wi-fi")
		expect(commentTheme("amei 😍")).toBe("Elogio e interesse")
		expect(commentTheme("@fulano")).toBe("Outros")
	})

	test("reads Instagram comments only where the post has some, and every Page post", async () => {
		const slugs: string[] = []
		const composio = countingComposio(async (slug) => {
			slugs.push(slug)
			return slug.startsWith("INSTAGRAM") ? { data: [{ id: "c1", text: "Quanto custa?" }] } : { data: { data: [{ id: "c2", message: "Qual o valor?" }] } }
		})
		const rows = weekPosts(exampleInput())
		const { comments, errors } = await readComments(composio, rows, {})
		expect(errors).toEqual([])
		expect(slugs).toEqual(["INSTAGRAM_GET_IG_MEDIA_COMMENTS", "INSTAGRAM_GET_IG_MEDIA_COMMENTS", "FACEBOOK_GET_COMMENTS"])
		expect(comments.get("facebook:fb2")).toEqual(["Qual o valor?"])
		expect(composio.calls.total).toBe(3)
	})
})

describe("report", () => {
	test("crosses metrics and campaign into a short report with three recommendations", () => {
		const { markdown, summary } = buildReport(exampleInput())
		expect(markdown).toContain("# partyshare: semana 2026-W43 (19/out – 25/out)")
		expect(markdown).toContain("3 posts no Instagram e 1 na Página na semana · 2 de 3 do calendário")
		// 7 × 150 against 7 × 100; followers as read the morning after each week, 324 against 310.
		expect(markdown).toContain("| Instagram | 1.050 (+50%)")
		expect(markdown).toContain("| 324 (+14) |")
		expect(markdown).toContain("| 🔻 Bastidor do ensaio do telão | IG |")
		expect(markdown).toContain("| E02 | FB |")
		expect(markdown).toContain("🥇 [E02](https://instagram.com/p/E02/)")
		expect(markdown).toContain("| 2. Confraternização · carrossel | 1 | 500 | 14% | E02 | — |")
		expect(markdown).toContain("**Fora do ar:** E09 (sex 23/out, card, pilar 3. Seguro).")
		expect(markdown).toContain("- **Preço e orçamento** (3): “Quanto custa para 200 pessoas?”")
		expect(markdown).not.toContain("ana.rh")
		expect(markdown).toContain("_Composio: 63 chamadas na coleta diária da semana e 3 neste relatório._")
		expect(markdown).toContain("_Composio out/2026: 66 chamadas até 26/10_")
		const recs = markdown.split("## Para a semana que vem")[1].trim().split("\n").filter((l) => /^\d\. /.test(l))
		expect(recs).toHaveLength(3)
		expect(recs[0]).toStartWith("1. E09 (sex 23/out")
		expect(recs[1]).toContain('"Preço e orçamento" apareceu em 3 comentários')
		expect(recs[1]).toContain("E04 (qui 29/out")
		expect(recs[1]).toContain("sem citar valor")
		expect(recs[2]).toContain("Mais carrossel")
		expect(summary).toBe("partyshare 2026-W43: 4 posts · 6 comments · 3 Composio calls")
	})

	test("without Instagram and without posts it still gives three concrete steps", () => {
		const daily = new Map([...exampleDaily()].map(([date, file]) => [date, { ...file, instagram: undefined }]))
		const { markdown } = buildReport(exampleInput({ daily, sources: { instagram: false, facebook: true }, comments: new Map() }))
		expect(markdown).toContain("_Instagram ainda não conectado: fica de fora._")
		expect(markdown).toContain("Nenhum comentário nos posts da semana.")
		expect(markdown).not.toContain("| Instagram |")
		const recs = markdown.split("## Para a semana que vem")[1].trim().split("\n").filter((l) => /^\d\. /.test(l))
		expect(recs).toHaveLength(3)
		expect(recs[0]).toContain("Conectar o Instagram")
	})

	test("a week with no metrics at all says so instead of failing", () => {
		const { markdown } = buildReport(exampleInput({ daily: new Map(), comments: undefined, week: parseWeek("2026-W45") }))
		expect(markdown).toContain("Nenhum post publicado nesta semana tem métricas ainda.")
		expect(markdown).toContain("_Instagram: métricas de 0 de 7 dias._")
		expect(markdown).toContain("Comentários não lidos nesta execução.")
		expect(markdown.match(/^\d\. /gm)).toHaveLength(3)
		expect(markdown).toContain("A coleta diária faltou em alguns dias (Instagram 0/7, Página 0/7)")
	})
})
