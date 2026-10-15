import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Composio } from "./composio";
import {
	ARQUIVO_PUBLICACAO,
	contarChamadas,
	lerRegistros,
	linhaDeConsumo,
	novaContagem,
	projetar,
	type Registro,
} from "./consumo";

const SP = -180;
let temporarias: string[] = [];
afterEach(() => {
	for (const d of temporarias) rmSync(d, { recursive: true, force: true });
	temporarias = [];
});

function registro(
	em: string,
	chamadas: number,
	fluxo: Registro["fluxo"] = "metricas",
): Registro {
	return {
		em,
		fluxo,
		projeto: "partyshare",
		chamadas,
		falhas: 0,
		porSlug: { X: chamadas },
	};
}

describe("contarChamadas", () => {
	test("conta cada ação, falhas incluídas, e as meta tools à parte", async () => {
		const falso: Composio = {
			conexoes: async () => ({}),
			executar: async (slug) => {
				if (slug === "RUIM") throw new Error("falhou");
				return {};
			},
		};
		const contagem = novaContagem();
		const c = contarChamadas(falso, contagem);
		await c.conexoes(["facebook"]);
		await c.executar("FACEBOOK_GET_POST", {});
		await c.executar("FACEBOOK_GET_POST", {});
		await c.executar("RUIM", {}).catch(() => {});
		expect(contagem).toEqual({
			total: 3,
			failed: 1,
			bySlug: { FACEBOOK_GET_POST: 2, RUIM: 1 },
			metaTools: { COMPOSIO_MANAGE_CONNECTIONS: 1 },
		});
	});
});

describe("lerRegistros", () => {
	test("soma as execuções das métricas e as linhas da publicação, de cada projeto", () => {
		const raiz = mkdtempSync(join(tmpdir(), "consumo-"));
		temporarias.push(raiz);
		mkdirSync(join(raiz, "metrics", "partyshare"), { recursive: true });
		mkdirSync(join(raiz, "projects", "partyshare"), { recursive: true });
		writeFileSync(
			join(raiz, "metrics", "partyshare", "2026-10-14.json"),
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
		writeFileSync(join(raiz, "metrics", "partyshare", "notas.json"), "{}");
		writeFileSync(
			join(raiz, "projects", "partyshare", ARQUIVO_PUBLICACAO),
			`${JSON.stringify({ em: "2026-10-15T18:00:00Z", comando: "publicar", post: "2026-10-15-x", composioCalls: { total: 6, failed: 0, bySlug: { FACEBOOK_CREATE_PHOTO_POST: 1 } } })}\nlinha quebrada\n`,
		);
		const registros = lerRegistros({
			projetos: join(raiz, "projects"),
			metricas: join(raiz, "metrics"),
		});
		expect(registros.map((r) => [r.fluxo, r.chamadas, r.falhas])).toEqual([
			["metricas", 4, 1],
			["metricas", 2, 0],
			["publicacao", 6, 0],
		]);
	});

	test("sem pastas, nenhum registro", () => {
		expect(
			lerRegistros({ projetos: "/nao/existe", metricas: "/nao/existe" }),
		).toEqual([]);
	});
});

describe("projetar", () => {
	test("o mês até agora mais a média dos últimos 7 dias vezes o que falta", () => {
		// 10 chamadas por dia, às 10h de São Paulo, de 1 a 15/out; agora é 15/out 12h.
		const registros = Array.from({ length: 15 }, (_, i) =>
			registro(`2026-10-${String(i + 1).padStart(2, "0")}T13:00:00Z`, 10),
		);
		const p = projetar(registros, {
			agora: new Date("2026-10-15T15:00:00Z"),
			offsetMin: SP,
		});
		expect(p.mes).toBe("2026-10");
		expect(p.noMes).toBe(150);
		// 7 dias de janela pegam 7 runs (9 a 15/out): 70/7 = 10 por dia; faltam 16,5 dias.
		expect(p.porDia).toBeCloseTo(10, 5);
		expect(p.projecao).toBe(150 + 165);
		expect(p.acimaDoAviso).toBe(false);
	});

	test("o mês segue o fuso: 1h UTC do dia 1 ainda é o mês anterior em São Paulo", () => {
		const p = projetar([registro("2026-11-01T01:00:00Z", 50)], {
			agora: new Date("2026-11-01T02:00:00Z"),
			offsetMin: SP,
		});
		expect(p.mes).toBe("2026-10");
		expect(p.noMes).toBe(50);
	});

	test("com menos de 7 dias de histórico, a média é desde o primeiro registro (mínimo 1 dia)", () => {
		const p = projetar([registro("2026-10-15T13:00:00Z", 100)], {
			agora: new Date("2026-10-15T15:00:00Z"),
			offsetMin: SP,
		});
		expect(p.diasDaMedia).toBe(1);
		expect(p.porDia).toBe(100);
	});

	test("passa do aviso acima de 70% do gratuito, e a linha diz o que fazer", () => {
		const p = projetar([registro("2026-10-02T13:00:00Z", 75_000)], {
			agora: new Date("2026-10-31T12:00:00Z"),
			offsetMin: SP,
		});
		expect(p.acimaDoAviso).toBe(true);
		expect(linhaDeConsumo(p)).toStartWith(
			"⚠️ Composio acima de 70% do gratuito.",
		);
		expect(linhaDeConsumo(p)).toContain("conector nativo da Meta");
	});

	test("a linha separa publicação e métricas e mostra a porcentagem", () => {
		const p = projetar(
			[
				registro("2026-10-14T13:00:00Z", 120),
				registro("2026-10-15T13:00:00Z", 6, "publicacao"),
			],
			{ agora: new Date("2026-10-15T15:00:00Z"), offsetMin: SP },
		);
		const linha = linhaDeConsumo(p);
		expect(linha).toStartWith(
			"Composio out/2026: 126 chamadas até 15/10 (publicação 6 · métricas 120)",
		);
		expect(linha).toContain("do gratuito (100 mil) · triggers 0");
	});

	test("sem registros, a linha diz isso em vez de projetar zero", () => {
		const p = projetar([], {
			agora: new Date("2026-10-15T15:00:00Z"),
			offsetMin: SP,
		});
		expect(p.semRegistros).toBe(true);
		expect(linhaDeConsumo(p)).toBe(
			"Composio out/2026: nenhum job registrou chamadas ainda · plano gratuito 100 mil chamadas/mês",
		);
	});
});
