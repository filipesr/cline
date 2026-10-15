import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ARQUIVO_PADRAO,
	arquivoDeSegredos,
	carregarSegredos,
	lerSegredos,
} from "./segredos";

describe("lerSegredos", () => {
	test("lê NOME=valor, ignora comentários, linhas vazias e valores em branco", () => {
		const texto = [
			"# R2",
			"R2_BUCKET=cline-marketing-instagram",
			"",
			'export R2_PUBLIC_BASE_URL="https://pub-x.r2.dev"',
			"COMPOSIO_CONSUMER_API_KEY='ck_a=b'",
			"R2_SECRET_ACCESS_KEY=",
			"sem igual",
		].join("\n");
		expect(lerSegredos(texto)).toEqual({
			R2_BUCKET: "cline-marketing-instagram",
			R2_PUBLIC_BASE_URL: "https://pub-x.r2.dev",
			COMPOSIO_CONSUMER_API_KEY: "ck_a=b",
		});
	});
});

describe("carregarSegredos", () => {
	test("preenche só o que falta no ambiente", () => {
		const arquivo = join(
			mkdtempSync(join(tmpdir(), "segredos-")),
			"instagram.env",
		);
		writeFileSync(
			arquivo,
			"R2_BUCKET=do-arquivo\nR2_ACCESS_KEY_ID=do-arquivo\n",
		);
		const env: NodeJS.ProcessEnv = {
			INSTAGRAM_ENV_FILE: arquivo,
			R2_BUCKET: "do-ambiente",
		};
		carregarSegredos(env);
		expect(env.R2_BUCKET).toBe("do-ambiente");
		expect(env.R2_ACCESS_KEY_ID).toBe("do-arquivo");
	});

	test("sem arquivo, não faz nada", () => {
		const env: NodeJS.ProcessEnv = {
			INSTAGRAM_ENV_FILE: join(tmpdir(), "nao-existe-segredos.env"),
		};
		carregarSegredos(env);
		expect(Object.keys(env)).toEqual(["INSTAGRAM_ENV_FILE"]);
	});

	test("o arquivo padrão fica fora do repositório", () => {
		expect(arquivoDeSegredos({})).toBe(ARQUIVO_PADRAO);
		expect(ARQUIVO_PADRAO).toEndWith(
			join(".config", "cline-marketing", "instagram.env"),
		);
	});
});
