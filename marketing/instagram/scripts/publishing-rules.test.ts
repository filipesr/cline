import { describe, expect, test } from "bun:test";
import {
	analyzeCaption,
	applyDecision,
	type CaptionRules,
	DAY_MS,
	fitsInWindow,
	localInstant,
	nextFreeDay,
	parseDecision,
} from "./publishing-rules";

const rules: CaptionRules = {
	maxWords: 20,
	maxEmojis: 1,
	hashtags: {
		min: 3,
		max: 5,
		required: ["#partyshare"],
		allowed: ["#rh", "#endomarketing", "#confraternizacao"],
		forbidden: ["#AFestaQueVocêNãoViu"],
	},
	forbiddenTerms: ["grátis", "RAW", "nenhuma foto se perde"],
	ctas: ["Solicitar proposta corporativa", "Agendar 20 minutos"],
};

const good = `A confraternização acontece uma vez.

Solicitar proposta corporativa.

#partyshare #rh #endomarketing`;

const rulesOf = (problems: { rule: string }[]) => problems.map((p) => p.rule);

describe("analyzeCaption", () => {
	test("accepts a caption within the rules", () => {
		const r = analyzeCaption(good, rules);
		expect(r.problems).toEqual([]);
		expect(r.cta).toBe("Solicitar proposta corporativa");
		expect(r.hashtags).toEqual(["#partyshare", "#rh", "#endomarketing"]);
		expect(r.words).toBe(8);
	});

	test("hashtag in the middle of the text", () => {
		const r = analyzeCaption(
			"A #rh confraternização. Solicitar proposta corporativa. #partyshare #endomarketing",
			rules,
		);
		expect(rulesOf(r.problems)).toContain("hashtags-at-end");
	});

	test("counts words without the hashtags", () => {
		const long = `${"palavra ".repeat(21)}Solicitar proposta corporativa\n#partyshare #rh #endomarketing`;
		expect(rulesOf(analyzeCaption(long, rules).problems)).toContain(
			"max-words",
		);
	});

	test("hashtags: count, required, accent, forbidden and not allowed", () => {
		const r = analyzeCaption(
			"Texto. Agendar 20 minutos.\n#confraternização #AFestaQueVocêNãoViu",
			rules,
		);
		expect(rulesOf(r.problems)).toEqual(
			expect.arrayContaining([
				"hashtag-count",
				"required-hashtag",
				"accented-hashtag",
				"forbidden-hashtag",
				"hashtag-not-allowed",
			]),
		);
	});

	test("forbidden terms ignore accent and case; a short term only as a word", () => {
		const r = analyzeCaption(
			`Teste GRATIS com foto raw. Agendar 20 minutos.\n#partyshare #rh #endomarketing`,
			rules,
		);
		expect(
			r.problems
				.filter((p) => p.rule === "forbidden-term")
				.map((p) => p.detail),
		).toEqual(['"grátis"', '"RAW"']);
		const noFalsePositive = analyzeCaption(
			`O Rawson chegou. Agendar 20 minutos.\n#partyshare #rh #endomarketing`,
			rules,
		);
		expect(rulesOf(noFalsePositive.problems)).not.toContain("forbidden-term");
	});

	test("exactly one CTA", () => {
		const none = analyzeCaption(
			"Texto.\n#partyshare #rh #endomarketing",
			rules,
		);
		const two = analyzeCaption(
			"Solicitar proposta corporativa ou Agendar 20 minutos.\n#partyshare #rh #endomarketing",
			rules,
		);
		expect(rulesOf(none.problems)).toContain("one-cta");
		expect(rulesOf(two.problems)).toContain("one-cta");
	});

	test("emojis above the maximum", () => {
		const r = analyzeCaption(
			`🎉 Festa 📸. Agendar 20 minutos.\n#partyshare #rh #endomarketing`,
			rules,
		);
		expect(rulesOf(r.problems)).toContain("max-emojis");
	});

	test("link required when configured", () => {
		const r = analyzeCaption(good, {
			...rules,
			link: "https://www.partyshare.me/business",
		});
		expect(rulesOf(r.problems)).toContain("link");
	});
});

describe("fitsInWindow", () => {
	const t = Date.parse("2026-10-22T20:00:00-03:00");
	const h = 60 * 60 * 1000;

	test("fits with two posts in the last 24h", () => {
		expect(fitsInWindow(t, [t - 2 * h, t - 5 * h], 3)).toEqual({
			fits: true,
			count: 2,
		});
	});

	test("refuses the fourth in the last 24h", () => {
		expect(fitsInWindow(t, [t - 1 * h, t - 2 * h, t - 23 * h], 3).fits).toBe(
			false,
		);
	});

	test("ignores what left the window", () => {
		expect(fitsInWindow(t, [t - 24 * h, t - 25 * h, t - 30 * h], 3).fits).toBe(
			true,
		);
	});

	test("counts scheduled posts ahead in the same window", () => {
		expect(fitsInWindow(t, [t + 10 * h, t + 11 * h, t + 12 * h], 3).fits).toBe(
			false,
		);
		expect(fitsInWindow(t, [t - 20 * h, t + 10 * h, t + 11 * h], 3).fits).toBe(
			true,
		);
	});

	test("pushes to the next day, and one more if needed", () => {
		const full = [t - 1 * h, t - 2 * h, t - 3 * h];
		expect(nextFreeDay(t, full, 3)).toBe(t + DAY_MS);
		const tomorrowFull = [
			...full,
			t + DAY_MS - h,
			t + DAY_MS - 2 * h,
			t + DAY_MS + h,
		];
		expect(nextFreeDay(t, tomorrowFull, 3)).toBe(t + 2 * DAY_MS);
	});
});

describe("decisions", () => {
	test("each decision leads to its state", () => {
		expect(applyDecision("awaiting_approval", "approve")).toBe("approved");
		expect(applyDecision("awaiting_approval", "request_changes")).toBe(
			"changes_requested",
		);
		expect(applyDecision("awaiting_approval", "discard")).toBe("discarded");
	});

	test("only a draft awaiting approval takes a decision", () => {
		expect(() => applyDecision("draft", "approve")).toThrow();
		expect(() => applyDecision("published", "discard")).toThrow();
	});

	test("reads the card answer by number, label or English value", () => {
		expect(parseDecision("1")).toBe("approve");
		expect(parseDecision("Aprovar")).toBe("approve");
		expect(parseDecision("Pedir ajuste")).toBe("request_changes");
		expect(parseDecision("3")).toBe("discard");
		expect(parseDecision("DESCARTAR")).toBe("discard");
		expect(parseDecision("approve")).toBe("approve");
		expect(parseDecision("request_changes")).toBe("request_changes");
		expect(parseDecision("discard")).toBe("discard");
		expect(parseDecision("talvez")).toBeUndefined();
	});

	test("localInstant uses the project's timezone", () => {
		expect(localInstant("2026-10-22T20:00", "-03:00")).toBe(
			Date.parse("2026-10-22T23:00:00Z"),
		);
		expect(() => localInstant("22/10 20h", "-03:00")).toThrow();
	});
});
