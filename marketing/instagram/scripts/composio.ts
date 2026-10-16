/**
 * Minimal Composio client for the publishing flow, through the consumer MCP
 * (https://connect.composio.dev/mcp), which is where the Instagram account and the Facebook Page
 * are connected (see composio.md).
 *
 * Connections do not carry over from one Composio project to another. The Cline API connector
 * proxy (sdk/packages/core/src/extensions/composio/) talks to Cline's project and requires a
 * logged-in Cline session with CLINE_COMPOSIO_BETA, so it cannot see these accounts. Each action
 * runs through COMPOSIO_MULTI_EXECUTE_TOOL, one at a time, because publishing depends on order.
 *
 * Env: COMPOSIO_CONSUMER_API_KEY (ck_…, composio.dev → For You → Connect my agent) and
 * COMPOSIO_MCP_URL (optional).
 */

const DEFAULT_MCP_URL = "https://connect.composio.dev/mcp";

export class ComposioError extends Error {
	constructor(
		readonly slug: string,
		message: string,
	) {
		super(`${slug}: ${message}`);
	}
}

export type Composio = {
	/** What Composio says about these toolkits' connections, as it came. */
	connections(toolkits: string[]): Promise<unknown>;
	/** The input schema of each action, from COMPOSIO_GET_TOOL_SCHEMAS (a meta tool: not billed). */
	schemas(slugs: string[]): Promise<unknown>;
	/** `account` picks among several accounts of the same toolkit, when Composio accepts it. */
	execute(
		slug: string,
		args: Record<string, unknown>,
		account?: string | null,
	): Promise<unknown>;
};

/** Actions' `data` sometimes arrives as JSON text; always returns the already-parsed value. */
export function parseData(data: unknown): unknown {
	if (typeof data !== "string") return data;
	try {
		return JSON.parse(data);
	} catch {
		return data;
	}
}

/**
 * First value of `key` found depth-first. Actions wrap the Graph API response in different
 * ways (`data.id`, `data.response_data.id`, `data.data[0].id`), and the flow only needs the
 * field.
 */
export function findField(value: unknown, key: string, depth = 6): unknown {
	if (!value || typeof value !== "object" || depth < 0) return undefined;
	const record = value as Record<string, unknown>;
	if (
		!Array.isArray(value) &&
		record[key] !== undefined &&
		record[key] !== null
	) {
		return record[key];
	}
	for (const child of Object.values(record)) {
		const found = findField(parseData(child), key, depth - 1);
		if (found !== undefined) return found;
	}
	return undefined;
}

/** A JSON-RPC response, whether it comes as JSON or as SSE events. */
function parseMcpResponse(
	text: string,
	contentType: string,
): Record<string, unknown> | undefined {
	if (!contentType.includes("text/event-stream")) {
		return text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
	}
	const messages = text
		.split("\n")
		.filter((l) => l.startsWith("data:"))
		.map((l) => l.slice(5).trim())
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
	return messages.find((m) => "result" in m || "error" in m);
}

type Schema = { properties?: Record<string, Record<string, unknown>> };

export function createComposio(options?: {
	key?: string;
	url?: string;
	fetch?: typeof fetch;
}): Composio {
	const key = options?.key ?? process.env.COMPOSIO_CONSUMER_API_KEY?.trim();
	if (!key) {
		throw new Error(
			"falta COMPOSIO_CONSUMER_API_KEY (composio.dev → For You → Connect my agent, chave ck_…); ponha em ~/.config/cline-marketing/instagram.env",
		);
	}
	const url =
		options?.url ?? process.env.COMPOSIO_MCP_URL?.trim() ?? DEFAULT_MCP_URL;
	const http = options?.fetch ?? fetch;
	let session: string | undefined;
	let schemas: Map<string, Schema> | undefined;
	let nextId = 1;

	async function rpc(method: string, params: unknown, notification = false) {
		const response = await http(url, {
			method: "POST",
			headers: {
				"x-consumer-api-key": key as string,
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...(session ? { "mcp-session-id": session } : {}),
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				method,
				params,
				...(notification ? {} : { id: nextId++ }),
			}),
			signal: AbortSignal.timeout(180_000),
		});
		session = response.headers.get("mcp-session-id") ?? session;
		const text = await response.text();
		if (!response.ok) {
			throw new ComposioError(
				method,
				`HTTP ${response.status} ${text.slice(0, 400)}`,
			);
		}
		if (notification) return undefined;
		const message = parseMcpResponse(
			text,
			response.headers.get("content-type") ?? "",
		);
		if (message?.error)
			throw new ComposioError(
				method,
				JSON.stringify(message.error).slice(0, 400),
			);
		return message?.result as Record<string, unknown> | undefined;
	}

	async function init() {
		if (schemas) return schemas;
		await rpc("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "marketing-instagram", version: "1" },
		});
		await rpc("notifications/initialized", {}, true);
		const list = await rpc("tools/list", {});
		schemas = new Map(
			(
				(list?.tools as { name: string; inputSchema?: Schema }[] | undefined) ??
				[]
			).map((t) => [t.name, t.inputSchema ?? {}]),
		);
		for (const required of [
			"COMPOSIO_MULTI_EXECUTE_TOOL",
			"COMPOSIO_MANAGE_CONNECTIONS",
		]) {
			if (!schemas.has(required))
				throw new ComposioError("tools/list", `o MCP não expõe ${required}`);
		}
		return schemas;
	}

	/** Calls a meta tool and returns the result's `data`, already unwrapped from the MCP envelope. */
	async function meta(name: string, args: Record<string, unknown>) {
		await init();
		const result = await rpc("tools/call", {
			name,
			arguments: args,
		});
		const texts = (
			(result?.content as { type: string; text?: string }[] | undefined) ?? []
		)
			.filter((c) => c.type === "text" && c.text)
			.map((c) => c.text as string);
		const body = (parseData(texts.join("")) ?? {}) as Record<string, unknown>;
		if (result?.isError || body.successful === false) {
			throw new ComposioError(
				name,
				String(body.error ?? texts.join(" ").slice(0, 600)),
			);
		}
		return parseData(body.data ?? body);
	}

	return {
		async connections(toolkits) {
			const properties =
				(await init()).get("COMPOSIO_MANAGE_CONNECTIONS")?.properties ?? {};
			// List only: without `action: "list"` the same tool opens a new connection (the default
			// is "add"). Today the action goes in each toolkit ({ name, action }); it used to be a
			// single one at the top level.
			const item = (properties.toolkits?.items as Schema | undefined)
				?.properties;
			if (item && "action" in item) {
				return meta("COMPOSIO_MANAGE_CONNECTIONS", {
					toolkits: toolkits.map((name) => ({ name, action: "list" })),
				});
			}
			if ("action" in properties) {
				return meta("COMPOSIO_MANAGE_CONNECTIONS", {
					toolkits,
					action: "list",
				});
			}
			throw new ComposioError(
				"COMPOSIO_MANAGE_CONNECTIONS",
				'o esquema não tem "action"; sem ela a chamada abriria conexões novas em vez de listar',
			);
		},

		async schemas(slugs) {
			const properties =
				(await init()).get("COMPOSIO_GET_TOOL_SCHEMAS")?.properties ?? {};
			// The list of slugs has had more than one name; use whichever the server declares.
			const field = ["tool_slugs", "tools", "slugs"].find(
				(f) => f in properties,
			);
			if (!field)
				throw new ComposioError(
					"COMPOSIO_GET_TOOL_SCHEMAS",
					`esquema inesperado: ${Object.keys(properties).join(", ") || "sem campos"}`,
				);
			return meta("COMPOSIO_GET_TOOL_SCHEMAS", { [field]: slugs });
		},

		async execute(slug, args, account) {
			const items = (await init()).get("COMPOSIO_MULTI_EXECUTE_TOOL")
				?.properties?.tools?.items as Schema | undefined;
			const accountField = ["account", "connected_account_id"].find(
				(c) => c in (items?.properties ?? {}),
			);
			const data = (await meta("COMPOSIO_MULTI_EXECUTE_TOOL", {
				tools: [
					{
						tool_slug: slug,
						arguments: args,
						...(account && accountField ? { [accountField]: account } : {}),
					},
				],
				thought: `publishing.ts: ${slug}`,
				sync_response_to_workbench: false,
			})) as { results?: Record<string, unknown>[] };
			const result = data?.results?.[0];
			if (!result)
				throw new ComposioError(
					slug,
					`sem resultado: ${JSON.stringify(data).slice(0, 400)}`,
				);
			const response = parseData(result.response) as
				| Record<string, unknown>
				| undefined;
			if (result.error || response?.successful === false) {
				const error = result.error ?? response?.error ?? "falhou";
				throw new ComposioError(
					slug,
					typeof error === "string"
						? error
						: JSON.stringify(error).slice(0, 600),
				);
			}
			return parseData(response?.data ?? response);
		},
	};
}
