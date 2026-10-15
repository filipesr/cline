import { describe, expect, test } from "bun:test";
import {
	analisarLegenda,
	aplicarDecisao,
	cabeNaJanela,
	DIA_MS,
	instanteLocal,
	lerDecisao,
	proximoDiaLivre,
	type RegrasLegenda,
} from "./publicacao-regras";

const regras: RegrasLegenda = {
	maxPalavras: 20,
	maxEmojis: 1,
	hashtags: {
		min: 3,
		max: 5,
		obrigatorias: ["#partyshare"],
		permitidas: ["#rh", "#endomarketing", "#confraternizacao"],
		proibidas: ["#AFestaQueVocêNãoViu"],
	},
	termosProibidos: ["grátis", "RAW", "nenhuma foto se perde"],
	ctas: ["Solicitar proposta corporativa", "Agendar 20 minutos"],
};

const boa = `A confraternização acontece uma vez.

Solicitar proposta corporativa.

#partyshare #rh #endomarketing`;

const regrasDe = (problemas: { regra: string }[]) =>
	problemas.map((p) => p.regra);

describe("analisarLegenda", () => {
	test("aceita uma legenda dentro das regras", () => {
		const r = analisarLegenda(boa, regras);
		expect(r.problemas).toEqual([]);
		expect(r.cta).toBe("Solicitar proposta corporativa");
		expect(r.hashtags).toEqual(["#partyshare", "#rh", "#endomarketing"]);
		expect(r.palavras).toBe(8);
	});

	test("hashtag no meio do texto", () => {
		const r = analisarLegenda(
			"A #rh confraternização. Solicitar proposta corporativa. #partyshare #endomarketing",
			regras,
		);
		expect(regrasDe(r.problemas)).toContain("hashtags-no-fim");
	});

	test("conta palavras sem as hashtags", () => {
		const longa = `${"palavra ".repeat(21)}Solicitar proposta corporativa\n#partyshare #rh #endomarketing`;
		expect(regrasDe(analisarLegenda(longa, regras).problemas)).toContain(
			"max-palavras",
		);
	});

	test("hashtags: quantidade, obrigatória, acento, proibida e fora da lista", () => {
		const r = analisarLegenda(
			"Texto. Agendar 20 minutos.\n#confraternização #AFestaQueVocêNãoViu",
			regras,
		);
		expect(regrasDe(r.problemas)).toEqual(
			expect.arrayContaining([
				"quantidade-hashtags",
				"hashtag-obrigatoria",
				"hashtag-com-acento",
				"hashtag-proibida",
				"hashtag-fora-da-lista",
			]),
		);
	});

	test("termos proibidos ignoram acento e caixa; termo curto só como palavra", () => {
		const r = analisarLegenda(
			`Teste GRATIS com foto raw. Agendar 20 minutos.\n#partyshare #rh #endomarketing`,
			regras,
		);
		expect(
			r.problemas
				.filter((p) => p.regra === "termo-proibido")
				.map((p) => p.detalhe),
		).toEqual(['"grátis"', '"RAW"']);
		const semFalsoPositivo = analisarLegenda(
			`O Rawson chegou. Agendar 20 minutos.\n#partyshare #rh #endomarketing`,
			regras,
		);
		expect(regrasDe(semFalsoPositivo.problemas)).not.toContain(
			"termo-proibido",
		);
	});

	test("exatamente um CTA", () => {
		const nenhum = analisarLegenda(
			"Texto.\n#partyshare #rh #endomarketing",
			regras,
		);
		const dois = analisarLegenda(
			"Solicitar proposta corporativa ou Agendar 20 minutos.\n#partyshare #rh #endomarketing",
			regras,
		);
		expect(regrasDe(nenhum.problemas)).toContain("um-cta");
		expect(regrasDe(dois.problemas)).toContain("um-cta");
	});

	test("emojis acima do máximo", () => {
		const r = analisarLegenda(
			`🎉 Festa 📸. Agendar 20 minutos.\n#partyshare #rh #endomarketing`,
			regras,
		);
		expect(regrasDe(r.problemas)).toContain("max-emojis");
	});

	test("link obrigatório quando configurado", () => {
		const r = analisarLegenda(boa, {
			...regras,
			link: "https://www.partyshare.me/business",
		});
		expect(regrasDe(r.problemas)).toContain("link");
	});
});

describe("cabeNaJanela", () => {
	const t = Date.parse("2026-10-22T20:00:00-03:00");
	const h = 60 * 60 * 1000;

	test("cabe com duas publicações nas últimas 24h", () => {
		expect(cabeNaJanela(t, [t - 2 * h, t - 5 * h], 3)).toEqual({
			cabe: true,
			contagem: 2,
		});
	});

	test("recusa a quarta nas últimas 24h", () => {
		expect(cabeNaJanela(t, [t - 1 * h, t - 2 * h, t - 23 * h], 3).cabe).toBe(
			false,
		);
	});

	test("ignora o que saiu da janela", () => {
		expect(cabeNaJanela(t, [t - 24 * h, t - 25 * h, t - 30 * h], 3).cabe).toBe(
			true,
		);
	});

	test("conta agendados à frente na mesma janela", () => {
		expect(cabeNaJanela(t, [t + 10 * h, t + 11 * h, t + 12 * h], 3).cabe).toBe(
			false,
		);
		expect(cabeNaJanela(t, [t - 20 * h, t + 10 * h, t + 11 * h], 3).cabe).toBe(
			true,
		);
	});

	test("empurra para o dia seguinte, e mais um se for preciso", () => {
		const cheio = [t - 1 * h, t - 2 * h, t - 3 * h];
		expect(proximoDiaLivre(t, cheio, 3)).toBe(t + DIA_MS);
		const amanhaCheio = [
			...cheio,
			t + DIA_MS - h,
			t + DIA_MS - 2 * h,
			t + DIA_MS + h,
		];
		expect(proximoDiaLivre(t, amanhaCheio, 3)).toBe(t + 2 * DIA_MS);
	});
});

describe("decisões", () => {
	test("cada decisão leva ao seu estado", () => {
		expect(aplicarDecisao("aguardando_aprovacao", "aprovar")).toBe("aprovado");
		expect(aplicarDecisao("aguardando_aprovacao", "ajuste")).toBe("ajuste");
		expect(aplicarDecisao("aguardando_aprovacao", "descartar")).toBe(
			"descartado",
		);
	});

	test("só um rascunho aguardando aprovação recebe decisão", () => {
		expect(() => aplicarDecisao("rascunho", "aprovar")).toThrow();
		expect(() => aplicarDecisao("publicado", "descartar")).toThrow();
	});

	test("lê a resposta do card por número ou rótulo", () => {
		expect(lerDecisao("1")).toBe("aprovar");
		expect(lerDecisao("Aprovar")).toBe("aprovar");
		expect(lerDecisao("Pedir ajuste")).toBe("ajuste");
		expect(lerDecisao("3")).toBe("descartar");
		expect(lerDecisao("talvez")).toBeUndefined();
	});

	test("instanteLocal usa o fuso do projeto", () => {
		expect(instanteLocal("2026-10-22T20:00", "-03:00")).toBe(
			Date.parse("2026-10-22T23:00:00Z"),
		);
		expect(() => instanteLocal("22/10 20h", "-03:00")).toThrow();
	});
});
