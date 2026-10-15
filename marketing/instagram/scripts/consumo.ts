#!/usr/bin/env bun
/**
 * Consumo do Composio: soma as chamadas que cada job registrou, projeta o mês e compara com o
 * plano gratuito. É daqui que sai a linha de consumo do relatório semanal e o aviso de 70%.
 *
 *   bun scripts/consumo.ts            # resumo do mês: total, projeção, por fluxo, projeto e ação
 *   bun scripts/consumo.ts --linha    # uma linha, para o relatório semanal
 *   bun scripts/consumo.ts --aviso    # a mesma linha; sai com 2 quando a projeção passa do aviso
 *   bun scripts/consumo.ts --json
 *
 * O que cada job registra:
 * - métricas (metrics.ts): `runs[].composioCalls` em metrics/<projeto>/<AAAA-MM-DD>.json;
 * - publicação (publicacao.ts): uma linha por comando que chamou o Composio em
 *   projects/<projeto>/composio-chamadas.jsonl.
 *
 * A cota é a da nossa conta na área de consumidor do Composio (chave ck_), não a da Cline: os
 * scripts não passam pelo proxy de conectores da Cline API (ver composio.md).
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Composio } from "./composio";
import { localDate, parseUtcOffset } from "./metrics";

/** Plano Hobby (gratuito), conferido em composio.dev/pricing em 15/10/2026. */
export const PLANO_GRATUITO = {
	chamadas: 100_000,
	triggers: 50_000,
	conferidoEm: "2026-10-15",
};
export const AVISO_PADRAO = 70;
export const ARQUIVO_PUBLICACAO = "composio-chamadas.jsonl";

/** O mesmo formato de `runs[].composioCalls` das métricas. */
export type Contagem = {
	total: number;
	failed: number;
	bySlug: Record<string, number>;
	/** Meta tools (COMPOSIO_MANAGE_CONNECTIONS…): o Composio não as cobra, então ficam fora de `total`. */
	metaTools?: Record<string, number>;
};

export function novaContagem(): Contagem {
	return { total: 0, failed: 0, bySlug: {}, metaTools: {} };
}

/** Conta cada ação executada, falhas incluídas, porque o Composio as cobra também. */
export function contarChamadas(
	cliente: Composio,
	contagem: Contagem,
): Composio {
	return {
		async conexoes(toolkits) {
			const meta = contagem.metaTools ?? {};
			meta.COMPOSIO_MANAGE_CONNECTIONS =
				(meta.COMPOSIO_MANAGE_CONNECTIONS ?? 0) + 1;
			contagem.metaTools = meta;
			return cliente.conexoes(toolkits);
		},
		async executar(slug, argumentos, conta) {
			contagem.total++;
			contagem.bySlug[slug] = (contagem.bySlug[slug] ?? 0) + 1;
			try {
				return await cliente.executar(slug, argumentos, conta);
			} catch (erro) {
				contagem.failed++;
				throw erro;
			}
		},
	};
}

export type RegistroPublicacao = {
	em: string;
	comando: string;
	post?: string;
	composioCalls: Contagem;
};

export function registrarPublicacao(
	pastaProjeto: string,
	registro: RegistroPublicacao,
) {
	appendFileSync(
		join(pastaProjeto, ARQUIVO_PUBLICACAO),
		`${JSON.stringify(registro)}\n`,
	);
}

// ---------------------------------------------------------------------------------------------
// Leitura

export type Fluxo = "publicacao" | "metricas";

export type Registro = {
	em: string;
	fluxo: Fluxo;
	projeto: string;
	chamadas: number;
	falhas: number;
	porSlug: Record<string, number>;
};

function jsonDe(caminho: string): unknown {
	try {
		return JSON.parse(readFileSync(caminho, "utf8"));
	} catch {
		return undefined;
	}
}

function pastas(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name);
}

function registroDe(
	em: unknown,
	fluxo: Fluxo,
	projeto: string,
	calls: Contagem | undefined,
): Registro | undefined {
	if (typeof em !== "string" || Number.isNaN(Date.parse(em)) || !calls)
		return undefined;
	return {
		em,
		fluxo,
		projeto,
		chamadas: Number(calls.total) || 0,
		falhas: Number(calls.failed) || 0,
		porSlug: calls.bySlug ?? {},
	};
}

/** Tudo o que os jobs registraram, de todos os projetos. */
export function lerRegistros(dirs: {
	projetos: string;
	metricas: string;
}): Registro[] {
	const registros: Registro[] = [];
	for (const projeto of pastas(dirs.metricas)) {
		const pasta = join(dirs.metricas, projeto);
		for (const arquivo of readdirSync(pasta)) {
			if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(arquivo)) continue;
			const dia = jsonDe(join(pasta, arquivo)) as
				| { runs?: { startedAt?: string; composioCalls?: Contagem }[] }
				| undefined;
			for (const run of dia?.runs ?? []) {
				const r = registroDe(
					run.startedAt,
					"metricas",
					projeto,
					run.composioCalls,
				);
				if (r) registros.push(r);
			}
		}
	}
	for (const projeto of pastas(dirs.projetos)) {
		const arquivo = join(dirs.projetos, projeto, ARQUIVO_PUBLICACAO);
		if (!existsSync(arquivo)) continue;
		for (const linha of readFileSync(arquivo, "utf8").split("\n")) {
			if (!linha.trim()) continue;
			let item: RegistroPublicacao | undefined;
			try {
				item = JSON.parse(linha);
			} catch {
				continue;
			}
			const r = registroDe(
				item?.em,
				"publicacao",
				projeto,
				item?.composioCalls,
			);
			if (r) registros.push(r);
		}
	}
	return registros.sort((a, b) => a.em.localeCompare(b.em));
}

// ---------------------------------------------------------------------------------------------
// Projeção

const DIA = 86_400_000;

export type Projecao = {
	mes: string;
	ate: string;
	limite: number;
	avisoPct: number;
	/** Chamadas registradas no mês, até agora. */
	noMes: number;
	falhasNoMes: number;
	porFluxo: Record<Fluxo, number>;
	porProjeto: Record<string, number>;
	porSlug: Record<string, number>;
	/** Média diária usada na projeção: os últimos 7 dias, ou desde o primeiro registro. */
	porDia: number;
	diasDaMedia: number;
	projecao: number;
	pct: number;
	acimaDoAviso: boolean;
	semRegistros: boolean;
	/** O Composio não tem triggers para Instagram nem Facebook, então nenhum job gera eventos. */
	triggers: number;
};

function somar(alvo: Record<string, number>, chave: string, valor: number) {
	alvo[chave] = (alvo[chave] ?? 0) + valor;
}

/**
 * Projeção do mês corrente: o que já foi registrado no mês, mais a média diária dos últimos 7
 * dias vezes o que falta do mês. Com menos de 7 dias de histórico, a média é desde o primeiro
 * registro (e no mínimo um dia), o que pesa para cima logo depois de um job novo começar.
 */
export function projetar(
	registros: Registro[],
	opcoes: {
		agora: Date;
		offsetMin: number;
		limite?: number;
		avisoPct?: number;
	},
): Projecao {
	const { agora, offsetMin } = opcoes;
	const limite = opcoes.limite ?? PLANO_GRATUITO.chamadas;
	const avisoPct = opcoes.avisoPct ?? AVISO_PADRAO;
	const hoje = localDate(agora, offsetMin);
	const mes = hoje.slice(0, 7);
	const [ano, m] = mes.split("-").map(Number);
	// Fim do mês local: meia-noite do dia 1 do mês seguinte, no offset do projeto.
	const fimDoMes = Date.UTC(ano, m, 1) - offsetMin * 60_000;
	const t = agora.getTime();
	const passados = registros.filter((r) => Date.parse(r.em) <= t);

	const porFluxo: Record<Fluxo, number> = { publicacao: 0, metricas: 0 };
	const porProjeto: Record<string, number> = {};
	const porSlug: Record<string, number> = {};
	let noMes = 0;
	let falhasNoMes = 0;
	for (const r of passados) {
		if (localDate(new Date(r.em), offsetMin).slice(0, 7) !== mes) continue;
		noMes += r.chamadas;
		falhasNoMes += r.falhas;
		porFluxo[r.fluxo] += r.chamadas;
		somar(porProjeto, r.projeto, r.chamadas);
		for (const [slug, n] of Object.entries(r.porSlug)) somar(porSlug, slug, n);
	}

	const primeiro = passados.length ? Date.parse(passados[0].em) : t;
	const inicioDaMedia = Math.max(t - 7 * DIA, primeiro);
	const diasDaMedia = Math.max(1, (t - inicioDaMedia) / DIA);
	const naJanela = passados
		.filter((r) => Date.parse(r.em) >= inicioDaMedia)
		.reduce((s, r) => s + r.chamadas, 0);
	const porDia = naJanela / diasDaMedia;
	const projecao = Math.round(
		noMes + porDia * Math.max(0, (fimDoMes - t) / DIA),
	);
	const pct = (projecao / limite) * 100;
	return {
		mes,
		ate: hoje,
		limite,
		avisoPct,
		noMes,
		falhasNoMes,
		porFluxo,
		porProjeto,
		porSlug,
		porDia,
		diasDaMedia,
		projecao,
		pct,
		acimaDoAviso: pct > avisoPct,
		semRegistros: passados.length === 0,
		triggers: 0,
	};
}

// ---------------------------------------------------------------------------------------------
// Saída

const MESES = "jan fev mar abr mai jun jul ago set out nov dez".split(" ");
const inteiro = (n: number) => Math.round(n).toLocaleString("pt-BR");
const porcento = (n: number) =>
	`${n.toLocaleString("pt-BR", { maximumFractionDigits: n < 10 ? 1 : 0 })}%`;
const mil = (n: number) => (n % 1000 === 0 ? `${n / 1000} mil` : inteiro(n));

/** A linha do relatório semanal (e do aviso). */
export function linhaDeConsumo(p: Projecao): string {
	const [ano, m] = p.mes.split("-");
	const quando = `${MESES[Number(m) - 1]}/${ano}`;
	const dia = `${p.ate.slice(8, 10)}/${p.ate.slice(5, 7)}`;
	if (p.semRegistros) {
		return `Composio ${quando}: nenhum job registrou chamadas ainda · plano gratuito ${mil(p.limite)} chamadas/mês`;
	}
	const corpo =
		`Composio ${quando}: ${inteiro(p.noMes)} chamadas até ${dia} ` +
		`(publicação ${inteiro(p.porFluxo.publicacao)} · métricas ${inteiro(p.porFluxo.metricas)}) · ` +
		`projeção ${inteiro(p.projecao)} no mês = ${porcento(p.pct)} do gratuito (${mil(p.limite)}) · ` +
		`triggers ${p.triggers}`;
	return p.acimaDoAviso
		? `⚠️ Composio acima de ${p.avisoPct}% do gratuito. ${corpo}. Decisão do projeto: passar para o conector nativo da Meta.`
		: corpo;
}

function resumo(p: Projecao): string {
	const linhas = [linhaDeConsumo(p), ""];
	linhas.push(
		`Média usada: ${p.porDia.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} chamadas/dia em ${p.diasDaMedia.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} dia(s)`,
	);
	linhas.push(`Falhas no mês (contam na cota): ${inteiro(p.falhasNoMes)}`);
	linhas.push(
		`Aviso em ${p.avisoPct}% = ${inteiro((p.limite * p.avisoPct) / 100)} chamadas/mês`,
	);
	const tabela = (titulo: string, valores: Record<string, number>) => {
		const itens = Object.entries(valores)
			.filter(([, n]) => n > 0)
			.sort((a, b) => b[1] - a[1]);
		if (!itens.length) return;
		linhas.push("", titulo);
		for (const [k, n] of itens)
			linhas.push(`  ${inteiro(n).padStart(7)}  ${k}`);
	};
	tabela("Por projeto:", p.porProjeto);
	tabela("Por ação:", p.porSlug);
	return linhas.join("\n");
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			linha: { type: "boolean", default: false },
			aviso: { type: "boolean", default: false },
			json: { type: "boolean", default: false },
		},
	});
	const base = resolve(import.meta.dir, "..");
	const ler = (nome: string) => process.env[nome]?.trim() || undefined;
	const projecao = projetar(
		lerRegistros({
			projetos: join(base, "projects"),
			metricas: resolve(base, ler("METRICS_DIR") ?? "metrics"),
		}),
		{
			agora: ler("CONSUMO_AGORA")
				? new Date(ler("CONSUMO_AGORA") as string)
				: new Date(),
			offsetMin: parseUtcOffset(ler("METRICS_UTC_OFFSET") ?? "-03:00"),
			limite: Number(
				ler("COMPOSIO_GRATIS_CHAMADAS") ?? PLANO_GRATUITO.chamadas,
			),
			avisoPct: Number(ler("CONSUMO_AVISO_PCT") ?? AVISO_PADRAO),
		},
	);
	if (values.json) console.log(JSON.stringify(projecao, null, "\t"));
	else if (values.linha || values.aviso) console.log(linhaDeConsumo(projecao));
	else console.log(resumo(projecao));
	if (values.aviso && projecao.acimaDoAviso) process.exit(2);
}
