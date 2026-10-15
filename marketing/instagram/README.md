# Instagram / Facebook marketing (fase 1)

Publicação no Instagram e na Página do Facebook via Composio (`sdk/packages/core/src/extensions/composio/`, atrás de `CLINE_COMPOSIO_BETA`). As chamadas passam pelo proxy de conectores da Cline API, então não há chave Composio local.

## Hospedagem de imagens

A API do Instagram recebe a imagem por `image_url`: a Meta baixa o arquivo, então ele precisa estar numa URL HTTPS pública. Usamos um bucket próprio no **Cloudflare R2**, o `cline-marketing-instagram`, com acesso público. Ele fica separado dos buckets de outros projetos.

| Opção | Custo para ~30–100 imagens/mês | Credenciais |
| --- | --- | --- |
| **Cloudflare R2** (escolhido) | Grátis até 10 GB armazenados, sem custo de egress | Reaproveita a conta Cloudflare; um token de API do R2 restrito a este bucket |
| Vercel Blob | Grátis no Hobby: 1 GB armazenado, 10 GB de transferência/mês | Um store novo e o token dele |

Uma imagem de post tem 0,5–2 MB, então 100 imagens/mês ficam bem abaixo do limite grátis.

O script usa o cliente S3 que já vem no Bun, então não há dependências para instalar.

### Variáveis de ambiente

| Variável | Descrição |
| --- | --- |
| `R2_ENDPOINT` ou `S3_API` | `https://<account-id>.r2.cloudflarestorage.com`. `S3_API` é o valor de **bucket → Settings → S3 API**, que já termina com `/<bucket>`. O script remove esse caminho e o usa como bucket quando `R2_BUCKET` não está definida. |
| `R2_ACCESS_KEY_ID` | Access Key ID de um token de API do R2 com escrita no bucket |
| `R2_SECRET_ACCESS_KEY` | Secret Access Key do mesmo token |
| `R2_BUCKET` | `cline-marketing-instagram` (opcional quando vem dentro de `S3_API`) |
| `R2_PUBLIC_BASE_URL` | URL pública do bucket, sem barra no final: `https://pub-<hash>.r2.dev` ou um domínio próprio |

Todas são obrigatórias, a não ser nos casos opcionais indicados. Quando falta alguma, o script lista cada uma e diz onde encontrá-la. Não commite os valores. Ponha num `marketing/instagram/.env`: o `.env` está no `.gitignore` e o Bun carrega o arquivo sozinho quando o comando roda nesta pasta.

### Configuração inicial (uma vez)

1. No painel da Cloudflare, abra **R2 → Create bucket** e crie o `cline-marketing-instagram`.
2. No bucket, vá em **Settings → Public Development URL → Enable** e copie a URL `https://pub-….r2.dev`. Ela é o `R2_PUBLIC_BASE_URL`. Se preferir um domínio próprio, use **Custom Domains**.
3. Se o token de API do R2 que você já tem for limitado a outros buckets, edite o token em **R2 → Manage API tokens** e inclua este bucket com **Object Read & Write**.

### Enviar uma imagem

```sh
cd marketing/instagram
bun run upload caminho/para/post.jpg --check
```

O script aceita `.png`, `.jpg` e `.jpeg` até 8 MB, que é o limite do Instagram. Ele envia o arquivo para `instagram/<prefixo aleatório>-<nome>.<ext>` e imprime só a URL pública no stdout, então dá para usar `URL=$(bun run upload post.jpg)`. Com `--check`, ele baixa a URL sem autenticação e falha se a resposta não vier com status 200 e `content-type` de imagem.

Atenção: para posts de feed, a Graph API do Instagram só aceita JPEG oficialmente. Prefira `.jpg`; PNG serve para a Página do Facebook.
