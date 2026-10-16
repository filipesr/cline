/**
 * Pure rules of the publishing flow: what a caption may contain, how many posts fit in a
 * 24h window and where a draft can go after each decision. No disk and no network, so the
 * tests cover exactly what decides whether a post goes live.
 */

export type PublishingState =
	| "draft"
	| "awaiting_approval"
	| "changes_requested"
	| "approved"
	| "scheduled"
	| "published"
	| "discarded"
	| "removed";

export type Decision = "approve" | "request_changes" | "discard";

/** A project's caption rules, read from projects/<project>/publishing.json. */
export type CaptionRules = {
	maxWords: number;
	maxEmojis: number;
	maxChars?: number;
	hashtags: {
		min: number;
		max: number;
		required?: string[];
		/** When set, only these (and the required ones) are accepted. */
		allowed?: string[];
		forbidden?: string[];
	};
	/** Snippets that must not appear, compared without accents and case. */
	forbiddenTerms?: string[];
	/** The caption ends with exactly one of these CTAs. */
	ctas?: string[];
	/** When set, the caption must contain a link starting with this. */
	link?: string;
};

export type CaptionProblem = { rule: string; detail: string };

export type CaptionAnalysis = {
	text: string;
	body: string;
	words: number;
	emojis: number;
	hashtags: string[];
	cta?: string;
	problems: CaptionProblem[];
};

const HASHTAG = /#[\p{L}\p{N}_]+/gu;
const EMOJI = /\p{Extended_Pictographic}/gu;

export function stripAccents(text: string) {
	return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Checks a caption against the project's rules. Hashtags must all be at the end: after the
 * first one, only another hashtag may follow. That is the campaign rule ("never in the middle
 * of the text") and also what keeps the body countable in words.
 */
export function analyzeCaption(
	rawText: string,
	rules: CaptionRules,
): CaptionAnalysis {
	const text = rawText.replace(/\r\n/g, "\n").trim();
	const problems: CaptionProblem[] = [];
	const hashtags = text.match(HASHTAG) ?? [];
	const first = hashtags[0] !== undefined ? text.indexOf(hashtags[0]) : -1;
	const body = (first >= 0 ? text.slice(0, first) : text).trim();
	const tail = first >= 0 ? text.slice(first) : "";

	if (tail.replace(HASHTAG, "").trim().length > 0) {
		problems.push({
			rule: "hashtags-at-end",
			detail: "depois da primeira hashtag só podem vir hashtags",
		});
	}

	const words = body.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
	if (words > rules.maxWords) {
		problems.push({
			rule: "max-words",
			detail: `${words} palavras; o máximo é ${rules.maxWords}`,
		});
	}
	if (rules.maxChars && text.length > rules.maxChars) {
		problems.push({
			rule: "max-chars",
			detail: `${text.length} caracteres; o máximo é ${rules.maxChars}`,
		});
	}

	const emojis = (text.match(EMOJI) ?? []).length;
	if (emojis > rules.maxEmojis) {
		problems.push({
			rule: "max-emojis",
			detail: `${emojis} emojis; o máximo é ${rules.maxEmojis}`,
		});
	}

	const normalized = hashtags.map((h) => h.toLowerCase());
	if (
		hashtags.length < rules.hashtags.min ||
		hashtags.length > rules.hashtags.max
	) {
		problems.push({
			rule: "hashtag-count",
			detail: `${hashtags.length} hashtags; o permitido é de ${rules.hashtags.min} a ${rules.hashtags.max}`,
		});
	}
	const duplicates = normalized.filter((h, i) => normalized.indexOf(h) !== i);
	if (duplicates.length) {
		problems.push({
			rule: "duplicate-hashtag",
			detail: [...new Set(duplicates)].join(" "),
		});
	}
	const accented = hashtags.filter((h) => stripAccents(h) !== h.toLowerCase());
	if (accented.length) {
		problems.push({
			rule: "accented-hashtag",
			detail: `${accented.join(" ")}: escreva sem acento`,
		});
	}
	for (const required of rules.hashtags.required ?? []) {
		if (!normalized.includes(required.toLowerCase())) {
			problems.push({
				rule: "required-hashtag",
				detail: `falta ${required}`,
			});
		}
	}
	const forbidden = (rules.hashtags.forbidden ?? []).map((h) =>
		stripAccents(h),
	);
	const usedForbidden = hashtags.filter((h) =>
		forbidden.includes(stripAccents(h)),
	);
	if (usedForbidden.length) {
		problems.push({
			rule: "forbidden-hashtag",
			detail: usedForbidden.join(" "),
		});
	}
	if (rules.hashtags.allowed) {
		const accepted = new Set(
			[...rules.hashtags.allowed, ...(rules.hashtags.required ?? [])].map((h) =>
				h.toLowerCase(),
			),
		);
		const outside = hashtags.filter((h) => !accepted.has(h.toLowerCase()));
		if (outside.length) {
			problems.push({
				rule: "hashtag-not-allowed",
				detail: `${outside.join(" ")} não está na lista do projeto`,
			});
		}
	}

	const plainText = stripAccents(text);
	for (const term of rules.forbiddenTerms ?? []) {
		const target = stripAccents(term);
		// Short terms ("RAW", "4K") only count as a whole word: "rawson" is not "RAW".
		const found = /^[\p{L}\p{N}]+$/u.test(target)
			? new RegExp(`(^|[^\\p{L}\\p{N}])${target}([^\\p{L}\\p{N}]|$)`, "u").test(
					plainText,
				)
			: plainText.includes(target);
		if (found) {
			problems.push({ rule: "forbidden-term", detail: `"${term}"` });
		}
	}

	let cta: string | undefined;
	if (rules.ctas?.length) {
		const plainBody = stripAccents(body);
		const used = rules.ctas.filter((c) => plainBody.includes(stripAccents(c)));
		if (used.length !== 1) {
			problems.push({
				rule: "one-cta",
				detail: used.length
					? `há ${used.length} CTAs (${used.join(", ")}); use um só`
					: `falta o CTA; use um de: ${rules.ctas.join(" | ")}`,
			});
		} else {
			cta = used[0];
		}
	}

	if (rules.link && !text.includes(rules.link)) {
		problems.push({ rule: "link", detail: `falta o link ${rules.link}…` });
	}

	return { text, body, words, emojis, hashtags, cta, problems };
}

// ---------------------------------------------------------------------------------------------
// Per-project posting cap

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a post at instant `target` keeps every 24h window at no more than `limit` posts
 * of the project. Looking only at the previous 24h is not enough: three posts already
 * scheduled for tomorrow morning share a window with a post published tonight.
 *
 * The largest count of a window containing `target` happens in a window that starts at one
 * of the events (or at the target itself), so testing those starts is enough.
 */
export function fitsInWindow(target: number, taken: number[], limit: number) {
	const events = [
		...taken.filter((t) => Math.abs(t - target) < DAY_MS),
		target,
	].sort((a, b) => a - b);
	let worst = 0;
	for (const start of events) {
		if (start > target || start <= target - DAY_MS) continue;
		const n = events.filter((t) => t >= start && t < start + DAY_MS).length;
		worst = Math.max(worst, n);
	}
	return { fits: worst <= limit, count: worst - 1 };
}

/** Same time, one day later, as many times as needed until it fits. */
export function nextFreeDay(
	target: number,
	taken: number[],
	limit: number,
	maxDays = 30,
) {
	for (let d = 1; d <= maxDays; d++) {
		const candidate = target + d * DAY_MS;
		if (fitsInWindow(candidate, taken, limit).fits) return candidate;
	}
	return undefined;
}

// ---------------------------------------------------------------------------------------------
// Draft states

/** Where each user decision takes a draft that awaits approval. */
export function applyDecision(
	state: PublishingState,
	decision: Decision,
): PublishingState {
	if (state !== "awaiting_approval") {
		throw new Error(
			`só um rascunho aguardando aprovação recebe decisão; este está em "${state}"`,
		);
	}
	return decision === "approve"
		? "approved"
		: decision === "request_changes"
			? "changes_requested"
			: "discarded";
}

/**
 * Reads the text of a card answer: by number, by the (Portuguese) button label, or by the
 * English decision value. Case- and accent-insensitive.
 */
export function parseDecision(answer: string): Decision | undefined {
	const a = stripAccents(answer.trim());
	if (a === "1" || a.startsWith("aprov") || a === "approve") return "approve";
	if (
		a === "2" ||
		a.startsWith("pedir ajuste") ||
		a.startsWith("ajuste") ||
		a === "request_changes"
	)
		return "request_changes";
	if (a === "3" || a.startsWith("descart") || a === "discard") return "discard";
	return undefined;
}

/** Instant "YYYY-MM-DDTHH:MM" in the project's timezone (fixed offsets only, like Brasília's). */
export function localInstant(dateTime: string, offset: string) {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dateTime)) {
		throw new Error(`"${dateTime}" deve ser AAAA-MM-DDTHH:MM`);
	}
	const t = Date.parse(`${dateTime}:00${offset}`);
	if (Number.isNaN(t)) throw new Error(`data inválida: ${dateTime}`);
	return t;
}

// ---------------------------------------------------------------------------------------------
// Calendar

/** Month abbreviations as campaign.md writes them (Portuguese content). */
const MONTHS = [
	"jan",
	"fev",
	"mar",
	"abr",
	"mai",
	"jun",
	"jul",
	"ago",
	"set",
	"out",
	"nov",
	"dez",
];

export type CalendarItem = Record<string, string> & {
	/** As written in the table's "data" column, for example "qui 22/out". */
	day: string;
	/** YYYY-MM-DD. */
	date: string;
	/** E02, when the idea starts with **E02:**. */
	code?: string;
};

/**
 * Rows of a campaign.md calendar table, with the date already as YYYY-MM-DD and the other
 * columns keyed by their lowercase header as campaign.md names them (pilar, formato, ideia,
 * cta…). Without a calendar section, returns `undefined`.
 */
export function calendarItems(
	campaign: string,
	year: number,
): CalendarItem[] | undefined {
	const campaignLines = campaign.split("\n");
	const start = campaignLines.findIndex((l) =>
		/^#{1,6}\s+(\d+\.\s*)?calend[áa]rio/i.test(l),
	);
	if (start < 0) return undefined;
	const lines = campaignLines.slice(start + 1);
	const end = lines.findIndex((l) => /^#{1,2}\s/.test(l));
	const table = (end < 0 ? lines : lines.slice(0, end)).filter((l) =>
		l.startsWith("|"),
	);
	const header =
		table[0]
			?.split("|")
			.slice(1, -1)
			.map((c) => c.trim().toLowerCase()) ?? [];
	return table.slice(2).flatMap((line) => {
		const cells = line
			.split("|")
			.slice(1, -1)
			.map((c) => c.trim());
		const row: Record<string, string> = Object.fromEntries(
			header.map((c, i) => [c, cells[i] ?? ""]),
		);
		// "data" and "ideia" are campaign.md's own (Portuguese) column headers.
		const { data: day = "", ...columns } = row;
		const m = day.match(/(\d{1,2})\/([a-zç]{3})/i);
		const month = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
		if (!m || month < 0) return [];
		const date = `${year}-${String(month + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
		const code = (row.ideia ?? "").match(/\*\*(E\d+)/)?.[1];
		return [{ ...columns, day, date, ...(code ? { code } : {}) }];
	});
}
