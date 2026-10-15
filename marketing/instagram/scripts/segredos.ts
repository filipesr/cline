/**
 * Carrega as chaves de um arquivo fora do repositório, para que sobrevivam ao fim de cada card:
 * um worktree do Kanban é apagado quando o card termina, e o .env dele vai junto.
 *
 * Arquivo: $INSTAGRAM_ENV_FILE, ou ~/.config/cline-marketing/instagram.env. Linhas NOME=valor;
 * linhas vazias e as que começam com # são ignoradas, aspas em volta do valor são retiradas.
 * Uma variável que já está no ambiente (ou num .env carregado pelo Bun) não é sobrescrita.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ARQUIVO_PADRAO = join(
	homedir(),
	".config",
	"cline-marketing",
	"instagram.env",
);

export function arquivoDeSegredos(
	env: NodeJS.ProcessEnv = process.env,
): string {
	return env.INSTAGRAM_ENV_FILE?.trim() || ARQUIVO_PADRAO;
}

export function lerSegredos(texto: string): Record<string, string> {
	const valores: Record<string, string> = {};
	for (const linha of texto.split(/\r?\n/)) {
		const limpa = linha.trim();
		if (!limpa || limpa.startsWith("#")) continue;
		const igual = limpa.indexOf("=");
		if (igual <= 0) continue;
		const nome = limpa
			.slice(0, igual)
			.replace(/^export\s+/, "")
			.trim();
		let valor = limpa.slice(igual + 1).trim();
		if (/^(["']).*\1$/.test(valor)) valor = valor.slice(1, -1);
		if (valor) valores[nome] = valor;
	}
	return valores;
}

export function carregarSegredos(env: NodeJS.ProcessEnv = process.env): void {
	const arquivo = arquivoDeSegredos(env);
	if (!existsSync(arquivo)) return;
	for (const [nome, valor] of Object.entries(
		lerSegredos(readFileSync(arquivo, "utf8")),
	)) {
		if (!env[nome]?.trim()) env[nome] = valor;
	}
}
