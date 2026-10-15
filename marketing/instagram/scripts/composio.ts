/**
 * Cliente mínimo do Composio para o fluxo de publicação, pelo MCP de consumidor
 * (https://connect.composio.dev/mcp), que é onde a conta Instagram e a Página do Facebook
 * estão conectadas (ver composio.md).
 *
 * As conexões não passam de um projeto do Composio para outro. O proxy de conectores da Cline
 * API (sdk/packages/core/src/extensions/composio/) fala com o projeto da Cline e exige uma
 * sessão Cline logada com CLINE_COMPOSIO_BETA, então não enxerga estas contas. Cada ação roda
 * por COMPOSIO_MULTI_EXECUTE_TOOL, uma de cada vez, porque a publicação depende da ordem.
 *
 * Env: COMPOSIO_CONSUMER_API_KEY (ck_…, composio.dev → For You → Connect my agent) e
 * COMPOSIO_MCP_URL (opcional).
 */

const MCP_PADRAO = "https://connect.composio.dev/mcp";

export class ErroComposio extends Error {
	constructor(
		readonly slug: string,
		mensagem: string,
	) {
		super(`${slug}: ${mensagem}`);
	}
}

export type Composio = {
	/** O que o Composio diz das conexões destes toolkits, como veio. */
	conexoes(toolkits: string[]): Promise<unknown>;
	/** `conta` escolhe entre várias contas do mesmo toolkit, quando o Composio aceita. */
	executar(
		slug: string,
		argumentos: Record<string, unknown>,
		conta?: string | null,
	): Promise<unknown>;
};

/** O `data` das ações às vezes chega como JSON em texto; devolve sempre o valor já lido. */
export function lerDados(data: unknown): unknown {
	if (typeof data !== "string") return data;
	try {
		return JSON.parse(data);
	} catch {
		return data;
	}
}

/**
 * Primeiro valor de `chave` encontrado em profundidade. As ações embrulham a resposta da Graph
 * API de jeitos diferentes (`data.id`, `data.response_data.id`, `data.data[0].id`), e o fluxo
 * só precisa do campo.
 */
export function acharCampo(
	valor: unknown,
	chave: string,
	profundidade = 6,
): unknown {
	if (!valor || typeof valor !== "object" || profundidade < 0) return undefined;
	const registro = valor as Record<string, unknown>;
	if (
		!Array.isArray(valor) &&
		registro[chave] !== undefined &&
		registro[chave] !== null
	) {
		return registro[chave];
	}
	for (const filho of Object.values(registro)) {
		const achado = acharCampo(lerDados(filho), chave, profundidade - 1);
		if (achado !== undefined) return achado;
	}
	return undefined;
}

/** Uma resposta JSON-RPC, venha ela como JSON ou como eventos SSE. */
function lerRespostaMcp(
	texto: string,
	contentType: string,
): Record<string, unknown> | undefined {
	if (!contentType.includes("text/event-stream")) {
		return texto ? (JSON.parse(texto) as Record<string, unknown>) : undefined;
	}
	const mensagens = texto
		.split("\n")
		.filter((l) => l.startsWith("data:"))
		.map((l) => l.slice(5).trim())
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
	return mensagens.find((m) => "result" in m || "error" in m);
}

type Esquema = { properties?: Record<string, Record<string, unknown>> };

export function criarComposio(opcoes?: {
	chave?: string;
	url?: string;
	fetch?: typeof fetch;
}): Composio {
	const chave = opcoes?.chave ?? process.env.COMPOSIO_CONSUMER_API_KEY?.trim();
	if (!chave) {
		throw new Error(
			"falta COMPOSIO_CONSUMER_API_KEY (composio.dev → For You → Connect my agent, chave ck_…); ponha em ~/.config/cline-marketing/instagram.env",
		);
	}
	const url = opcoes?.url ?? process.env.COMPOSIO_MCP_URL?.trim() ?? MCP_PADRAO;
	const http = opcoes?.fetch ?? fetch;
	let sessao: string | undefined;
	let esquemas: Map<string, Esquema> | undefined;
	let proximoId = 1;

	async function rpc(metodo: string, params: unknown, notificacao = false) {
		const resposta = await http(url, {
			method: "POST",
			headers: {
				"x-consumer-api-key": chave as string,
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...(sessao ? { "mcp-session-id": sessao } : {}),
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				method: metodo,
				params,
				...(notificacao ? {} : { id: proximoId++ }),
			}),
			signal: AbortSignal.timeout(180_000),
		});
		sessao = resposta.headers.get("mcp-session-id") ?? sessao;
		const texto = await resposta.text();
		if (!resposta.ok) {
			throw new ErroComposio(
				metodo,
				`HTTP ${resposta.status} ${texto.slice(0, 400)}`,
			);
		}
		if (notificacao) return undefined;
		const mensagem = lerRespostaMcp(
			texto,
			resposta.headers.get("content-type") ?? "",
		);
		if (mensagem?.error)
			throw new ErroComposio(
				metodo,
				JSON.stringify(mensagem.error).slice(0, 400),
			);
		return mensagem?.result as Record<string, unknown> | undefined;
	}

	async function iniciar() {
		if (esquemas) return esquemas;
		await rpc("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "marketing-instagram", version: "1" },
		});
		await rpc("notifications/initialized", {}, true);
		const lista = await rpc("tools/list", {});
		esquemas = new Map(
			(
				(lista?.tools as
					| { name: string; inputSchema?: Esquema }[]
					| undefined) ?? []
			).map((t) => [t.name, t.inputSchema ?? {}]),
		);
		for (const necessaria of [
			"COMPOSIO_MULTI_EXECUTE_TOOL",
			"COMPOSIO_MANAGE_CONNECTIONS",
		]) {
			if (!esquemas.has(necessaria))
				throw new ErroComposio("tools/list", `o MCP não expõe ${necessaria}`);
		}
		return esquemas;
	}

	/** Chama uma meta tool e devolve o `data` do resultado, já sem o embrulho do MCP. */
	async function meta(nome: string, argumentos: Record<string, unknown>) {
		await iniciar();
		const resultado = await rpc("tools/call", {
			name: nome,
			arguments: argumentos,
		});
		const textos = (
			(resultado?.content as { type: string; text?: string }[] | undefined) ??
			[]
		)
			.filter((c) => c.type === "text" && c.text)
			.map((c) => c.text as string);
		const corpo = (lerDados(textos.join("")) ?? {}) as Record<string, unknown>;
		if (resultado?.isError || corpo.successful === false) {
			throw new ErroComposio(
				nome,
				String(corpo.error ?? textos.join(" ").slice(0, 600)),
			);
		}
		return lerDados(corpo.data ?? corpo);
	}

	return {
		async conexoes(toolkits) {
			const propriedades =
				(await iniciar()).get("COMPOSIO_MANAGE_CONNECTIONS")?.properties ?? {};
			// Só listar: sem `action: "list"` a mesma ferramenta abre uma conexão nova (o padrão é
			// "add"). Hoje a ação vai em cada toolkit ({ name, action }); antes ia uma só no topo.
			const item = (propriedades.toolkits?.items as Esquema | undefined)
				?.properties;
			if (item && "action" in item) {
				return meta("COMPOSIO_MANAGE_CONNECTIONS", {
					toolkits: toolkits.map((name) => ({ name, action: "list" })),
				});
			}
			if ("action" in propriedades) {
				return meta("COMPOSIO_MANAGE_CONNECTIONS", {
					toolkits,
					action: "list",
				});
			}
			throw new ErroComposio(
				"COMPOSIO_MANAGE_CONNECTIONS",
				'o esquema não tem "action"; sem ela a chamada abriria conexões novas em vez de listar',
			);
		},

		async executar(slug, argumentos, conta) {
			const itens = (await iniciar()).get("COMPOSIO_MULTI_EXECUTE_TOOL")
				?.properties?.tools?.items as Esquema | undefined;
			const campoConta = ["account", "connected_account_id"].find(
				(c) => c in (itens?.properties ?? {}),
			);
			const data = (await meta("COMPOSIO_MULTI_EXECUTE_TOOL", {
				tools: [
					{
						tool_slug: slug,
						arguments: argumentos,
						...(conta && campoConta ? { [campoConta]: conta } : {}),
					},
				],
				thought: `publicacao.ts: ${slug}`,
				sync_response_to_workbench: false,
			})) as { results?: Record<string, unknown>[] };
			const resultado = data?.results?.[0];
			if (!resultado)
				throw new ErroComposio(
					slug,
					`sem resultado: ${JSON.stringify(data).slice(0, 400)}`,
				);
			const resposta = lerDados(resultado.response) as
				| Record<string, unknown>
				| undefined;
			if (resultado.error || resposta?.successful === false) {
				const erro = resultado.error ?? resposta?.error ?? "falhou";
				throw new ErroComposio(
					slug,
					typeof erro === "string" ? erro : JSON.stringify(erro).slice(0, 600),
				);
			}
			return lerDados(resposta?.data ?? resposta);
		},
	};
}
