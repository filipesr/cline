/**
 * Regras puras do fluxo de publicação: o que uma legenda pode ter, quantas publicações cabem
 * numa janela de 24h e para onde um rascunho pode ir depois de cada decisão. Sem disco e sem
 * rede, para que os testes cubram exatamente o que decide se um post vai ao ar.
 */

export type Estado =
	| "rascunho"
	| "aguardando_aprovacao"
	| "ajuste"
	| "aprovado"
	| "agendado"
	| "publicado"
	| "descartado"
	| "removido";

export type Decisao = "aprovar" | "ajuste" | "descartar";

/** Regras de legenda de um projeto, lidas de projects/<projeto>/publicacao.json. */
export type RegrasLegenda = {
	maxPalavras: number;
	maxEmojis: number;
	maxCaracteres?: number;
	hashtags: {
		min: number;
		max: number;
		obrigatorias?: string[];
		/** Quando definida, só estas (e as obrigatórias) valem. */
		permitidas?: string[];
		proibidas?: string[];
	};
	/** Trechos que não podem aparecer, comparados sem acento e sem caixa. */
	termosProibidos?: string[];
	/** A legenda termina com exatamente um destes CTAs. */
	ctas?: string[];
	/** Quando definido, a legenda precisa conter um link que comece assim. */
	link?: string;
};

export type Problema = { regra: string; detalhe: string };

export type LegendaAnalisada = {
	texto: string;
	corpo: string;
	palavras: number;
	emojis: number;
	hashtags: string[];
	cta?: string;
	problemas: Problema[];
};

const HASHTAG = /#[\p{L}\p{N}_]+/gu;
const EMOJI = /\p{Extended_Pictographic}/gu;

export function semAcento(texto: string) {
	return texto.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Confere uma legenda contra as regras do projeto. As hashtags precisam estar todas no fim:
 * depois da primeira, só pode vir outra hashtag. É a regra da campanha ("nunca no meio do
 * texto") e também o que deixa o corpo contável em palavras.
 */
export function analisarLegenda(
	textoBruto: string,
	regras: RegrasLegenda,
): LegendaAnalisada {
	const texto = textoBruto.replace(/\r\n/g, "\n").trim();
	const problemas: Problema[] = [];
	const hashtags = texto.match(HASHTAG) ?? [];
	const primeira = hashtags[0] !== undefined ? texto.indexOf(hashtags[0]) : -1;
	const corpo = (primeira >= 0 ? texto.slice(0, primeira) : texto).trim();
	const cauda = primeira >= 0 ? texto.slice(primeira) : "";

	if (cauda.replace(HASHTAG, "").trim().length > 0) {
		problemas.push({
			regra: "hashtags-no-fim",
			detalhe: "depois da primeira hashtag só podem vir hashtags",
		});
	}

	const palavras = corpo
		.split(/\s+/)
		.filter((p) => /[\p{L}\p{N}]/u.test(p)).length;
	if (palavras > regras.maxPalavras) {
		problemas.push({
			regra: "max-palavras",
			detalhe: `${palavras} palavras; o máximo é ${regras.maxPalavras}`,
		});
	}
	if (regras.maxCaracteres && texto.length > regras.maxCaracteres) {
		problemas.push({
			regra: "max-caracteres",
			detalhe: `${texto.length} caracteres; o máximo é ${regras.maxCaracteres}`,
		});
	}

	const emojis = (texto.match(EMOJI) ?? []).length;
	if (emojis > regras.maxEmojis) {
		problemas.push({
			regra: "max-emojis",
			detalhe: `${emojis} emojis; o máximo é ${regras.maxEmojis}`,
		});
	}

	const normalizadas = hashtags.map((h) => h.toLowerCase());
	if (
		hashtags.length < regras.hashtags.min ||
		hashtags.length > regras.hashtags.max
	) {
		problemas.push({
			regra: "quantidade-hashtags",
			detalhe: `${hashtags.length} hashtags; o permitido é de ${regras.hashtags.min} a ${regras.hashtags.max}`,
		});
	}
	const repetidas = normalizadas.filter(
		(h, i) => normalizadas.indexOf(h) !== i,
	);
	if (repetidas.length) {
		problemas.push({
			regra: "hashtag-repetida",
			detalhe: [...new Set(repetidas)].join(" "),
		});
	}
	const comAcento = hashtags.filter((h) => semAcento(h) !== h.toLowerCase());
	if (comAcento.length) {
		problemas.push({
			regra: "hashtag-com-acento",
			detalhe: `${comAcento.join(" ")}: escreva sem acento`,
		});
	}
	for (const obrigatoria of regras.hashtags.obrigatorias ?? []) {
		if (!normalizadas.includes(obrigatoria.toLowerCase())) {
			problemas.push({
				regra: "hashtag-obrigatoria",
				detalhe: `falta ${obrigatoria}`,
			});
		}
	}
	const proibidas = (regras.hashtags.proibidas ?? []).map((h) => semAcento(h));
	const usadasProibidas = hashtags.filter((h) =>
		proibidas.includes(semAcento(h)),
	);
	if (usadasProibidas.length) {
		problemas.push({
			regra: "hashtag-proibida",
			detalhe: usadasProibidas.join(" "),
		});
	}
	if (regras.hashtags.permitidas) {
		const aceitas = new Set(
			[
				...regras.hashtags.permitidas,
				...(regras.hashtags.obrigatorias ?? []),
			].map((h) => h.toLowerCase()),
		);
		const fora = hashtags.filter((h) => !aceitas.has(h.toLowerCase()));
		if (fora.length) {
			problemas.push({
				regra: "hashtag-fora-da-lista",
				detalhe: `${fora.join(" ")} não está na lista do projeto`,
			});
		}
	}

	const semAcentoTexto = semAcento(texto);
	for (const termo of regras.termosProibidos ?? []) {
		const alvo = semAcento(termo);
		// Termos curtos ("RAW", "4K") só contam como palavra inteira: "rawson" não é "RAW".
		const encontrado = /^[\p{L}\p{N}]+$/u.test(alvo)
			? new RegExp(`(^|[^\\p{L}\\p{N}])${alvo}([^\\p{L}\\p{N}]|$)`, "u").test(
					semAcentoTexto,
				)
			: semAcentoTexto.includes(alvo);
		if (encontrado) {
			problemas.push({ regra: "termo-proibido", detalhe: `"${termo}"` });
		}
	}

	let cta: string | undefined;
	if (regras.ctas?.length) {
		const corpoSemAcento = semAcento(corpo);
		const usados = regras.ctas.filter((c) =>
			corpoSemAcento.includes(semAcento(c)),
		);
		if (usados.length !== 1) {
			problemas.push({
				regra: "um-cta",
				detalhe: usados.length
					? `há ${usados.length} CTAs (${usados.join(", ")}); use um só`
					: `falta o CTA; use um de: ${regras.ctas.join(" | ")}`,
			});
		} else {
			cta = usados[0];
		}
	}

	if (regras.link && !texto.includes(regras.link)) {
		problemas.push({ regra: "link", detalhe: `falta o link ${regras.link}…` });
	}

	return { texto, corpo, palavras, emojis, hashtags, cta, problemas };
}

// ---------------------------------------------------------------------------------------------
// Teto de publicações por projeto

export const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Se uma publicação no instante `alvo` mantém toda janela de 24h com no máximo `limite`
 * publicações do projeto. Olhar só as 24h anteriores não basta: três posts já agendados para
 * amanhã de manhã também ficam na mesma janela de um post publicado hoje à noite.
 *
 * A maior contagem de uma janela que contém `alvo` acontece numa janela que começa num dos
 * eventos (ou no próprio alvo), então basta testar esses começos.
 */
export function cabeNaJanela(alvo: number, ocupados: number[], limite: number) {
	const eventos = [
		...ocupados.filter((t) => Math.abs(t - alvo) < DIA_MS),
		alvo,
	].sort((a, b) => a - b);
	let pior = 0;
	for (const inicio of eventos) {
		if (inicio > alvo || inicio <= alvo - DIA_MS) continue;
		const n = eventos.filter((t) => t >= inicio && t < inicio + DIA_MS).length;
		pior = Math.max(pior, n);
	}
	return { cabe: pior <= limite, contagem: pior - 1 };
}

/** Mesmo horário, um dia depois, quantas vezes for preciso até caber. */
export function proximoDiaLivre(
	alvo: number,
	ocupados: number[],
	limite: number,
	maxDias = 30,
) {
	for (let d = 1; d <= maxDias; d++) {
		const candidato = alvo + d * DIA_MS;
		if (cabeNaJanela(candidato, ocupados, limite).cabe) return candidato;
	}
	return undefined;
}

// ---------------------------------------------------------------------------------------------
// Estados do rascunho

/** Para onde cada decisão do usuário leva um rascunho que aguarda aprovação. */
export function aplicarDecisao(estado: Estado, decisao: Decisao): Estado {
	if (estado !== "aguardando_aprovacao") {
		throw new Error(
			`só um rascunho aguardando aprovação recebe decisão; este está em "${estado}"`,
		);
	}
	return decisao === "aprovar"
		? "aprovado"
		: decisao === "ajuste"
			? "ajuste"
			: "descartado";
}

/** Lê o texto de uma resposta de card, por número ou pelo rótulo do botão. */
export function lerDecisao(resposta: string): Decisao | undefined {
	const r = semAcento(resposta.trim());
	if (r === "1" || r.startsWith("aprov")) return "aprovar";
	if (r === "2" || r.startsWith("pedir ajuste") || r.startsWith("ajuste"))
		return "ajuste";
	if (r === "3" || r.startsWith("descart")) return "descartar";
	return undefined;
}

/** Instante "AAAA-MM-DDTHH:MM" no fuso do projeto (só os de offset fixo, como o de Brasília). */
export function instanteLocal(dataHora: string, offset: string) {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dataHora)) {
		throw new Error(`"${dataHora}" deve ser AAAA-MM-DDTHH:MM`);
	}
	const t = Date.parse(`${dataHora}:00${offset}`);
	if (Number.isNaN(t)) throw new Error(`data inválida: ${dataHora}`);
	return t;
}

// ---------------------------------------------------------------------------------------------
// Calendário

const MESES = [
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

export type ItemDoCalendario = Record<string, string> & {
	/** Como está na tabela, por exemplo "qui 22/out". */
	dia: string;
	/** AAAA-MM-DD. */
	data: string;
	/** E02, quando a ideia começa com **E02:**. */
	codigo?: string;
};

/**
 * Linhas da tabela de calendário de um campaign.md, com a data já em AAAA-MM-DD e as colunas
 * pelo nome do cabeçalho em minúsculas (data, pilar, formato, ideia, cta…). Sem a seção de
 * calendário, devolve `undefined`.
 */
export function itensDoCalendario(
	campanha: string,
	ano: number,
): ItemDoCalendario[] | undefined {
	const linhasDaCampanha = campanha.split("\n");
	const inicio = linhasDaCampanha.findIndex((l) =>
		/^#{1,6}\s+(\d+\.\s*)?calend[áa]rio/i.test(l),
	);
	if (inicio < 0) return undefined;
	const linhas = linhasDaCampanha.slice(inicio + 1);
	const fim = linhas.findIndex((l) => /^#{1,2}\s/.test(l));
	const tabela = (fim < 0 ? linhas : linhas.slice(0, fim)).filter((l) =>
		l.startsWith("|"),
	);
	const cabecalho =
		tabela[0]
			?.split("|")
			.slice(1, -1)
			.map((c) => c.trim().toLowerCase()) ?? [];
	return tabela.slice(2).flatMap((linha) => {
		const celulas = linha
			.split("|")
			.slice(1, -1)
			.map((c) => c.trim());
		const registro: Record<string, string> = Object.fromEntries(
			cabecalho.map((c, i) => [c, celulas[i] ?? ""]),
		);
		const m = (registro.data ?? "").match(/(\d{1,2})\/([a-zç]{3})/i);
		const mes = m ? MESES.indexOf(m[2].toLowerCase()) : -1;
		if (!m || mes < 0) return [];
		const data = `${ano}-${String(mes + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
		const codigo = (registro.ideia ?? "").match(/\*\*(E\d+)/)?.[1];
		return [
			{ ...registro, dia: registro.data, data, ...(codigo ? { codigo } : {}) },
		];
	});
}
