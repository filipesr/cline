import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Composio } from "./composio";
import {
	countCalls,
	newCallCount,
	PUBLISHING_CALLS_FILE,
	projectUsage,
	readUsageRecords,
	type UsageRecord,
	usageLine,
} from "./usage";

const SP = -180;
let tempDirs: string[] = [];
afterEach(() => {
	for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
	tempDirs = [];
});

function record(
	at: string,
	calls: number,
	flow: UsageRecord["flow"] = "metrics",
): UsageRecord {
	return {
		at,
		flow,
		project: "partyshare",
		calls,
		failed: 0,
		bySlug: { X: calls },
	};
}

describe("countCalls", () => {
	test("counts each action, failures included, and meta tools separately", async () => {
		const fake: Composio = {
			connections: async () => ({}),
			execute: async (slug) => {
				if (slug === "BAD") throw new Error("failed");
				return {};
			},
		};
		const count = newCallCount();
		const c = countCalls(fake, count);
		await c.connections(["facebook"]);
		await c.execute("FACEBOOK_GET_POST", {});
		await c.execute("FACEBOOK_GET_POST", {});
		await c.execute("BAD", {}).catch(() => {});
		expect(count).toEqual({
			total: 3,
			failed: 1,
			bySlug: { FACEBOOK_GET_POST: 2, BAD: 1 },
			metaTools: { COMPOSIO_MANAGE_CONNECTIONS: 1 },
		});
	});
});

describe("readUsageRecords", () => {
	test("sums the metrics runs and the publishing lines, of each project", () => {
		const root = mkdtempSync(join(tmpdir(), "usage-"));
		tempDirs.push(root);
		mkdirSync(join(root, "metrics", "partyshare"), { recursive: true });
		mkdirSync(join(root, "projects", "partyshare"), { recursive: true });
		writeFileSync(
			join(root, "metrics", "partyshare", "2026-10-14.json"),
			JSON.stringify({
				runs: [
					{
						startedAt: "2026-10-14T10:00:00Z",
						composioCalls: {
							total: 4,
							failed: 1,
							bySlug: { FACEBOOK_GET_PAGE_DETAILS: 4 },
						},
					},
					{
						startedAt: "2026-10-14T12:00:00Z",
						composioCalls: { total: 2, failed: 0, bySlug: {} },
					},
				],
			}),
		);
		writeFileSync(join(root, "metrics", "partyshare", "notes.json"), "{}");
		writeFileSync(
			join(root, "projects", "partyshare", PUBLISHING_CALLS_FILE),
			`${JSON.stringify({ at: "2026-10-15T18:00:00Z", command: "publish", post: "2026-10-15-x", composioCalls: { total: 6, failed: 0, bySlug: { FACEBOOK_CREATE_PHOTO_POST: 1 } } })}\nbroken line\n`,
		);
		const records = readUsageRecords({
			projects: join(root, "projects"),
			metrics: join(root, "metrics"),
		});
		expect(records.map((r) => [r.flow, r.calls, r.failed])).toEqual([
			["metrics", 4, 1],
			["metrics", 2, 0],
			["publishing", 6, 0],
		]);
	});

	test("without directories, no records", () => {
		expect(
			readUsageRecords({
				projects: "/does/not/exist",
				metrics: "/does/not/exist",
			}),
		).toEqual([]);
	});
});

describe("projectUsage", () => {
	test("the month so far plus the last 7 days' average times what is left", () => {
		// 10 calls a day, at 10am São Paulo, from Oct 1 to 15; now is Oct 15 12pm.
		const records = Array.from({ length: 15 }, (_, i) =>
			record(`2026-10-${String(i + 1).padStart(2, "0")}T13:00:00Z`, 10),
		);
		const p = projectUsage(records, {
			now: new Date("2026-10-15T15:00:00Z"),
			offsetMin: SP,
		});
		expect(p.month).toBe("2026-10");
		expect(p.monthCalls).toBe(150);
		// A 7-day window catches 7 runs (Oct 9 to 15): 70/7 = 10 a day; 16.5 days are left.
		expect(p.perDay).toBeCloseTo(10, 5);
		expect(p.projection).toBe(150 + 165);
		expect(p.aboveWarning).toBe(false);
	});

	test("the month follows the timezone: 1am UTC on the 1st is still the previous month in São Paulo", () => {
		const p = projectUsage([record("2026-11-01T01:00:00Z", 50)], {
			now: new Date("2026-11-01T02:00:00Z"),
			offsetMin: SP,
		});
		expect(p.month).toBe("2026-10");
		expect(p.monthCalls).toBe(50);
	});

	test("with less than 7 days of history, the average is since the first record (at least 1 day)", () => {
		const p = projectUsage([record("2026-10-15T13:00:00Z", 100)], {
			now: new Date("2026-10-15T15:00:00Z"),
			offsetMin: SP,
		});
		expect(p.averageDays).toBe(1);
		expect(p.perDay).toBe(100);
	});

	test("passes the warning above 70% of the free plan, and the line says what to do", () => {
		const p = projectUsage([record("2026-10-02T13:00:00Z", 75_000)], {
			now: new Date("2026-10-31T12:00:00Z"),
			offsetMin: SP,
		});
		expect(p.aboveWarning).toBe(true);
		expect(usageLine(p)).toStartWith("⚠️ Composio acima de 70% do gratuito.");
		expect(usageLine(p)).toContain("conector nativo da Meta");
	});

	test("the line splits publishing and metrics and shows the percentage", () => {
		const p = projectUsage(
			[
				record("2026-10-14T13:00:00Z", 120),
				record("2026-10-15T13:00:00Z", 6, "publishing"),
			],
			{ now: new Date("2026-10-15T15:00:00Z"), offsetMin: SP },
		);
		const line = usageLine(p);
		expect(line).toStartWith(
			"Composio out/2026: 126 chamadas até 15/10 (publicação 6 · métricas 120)",
		);
		expect(line).toContain("do gratuito (100 mil) · triggers 0");
	});

	test("without records, the line says so instead of projecting zero", () => {
		const p = projectUsage([], {
			now: new Date("2026-10-15T15:00:00Z"),
			offsetMin: SP,
		});
		expect(p.noRecords).toBe(true);
		expect(usageLine(p)).toBe(
			"Composio out/2026: nenhum job registrou chamadas ainda · plano gratuito 100 mil chamadas/mês",
		);
	});
});
