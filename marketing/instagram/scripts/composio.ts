/**
 * Cliente mínimo da API do Composio (composio.dev, v3.1) para o fluxo de publicação.
 *
 * Fala direto com o backend do Composio, com a chave da conta onde o Instagram e a Página do
 * Facebook foram conectados. O proxy de conectores da Cline API (a extensão em
 * sdk/packages/core/src/extensions/composio/) só existe dentro de uma sessão Cline logada, e
 * a publicação precisa rodar de um script determinístico, sem um modelo decidindo cada passo.
 *
 * Env: COMPOSIO_API_KEY (obrigatória), COMPOSIO_BASE_URL (opcional).
 */

const BASE_PADRAO = "https://backend.composio.dev/api/v3.1";

export type ContaConectada = {
	id: string;
	status: string;
	toolkit: string;
	userId?: string;
};

export type ResultadoComposio = {
	successful: boolean;
	data: unknown;
	error?: string | null;
	logId?: string;
};

export class ErroComposio extends Error {
	constructor(
		readonly slug: string,
		mensagem: string,
		readonly logId?: string,
	) {
		super(`${slug}: ${mensagem}${logId ? ` (log ${logId})` : ""}`);
	}
}

export type Composio = {
	contas(toolkit: string): Promise<ContaConectada[]>;
	executar(
		slug: string,
		contaId: string,
		argumentos: Record<string, unknown>,
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
 * API de jeitos diferentes (`data.id`, `data.response_data.id`, `data.data.id`), e o fluxo só
 * precisa do campo.
 */
export function acharCampo(
	valor: unknown,
	chave: string,
	profundidade = 5,
): unknown {
	if (!valor || typeof valor !== "object" || profundidade < 0) return undefined;
	const registro = valor as Record<string, unknown>;
	if (registro[chave] !== undefined && registro[chave] !== null)
		return registro[chave];
	for (const filho of Object.values(registro)) {
		const achado = acharCampo(lerDados(filho), chave, profundidade - 1);
		if (achado !== undefined) return achado;
	}
	return undefined;
}

export function criarComposio(opcoes?: {
	chave?: string;
	base?: string;
	fetch?: typeof fetch;
}): Composio {
	const chave = opcoes?.chave ?? process.env.COMPOSIO_API_KEY?.trim();
	if (!chave) {
		throw new Error(
			"falta COMPOSIO_API_KEY (composio.dev → Settings → API Keys); ponha em marketing/instagram/.env",
		);
	}
	const base = (
		opcoes?.base ??
		process.env.COMPOSIO_BASE_URL?.trim() ??
		BASE_PADRAO
	).replace(/\/+$/, "");
	const http = opcoes?.fetch ?? fetch;

	async function pedir(caminho: string, init?: RequestInit) {
		const resposta = await http(`${base}${caminho}`, {
			...init,
			headers: {
				"x-api-key": chave as string,
				"content-type": "application/json",
			},
			signal: AbortSignal.timeout(180_000),
		});
		const texto = await resposta.text();
		let corpo: unknown;
		try {
			corpo = texto ? JSON.parse(texto) : undefined;
		} catch {
			corpo = texto;
		}
		return { ok: resposta.ok, status: resposta.status, corpo };
	}

	return {
		async contas(toolkit) {
			const r = await pedir(
				`/connected_accounts?toolkit_slugs=${encodeURIComponent(toolkit)}&limit=50`,
			);
			if (!r.ok) {
				throw new ErroComposio(
					`connected_accounts(${toolkit})`,
					`HTTP ${r.status} ${JSON.stringify(r.corpo).slice(0, 400)}`,
				);
			}
			const itens = (r.corpo as { items?: unknown[] })?.items ?? [];
			return itens.flatMap((item): ContaConectada[] => {
				const i = item as Record<string, unknown>;
				const slug = (i.toolkit as { slug?: string } | undefined)?.slug;
				if (typeof i.id !== "string" || !slug) return [];
				return [
					{
						id: i.id,
						status: String(i.status ?? ""),
						toolkit: slug.toLowerCase(),
						userId: typeof i.user_id === "string" ? i.user_id : undefined,
					},
				];
			});
		},

		async executar(slug, contaId, argumentos) {
			const r = await pedir(`/tools/execute/${encodeURIComponent(slug)}`, {
				method: "POST",
				body: JSON.stringify({
					connected_account_id: contaId,
					arguments: argumentos,
				}),
			});
			const corpo = (r.corpo ?? {}) as Record<string, unknown>;
			const logId = typeof corpo.log_id === "string" ? corpo.log_id : undefined;
			if (!r.ok) {
				throw new ErroComposio(
					slug,
					`HTTP ${r.status} ${JSON.stringify(corpo).slice(0, 600)}`,
					logId,
				);
			}
			if (corpo.successful === false) {
				const erro =
					corpo.error ??
					acharCampo(lerDados(corpo.data), "message") ??
					"falhou";
				throw new ErroComposio(
					slug,
					typeof erro === "string" ? erro : JSON.stringify(erro).slice(0, 600),
					logId,
				);
			}
			return lerDados(corpo.data);
		},
	};
}
