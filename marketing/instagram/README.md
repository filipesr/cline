# Instagram e Facebook (fase 1)

Os posts saem do calendário de um projeto e vão ao Instagram e à Página do Facebook pelo Composio, depois de aprovados pelo Telegram.

Tudo é **por projeto**. Cada `projects/<projeto>/` tem os seus próprios arquivos, e nada de um projeto vale para outro:

- `campaign.md`: campanha, persona, tom e calendário
- `publicacao.json`: contas, teto diário e regras de legenda
- `posts/`: o histórico de posts

Os scripts recusam uma pasta de post que não esteja dentro do projeto informado.

## Fluxo de publicação

```
calendário do projeto ──► rascunho ──► legenda ──► hospedar ──► pergunta no card (Telegram)
                            ▲                                        │
                            └──────────── Pedir ajuste ◄─────────────┤
                                                                     ├─ Descartar → arquivado
                                                                     └─ Aprovar ─► teto do projeto (3/24h)
                                                                                  ─► content_publishing_limit
                                                                                  ─► containers + publish (IG)
                                                                                  ─► Página do Facebook
                                                                                  ─► media id + permalink no post.json
```

O estado de cada post fica em `post.json → publicacao.estado`:

| Estado | Como se chega | O que vem depois |
|---|---|---|
| `rascunho` | `rascunho`, ou `refazer` depois de um ajuste | `legenda`, `hospedar`, `pergunta` |
| `aguardando_aprovacao` | `pergunta` | `decisao` |
| `ajuste` | `decisao "Pedir ajuste" --comentario` | `refazer` |
| `aprovado` | `decisao Aprovar` | `publicar` |
| `agendado` | `publicar --empurrar`, com o teto atingido | `publicar` de novo no horário marcado |
| `publicado` | `publicar` | `remover` (só no post de teste) |
| `descartado` | `decisao Descartar` | — |
| `removido` | `remover` | — |

`publicar` só aceita um post `aprovado` ou `agendado` cuja rodada atual tenha um "Aprovar" registrado. Um rascunho nunca vai ao ar sem passar pela pergunta.

### Comandos

Rode tudo de `marketing/instagram/`. As chaves vêm de `~/.config/cline-marketing/instagram.env` (ver [Onde ficam as chaves](#onde-ficam-as-chaves)).

```sh
bun scripts/publicacao.ts conexao    <projeto> [--salvar]        # contas do Composio, @, Página, limite da Meta
bun scripts/publicacao.ts calendario <projeto> [--data AAAA-MM-DD]
bun scripts/publicacao.ts rascunho   <projeto> <pedido.json>     # gera as imagens pelo motor do projeto
bun scripts/publicacao.ts legenda    <projeto> <pasta-do-post>   # confere legenda.txt (e legenda-facebook.txt)
bun scripts/publicacao.ts hospedar   <projeto> <pasta-do-post>   # envia final/*.jpg e guarda as URLs públicas
bun scripts/publicacao.ts pergunta   <projeto> <pasta-do-post>   # imprime o AskUserQuestion do card
bun scripts/publicacao.ts decisao    <projeto> <pasta-do-post> <Aprovar|Pedir ajuste|Descartar> [--comentario "..."]
bun scripts/publicacao.ts refazer    <projeto> <pasta-do-post> [--pedido novo.json] [--so-legenda]
bun scripts/publicacao.ts cota       <projeto> [--em AAAA-MM-DDTHH:MM]
bun scripts/publicacao.ts publicar   <projeto> <pasta-do-post> [--empurrar] [--so-facebook]
bun scripts/publicacao.ts remover    <projeto> <pasta-do-post>
bun scripts/publicacao.ts estado     <projeto> <pasta-do-post>
bun test scripts                                                  # regras + fluxo contra um Composio falso
```

### Passo a passo de um post

O passo a passo é escrito para o agente do card do Kanban, mas também pode ser rodado à mão. `P` é o projeto, por exemplo `partyshare`, e `D` é a pasta do post, `projects/P/posts/<data>-<slug>`.

1. **Escolher o item.** Rode `bun scripts/publicacao.ts calendario P --data 2026-10-22` para ver as linhas do calendário do dia. Cada linha traz pilar, formato, ideia, CTA e o código, como E02. Esta fase publica **post** e **carrossel**. Stories e Reels ficam de fora.
2. **Rascunho.**
   - Leia `projects/P/campaign.md`. Ele traz o tom, a persona, a direção visual e o que nunca dizer.
   - Rode `bun scripts/imagens.ts brief P <pedido.json>`.
   - Escreva o pedido. Ele tem os campos de `imagens.ts` (`ideia`, `pilar`, `formato`, `quantidade`, `imagens[].cena`) e também `slug` e `data`, que são obrigatórios aqui.
   - Rode `bun scripts/publicacao.ts rascunho P <pedido.json>`. As imagens vêm do motor de imagens do projeto, `scripts/imagens.ts`, e não de HTML/CSS.
   - Para revisar as variações e marcar a escolhida, rode `bun scripts/imagens.ts revisar P D` e `bun scripts/imagens.ts escolher P D --escolha … --motivo …`. A escolhida vai para `D/final/NN.jpg`.
3. **Legenda.**
   - Escreva `D/legenda.txt` no tom da campanha: um único CTA e as hashtags no fim.
   - Se o projeto espelha na Página, escreva também `D/legenda-facebook.txt`, com no máximo 2 hashtags e o link com `utm_source=facebook`.
   - Rode `bun scripts/publicacao.ts legenda P D`. Ele confere as legendas contra `publicacao.json`: limites de palavras e emojis, de 3 a 5 hashtags no fim e só da lista, `#partyshare`, termos proibidos e exatamente um CTA. Ele aponta cada regra quebrada, e o post não avança enquanto houver erro.
4. **Hospedar.** Rode `bun scripts/publicacao.ts hospedar P D`. Ele envia cada `final/NN.jpg` pelo `scripts/upload-image.ts --check` e guarda as URLs públicas no `post.json`.
5. **Aprovação pelo Telegram.**
   - Rode `bun scripts/publicacao.ts pergunta P D`. A saída é o JSON de um `AskUserQuestion` que o agente usa tal como está.
   - A pergunta traz a legenda inteira e as imagens como `![](caminho absoluto)`, com as opções **Aprovar / Pedir ajuste / Descartar**.
   - O Kanban tira as imagens do texto e as manda no aviso do hub. O conector do Telegram mostra a foto com os botões embaixo, ou o álbum seguido da pergunta, quando é carrossel.
   - Com a resposta, rode `bun scripts/publicacao.ts decisao P D <resposta>`.
6. **Pedir ajuste.**
   - O agente encerra o turno com "Responda a este card com o que ajustar". O Telegram só aceita a resposta de uma pergunta com opções quando ela é uma das opções, então o comentário chega numa resposta de texto ao card, que entra no card como a próxima instrução.
   - Com o comentário, rode `decisao P D "Pedir ajuste" --comentario "<texto>"`.
   - Para refazer, rode `refazer P D`. Use `--pedido novo.json` quando a cena mudou, ou `--so-legenda`. Isso abre a rodada seguinte, volta ao passo 2 ou 3 e pergunta de novo. A pergunta nova mostra o ajuste pedido.
7. **Publicar.** Rode `bun scripts/publicacao.ts publicar P D`, só depois de "Aprovar". Na ordem, ele:
   1. conta os posts **publicados e agendados do projeto** numa janela de 24h, que inclui os agendados à frente. Se já houver 3, ele recusa e mostra o próximo dia livre. Com `--empurrar`, o post fica `agendado` para o mesmo horário do dia seguinte, ou do próximo dia que couber. Um carrossel conta como uma publicação, e o espelho na Página não conta à parte;
   2. lê o `content_publishing_limit` da conta (`INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT`) e recusa se `quota_usage` tiver chegado a `quota_total`;
   3. cria os containers:
      - **post:** `INSTAGRAM_POST_IG_USER_MEDIA` com `image_url` e `caption`;
      - **carrossel:** um `INSTAGRAM_CREATE_CAROUSEL_CONTAINER` só, com os slides em `child_image_urls` e a legenda;
      - depois chama `INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH`, que espera o container ficar pronto (`max_wait_seconds`). O `INSTAGRAM_GET_POST_STATUS` está deprecado;
   4. lê o permalink (`INSTAGRAM_GET_IG_MEDIA`) e grava `instagram.mediaId`, `permalink`, `publicadoEm` e os ids dos containers no `post.json`. Também compara a legenda publicada com a aprovada e avisa se diferirem;
   5. espelha na Página, se `facebook.espelhar` estiver ligado e a Página estiver fixada: `FACEBOOK_CREATE_PHOTO_POST` para post, `FACEBOOK_CREATE_MULTI_PHOTO_POST` para carrossel, e depois `FACEBOOK_GET_POST` para o `permalink_url`. Se a Página falhar, o Instagram continua publicado, e a nova tentativa é `publicar --so-facebook`.

O agendamento recorrente automático está fora desta fase. Um post `agendado` vai ao ar quando alguém roda `publicar` de novo no horário marcado, à mão ou por um card.

### Prompt do card de um post

Para criar o card de um item do calendário:

```sh
kanban task create --project-path <repo> --title "partyshare: post E02 (22/out)" --tags instagram,partyshare --prompt "$(cat <<'EOF'
Projeto selecionado: partyshare. Use só marketing/instagram/projects/partyshare/ (campanha, persona, publicacao.json, posts); nada de outro projeto.
Item do calendário: 2026-10-22, E02 (bun scripts/publicacao.ts calendario partyshare --data 2026-10-22).
Siga marketing/instagram/README.md → "Passo a passo de um post", do passo 1 ao 7, rodando os comandos de marketing/instagram/.
Na aprovação, faça a pergunta exatamente com o JSON de "publicacao.ts pergunta". Publique só depois de "Aprovar".
Pronto quando o post.json tiver instagram.mediaId e permalink (e facebook.postId, se o projeto espelha), ou estiver descartado.
EOF
)"
```

## Configuração

### Composio (composio.dev)

A conta do Instagram e a Página do Facebook estão conectadas na **área de consumidor** do Composio, em composio.dev → **For You**. Ver `composio.md`.

Os scripts chamam essa área pelo MCP dela, `https://connect.composio.dev/mcp`. Cada ação roda por `COMPOSIO_MULTI_EXECUTE_TOOL`, uma de cada vez.

As conexões não passam de um projeto do Composio para outro. O proxy de conectores da Cline API (`sdk/packages/core/src/extensions/composio/`) fala com o projeto da Cline, exige uma sessão Cline logada com `CLINE_COMPOSIO_BETA` e não enxerga estas contas.

| Variável | Onde achar |
|---|---|
| `COMPOSIO_CONSUMER_API_KEY` | composio.dev → **For You → Connect my agent**. É a chave `ck_…` |
| `COMPOSIO_MCP_URL` | Opcional. O padrão é `https://connect.composio.dev/mcp` |

Ponha os valores em `~/.config/cline-marketing/instagram.env` (ver [Onde ficam as chaves](#onde-ficam-as-chaves)). Depois rode:

```sh
bun scripts/publicacao.ts conexao partyshare                                 # confere: conexões, @, tipo de conta, limite da Meta, Páginas
bun scripts/publicacao.ts conexao partyshare --salvar --pagina "Party Share" # fixa ig_user_id, @ e Página em projects/partyshare/publicacao.json
```

A conta tem mais de uma Página (Party Share e il Burger). A do projeto é a já fixada, a ligada ao Instagram ou a que `--pagina` nomear. O script nunca escolhe por palpite.

Quando houver mais de uma conta do mesmo toolkit, `contaComposio` escolhe a do projeto e vai no campo `account` da execução. Os ids que ficam no `publicacao.json` (`igUserId`, `pageId`, `contaComposio`) não são segredos. Eles são o que impede um projeto de publicar na conta de outro.

### Hospedagem das imagens (Cloudflare R2)

A API do Instagram recebe a imagem por `image_url`: a Meta baixa o arquivo, então ele precisa estar numa URL HTTPS pública. Usamos um bucket próprio no **Cloudflare R2**, o `cline-marketing-instagram`, com acesso público. Ele fica separado dos buckets de outros projetos.

| Opção | Custo para ~30–100 imagens/mês | Credenciais |
| --- | --- | --- |
| **Cloudflare R2** (escolhido) | Grátis até 10 GB armazenados, sem custo de egress | Reaproveita a conta Cloudflare; um token de API do R2 restrito a este bucket |
| Vercel Blob | Grátis no Hobby: 1 GB armazenado, 10 GB de transferência/mês | Um store novo e o token dele |

Uma imagem de post tem 0,5–2 MB, então 100 imagens/mês ficam bem abaixo do limite grátis.

O script usa o cliente S3 que já vem no Bun, então não há dependências para instalar.

#### Variáveis de ambiente

| Variável | Descrição |
| --- | --- |
| `R2_ENDPOINT` ou `S3_API` | `https://<account-id>.r2.cloudflarestorage.com`. `S3_API` é o valor de **bucket → Settings → S3 API**, que já termina com `/<bucket>`. O script remove esse caminho e o usa como bucket quando `R2_BUCKET` não está definida. |
| `R2_ACCESS_KEY_ID` | Access Key ID de um token de API do R2 com escrita no bucket |
| `R2_SECRET_ACCESS_KEY` | Secret Access Key do mesmo token |
| `R2_BUCKET` | `cline-marketing-instagram` (opcional quando vem dentro de `S3_API`) |
| `R2_PUBLIC_BASE_URL` | URL pública do bucket, sem barra no final: `https://pub-<hash>.r2.dev` ou um domínio próprio |

Todas são obrigatórias, a não ser nos casos opcionais indicados. Quando falta alguma, o script lista cada uma e diz onde encontrá-la. Não commite os valores.

#### Onde ficam as chaves

Num arquivo **fora do repositório**: `~/.config/cline-marketing/instagram.env` (ou o caminho em `INSTAGRAM_ENV_FILE`). Cada card do Kanban roda num worktree que é apagado quando o card termina, e um `.env` dentro dele some junto; foi assim que as chaves do R2 se perderam uma vez. `scripts/segredos.ts` lê esse arquivo em `publicacao.ts` e `upload-image.ts`, e o que já estiver no ambiente (ou num `marketing/instagram/.env`) tem precedência.

```sh
mkdir -p ~/.config/cline-marketing && chmod 700 ~/.config/cline-marketing
touch ~/.config/cline-marketing/instagram.env && chmod 600 ~/.config/cline-marketing/instagram.env
```

```sh
# ~/.config/cline-marketing/instagram.env
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
S3_API=
R2_PUBLIC_BASE_URL=
COMPOSIO_CONSUMER_API_KEY=
```

#### Configuração inicial (uma vez)

1. No painel da Cloudflare, abra **R2 → Create bucket** e crie o `cline-marketing-instagram`.
2. No bucket, vá em **Settings → Public Development URL → Enable** e copie a URL `https://pub-….r2.dev`. Ela é o `R2_PUBLIC_BASE_URL`. Se preferir um domínio próprio, use **Custom Domains**.
3. Se o token de API do R2 que você já tem for limitado a outros buckets, edite o token em **R2 → Manage API tokens** e inclua este bucket com **Object Read & Write**.

#### Enviar uma imagem

```sh
cd marketing/instagram
bun run upload caminho/para/post.jpg --check
```

O script aceita `.png`, `.jpg` e `.jpeg` até 8 MB, que é o limite do Instagram. Ele envia o arquivo para `instagram/<prefixo aleatório>-<nome>.<ext>` e imprime só a URL pública no stdout, então dá para usar `URL=$(bun run upload post.jpg)`. Com `--check`, ele baixa a URL sem autenticação e falha se a resposta não vier com status 200 e `content-type` de imagem.

Atenção: para posts de feed, a Graph API do Instagram só aceita JPEG oficialmente. Prefira `.jpg`; PNG serve para a Página do Facebook.

### `projects/<projeto>/publicacao.json`

| Campo | Para quê |
|---|---|
| `fusoHorario`, `offset` | Leitura de `--em AAAA-MM-DDTHH:MM` e horários na saída. O PartyShare usa `America/Sao_Paulo` e `-03:00` |
| `limitePorDia` | Teto de publicações do projeto em 24h. Hoje é 3 |
| `instagram` | Conta conectada no Composio, `ig_user_id` e @. Preenchido por `conexao --salvar` |
| `facebook` | `espelhar`, a conta e a Página. Sem Página fixada, não há espelho |
| `legenda`, `legendaFacebook` | Regras conferidas por `legenda`: `maxPalavras`, `maxEmojis`, `hashtags` (`min`, `max`, `obrigatorias`, `permitidas`, `proibidas`), `termosProibidos`, `ctas` e `link` |

Um projeto novo começa com uma cópia do `publicacao.json` de outro projeto. As regras de legenda dessa cópia têm de ser trocadas pelas da campanha do projeto novo.

### Dependências do fluxo

| Peça | Onde | Card |
|---|---|---|
| Motor de imagens (FLUX.2 klein via mflux) | `scripts/imagens.ts`, `scripts/imagens_pixels.py` | da0c0 |
| Hospedagem pública (Cloudflare R2) | `scripts/upload-image.ts` e as variáveis `R2_*` | 88547, já no main |
| Foto na pergunta do card, no Telegram | `HubUINotifyPayload.images` e o adapter do Telegram, neste repo | — |
| Foto na pergunta do card, no Kanban | Kanban, branch `feat/question-images`: tira as `![](…)` do `AskUserQuestion` e as manda no aviso | — |

Para o Telegram mostrar a foto, o board do Kanban e o conector do Telegram (`cline connect`) precisam estar rodando com essas mudanças. Sem elas, a pergunta chega só com o texto: a aprovação funciona, mas sem a imagem.
