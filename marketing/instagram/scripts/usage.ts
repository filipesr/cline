#!/usr/bin/env bun
/**
 * Composio usage: sums the calls each job recorded, projects the month and compares it with
 * the free plan. The weekly report's usage line and the 70% warning come from here.
 *
 *   bun scripts/usage.ts            # month summary: total, projection, by flow, project and action
 *   bun scripts/usage.ts --line     # one line, for the weekly report
 *   bun scripts/usage.ts --warn     # the same line; exits with 2 when the projection passes the warning
 *   bun scripts/usage.ts --json
 *
 * What each job records:
 * - metrics (metrics.ts): `runs[].composioCalls` in metrics/<project>/<YYYY-MM-DD>.json;
 * - publishing (publishing.ts): one line per command that called Composio in
 *   projects/<project>/composio-calls.jsonl.
 *
 * The quota is our account's in Composio's consumer area (ck_ key), not Cline's: the scripts
 * do not go through the Cline API connector proxy (see composio.md).
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Composio } from "./composio";
import { localDate, parseUtcOffset } from "./metrics";

/**
 * Calls per month on the Hobby (free) plan, which also includes 50,000 triggers; checked at
 * composio.dev/pricing on 2026-10-15.
 */
export const FREE_PLAN_CALLS = 100_000;
export const DEFAULT_WARN_PCT = 70;
export const PUBLISHING_CALLS_FILE = "composio-calls.jsonl";

/** The same format as the metrics' `runs[].composioCalls`. */
export type CallCount = {
	total: number;
	failed: number;
	bySlug: Record<string, number>;
	/** Meta tools (COMPOSIO_MANAGE_CONNECTIONS…): Composio does not bill them, so they stay out of `total`. */
	metaTools?: Record<string, number>;
};

export function newCallCount(): CallCount {
	return { total: 0, failed: 0, bySlug: {}, metaTools: {} };
}

/** Counts each executed action, failures included, because Composio bills those too. */
export function countCalls(client: Composio, count: CallCount): Composio {
	return {
		async connections(toolkits) {
			const meta = count.metaTools ?? {};
			meta.COMPOSIO_MANAGE_CONNECTIONS =
				(meta.COMPOSIO_MANAGE_CONNECTIONS ?? 0) + 1;
			count.metaTools = meta;
			return client.connections(toolkits);
		},
		async execute(slug, args, account) {
			count.total++;
			count.bySlug[slug] = (count.bySlug[slug] ?? 0) + 1;
			try {
				return await client.execute(slug, args, account);
			} catch (error) {
				count.failed++;
				throw error;
			}
		},
	};
}

export type PublishingCallRecord = {
	at: string;
	command: string;
	post?: string;
	/** Set on lines rebuilt by hand from a post's history, saying where they came from. */
	reconstructed?: string;
	composioCalls: CallCount;
};

export function recordPublishingCalls(
	projectDir: string,
	record: PublishingCallRecord,
) {
	appendFileSync(
		join(projectDir, PUBLISHING_CALLS_FILE),
		`${JSON.stringify(record)}\n`,
	);
}

// ---------------------------------------------------------------------------------------------
// Reading

export type Flow = "publishing" | "metrics";

export type UsageRecord = {
	at: string;
	flow: Flow;
	project: string;
	calls: number;
	failed: number;
	bySlug: Record<string, number>;
};

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function subdirs(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name);
}

function toUsageRecord(
	at: unknown,
	flow: Flow,
	project: string,
	calls: CallCount | undefined,
): UsageRecord | undefined {
	if (typeof at !== "string" || Number.isNaN(Date.parse(at)) || !calls)
		return undefined;
	return {
		at,
		flow,
		project,
		calls: Number(calls.total) || 0,
		failed: Number(calls.failed) || 0,
		bySlug: calls.bySlug ?? {},
	};
}

/** Everything the jobs recorded, across all projects. */
export function readUsageRecords(dirs: {
	projects: string;
	metrics: string;
}): UsageRecord[] {
	const records: UsageRecord[] = [];
	for (const project of subdirs(dirs.metrics)) {
		const dir = join(dirs.metrics, project);
		for (const file of readdirSync(dir)) {
			if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(file)) continue;
			const day = readJson(join(dir, file)) as
				| { runs?: { startedAt?: string; composioCalls?: CallCount }[] }
				| undefined;
			for (const run of day?.runs ?? []) {
				const r = toUsageRecord(
					run.startedAt,
					"metrics",
					project,
					run.composioCalls,
				);
				if (r) records.push(r);
			}
		}
	}
	for (const project of subdirs(dirs.projects)) {
		const file = join(dirs.projects, project, PUBLISHING_CALLS_FILE);
		if (!existsSync(file)) continue;
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (!line.trim()) continue;
			let item: PublishingCallRecord | undefined;
			try {
				item = JSON.parse(line);
			} catch {
				continue;
			}
			const r = toUsageRecord(
				item?.at,
				"publishing",
				project,
				item?.composioCalls,
			);
			if (r) records.push(r);
		}
	}
	return records.sort((a, b) => a.at.localeCompare(b.at));
}

// ---------------------------------------------------------------------------------------------
// Projection

const DAY = 86_400_000;

export type UsageProjection = {
	month: string;
	through: string;
	limit: number;
	warnPct: number;
	/** Calls recorded in the month so far. */
	monthCalls: number;
	monthFailed: number;
	byFlow: Record<Flow, number>;
	byProject: Record<string, number>;
	bySlug: Record<string, number>;
	/** Daily average used in the projection: the last 7 days, or since the first record. */
	perDay: number;
	averageDays: number;
	projection: number;
	pct: number;
	aboveWarning: boolean;
	noRecords: boolean;
	/** Composio has no triggers for Instagram or Facebook, so no job generates events. */
	triggers: number;
};

function add(target: Record<string, number>, key: string, value: number) {
	target[key] = (target[key] ?? 0) + value;
}

/**
 * Projection for the current month: what was already recorded in the month, plus the daily
 * average of the last 7 days times what is left of the month. With less than 7 days of history,
 * the average is since the first record (and at least one day), which skews high right after a
 * new job starts.
 */
export function projectUsage(
	records: UsageRecord[],
	options: {
		now: Date;
		offsetMin: number;
		limit?: number;
		warnPct?: number;
	},
): UsageProjection {
	const { now, offsetMin } = options;
	const limit = options.limit ?? FREE_PLAN_CALLS;
	const warnPct = options.warnPct ?? DEFAULT_WARN_PCT;
	const today = localDate(now, offsetMin);
	const month = today.slice(0, 7);
	const [year, m] = month.split("-").map(Number);
	// End of the local month: midnight of the next month's 1st, at the project's offset.
	const monthEnd = Date.UTC(year, m, 1) - offsetMin * 60_000;
	const t = now.getTime();
	const past = records.filter((r) => Date.parse(r.at) <= t);

	const byFlow: Record<Flow, number> = { publishing: 0, metrics: 0 };
	const byProject: Record<string, number> = {};
	const bySlug: Record<string, number> = {};
	let monthCalls = 0;
	let monthFailed = 0;
	for (const r of past) {
		if (localDate(new Date(r.at), offsetMin).slice(0, 7) !== month) continue;
		monthCalls += r.calls;
		monthFailed += r.failed;
		byFlow[r.flow] += r.calls;
		add(byProject, r.project, r.calls);
		for (const [slug, n] of Object.entries(r.bySlug)) add(bySlug, slug, n);
	}

	const first = past.length ? Date.parse(past[0].at) : t;
	const averageStart = Math.max(t - 7 * DAY, first);
	const averageDays = Math.max(1, (t - averageStart) / DAY);
	const inWindow = past
		.filter((r) => Date.parse(r.at) >= averageStart)
		.reduce((s, r) => s + r.calls, 0);
	const perDay = inWindow / averageDays;
	const projection = Math.round(
		monthCalls + perDay * Math.max(0, (monthEnd - t) / DAY),
	);
	const pct = (projection / limit) * 100;
	return {
		month,
		through: today,
		limit,
		warnPct,
		monthCalls,
		monthFailed,
		byFlow,
		byProject,
		bySlug,
		perDay,
		averageDays,
		projection,
		pct,
		aboveWarning: pct > warnPct,
		noRecords: past.length === 0,
		triggers: 0,
	};
}

// ---------------------------------------------------------------------------------------------
// Output

const MONTHS = "jan fev mar abr mai jun jul ago set out nov dez".split(" ");
const integer = (n: number) => Math.round(n).toLocaleString("pt-BR");
const percent = (n: number) =>
	`${n.toLocaleString("pt-BR", { maximumFractionDigits: n < 10 ? 1 : 0 })}%`;
const thousands = (n: number) =>
	n % 1000 === 0 ? `${n / 1000} mil` : integer(n);

/** The weekly report's line (and the warning's). */
export function usageLine(p: UsageProjection): string {
	const [year, m] = p.month.split("-");
	const when = `${MONTHS[Number(m) - 1]}/${year}`;
	const day = `${p.through.slice(8, 10)}/${p.through.slice(5, 7)}`;
	if (p.noRecords) {
		return `Composio ${when}: nenhum job registrou chamadas ainda · plano gratuito ${thousands(p.limit)} chamadas/mês`;
	}
	const body =
		`Composio ${when}: ${integer(p.monthCalls)} chamadas até ${day} ` +
		`(publicação ${integer(p.byFlow.publishing)} · métricas ${integer(p.byFlow.metrics)}) · ` +
		`projeção ${integer(p.projection)} no mês = ${percent(p.pct)} do gratuito (${thousands(p.limit)}) · ` +
		`triggers ${p.triggers}`;
	return p.aboveWarning
		? `⚠️ Composio acima de ${p.warnPct}% do gratuito. ${body}. Decisão do projeto: passar para o conector nativo da Meta.`
		: body;
}

function summary(p: UsageProjection): string {
	const lines = [usageLine(p), ""];
	lines.push(
		`Média usada: ${p.perDay.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} chamadas/dia em ${p.averageDays.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} dia(s)`,
	);
	lines.push(`Falhas no mês (contam na cota): ${integer(p.monthFailed)}`);
	lines.push(
		`Aviso em ${p.warnPct}% = ${integer((p.limit * p.warnPct) / 100)} chamadas/mês`,
	);
	const table = (title: string, values: Record<string, number>) => {
		const items = Object.entries(values)
			.filter(([, n]) => n > 0)
			.sort((a, b) => b[1] - a[1]);
		if (!items.length) return;
		lines.push("", title);
		for (const [k, n] of items) lines.push(`  ${integer(n).padStart(7)}  ${k}`);
	};
	table("Por projeto:", p.byProject);
	table("Por ação:", p.bySlug);
	return lines.join("\n");
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			line: { type: "boolean", default: false },
			warn: { type: "boolean", default: false },
			json: { type: "boolean", default: false },
		},
	});
	const base = resolve(import.meta.dir, "..");
	const read = (name: string) => process.env[name]?.trim() || undefined;
	const projection = projectUsage(
		readUsageRecords({
			projects: join(base, "projects"),
			metrics: resolve(base, read("METRICS_DIR") ?? "metrics"),
		}),
		{
			now: read("USAGE_NOW")
				? new Date(read("USAGE_NOW") as string)
				: new Date(),
			offsetMin: parseUtcOffset(read("METRICS_UTC_OFFSET") ?? "-03:00"),
			limit: Number(read("COMPOSIO_FREE_CALLS") ?? FREE_PLAN_CALLS),
			warnPct: Number(read("USAGE_WARN_PCT") ?? DEFAULT_WARN_PCT),
		},
	);
	if (values.json) console.log(JSON.stringify(projection, null, "\t"));
	else if (values.line || values.warn) console.log(usageLine(projection));
	else console.log(summary(projection));
	if (values.warn && projection.aboveWarning) process.exit(2);
}
