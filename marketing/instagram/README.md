# Instagram e Facebook (fase 1)

Os posts saem do calendário de um projeto e vão ao Instagram e à Página do Facebook pelo Composio, depois de aprovados pelo Telegram.

Tudo é **por projeto**. Cada `projects/<project>/` tem os seus próprios arquivos, e nada de um projeto vale para outro:

- `campaign.md`: campanha, persona, tom e calendário
- `publishing.json`: contas, teto diário e regras de legenda
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

O estado de cada post fica em `post.json → publishing.state`:

| Estado | Como se chega | O que vem depois |
|---|---|---|
| `draft` | `draft`, ou `redo` depois de um ajuste | `caption`, `host`, `question` |
| `awaiting_approval` | `question` | `decision` |
| `changes_requested` | `decision "Pedir ajuste" --comment` | `redo` |
| `approved` | `decision Aprovar` | `publish` |
| `scheduled` | `publish --reschedule`, com o teto atingido | `publish` de novo no horário marcado |
| `published` | `publish` | `remove` (só no post de teste) |
| `discarded` | `decision Descartar` | — |
| `removed` | `remove` | — |

`publish` só aceita um post `approved` ou `scheduled` cuja rodada atual tenha um "Aprovar" registrado. Um rascunho nunca vai ao ar sem passar pela pergunta.

### Comandos

Rode tudo de `marketing/instagram/`. As chaves vêm de `~/.config/cline-marketing/instagram.env` (ver [Onde ficam as chaves](#onde-ficam-as-chaves)).

```sh
bun scripts/publishing.ts init       <project>                    # cria publishing.json com as contas em null
bun scripts/publishing.ts connection <project> [--save] [--page "<name>"]  # contas do Composio, @, Página, limite da Meta
bun scripts/publishing.ts calendar   <project> [--date YYYY-MM-DD]
bun scripts/publishing.ts draft      <project> <request.json>     # gera (scene) ou importa (source) as imagens
bun scripts/publishing.ts caption    <project> <post-dir>         # confere caption.txt (e caption-facebook.txt)
bun scripts/publishing.ts host       <project> <post-dir>         # envia final/*.jpg e guarda as URLs públicas
bun scripts/publishing.ts question   <project> <post-dir>         # imprime o AskUserQuestion do card
bun scripts/publishing.ts decision   <project> <post-dir> <Aprovar|Pedir ajuste|Descartar> [--comment "..."]
bun scripts/publishing.ts redo       <project> <post-dir> [--request new.json] [--caption-only]
bun scripts/publishing.ts quota      <project> [--at YYYY-MM-DDTHH:MM]
bun scripts/publishing.ts publish    <project> <post-dir> [--reschedule] [--facebook-only]
bun scripts/publishing.ts remove     <project> <post-dir>
bun scripts/publishing.ts status     <project> <post-dir>
bun scripts/social.ts <project> <SLUG> ['<json args>'] [--write]  # uma ação do Composio: comentários, respostas, mensagens, reações, insights
bun test scripts                                                  # regras + fluxo contra um Composio falso
```

### Passo a passo de um post

O passo a passo é escrito para o agente do card do Kanban, mas também pode ser rodado à mão. `P` é o projeto, por exemplo `partyshare`, e `D` é a pasta do post, `projects/P/posts/<data>-<slug>`.

1. **Escolher o item.** Rode `bun scripts/publishing.ts calendar P --date 2026-10-22` para ver as linhas do calendário do dia. Cada linha traz pilar, formato, ideia, CTA e o código, como E02. Esta fase publica **post** e **carrossel**. Stories e Reels ficam de fora.
2. **Rascunho.**
   - Leia `projects/P/campaign.md`. Ele traz o tom, a persona, a direção visual e o que nunca dizer.
   - Rode `bun scripts/images.ts brief P <request.json>`.
   - Escreva o pedido. Ele tem os campos de `images.ts` (`idea`, `pillar`, `format`, `count`, `images[]`) e também `slug` e `date`, que são obrigatórios aqui. Cada item de `images[]` traz **um** destes:
     - `scene`: a cena em inglês, para o mflux gerar (FLUX.2 klein);
     - `source`: uma imagem pronta, seja o caminho de um anexo do card (o prompt do card lista em "Attached reference images"), um arquivo do repositório ou uma URL `http(s)`. JPEG, PNG ou WebP, até 25 MB.
   - Rode `bun scripts/publishing.ts draft P <request.json>`. Com `scene`, as imagens vêm de `images.ts generate`, e não de HTML/CSS. Com `source`, `images.ts import` recorta cada imagem no centro para o tamanho do post (1080x1350 no feed), converte para JPEG sRGB abaixo de 8 MB e a põe em `D/final/NN.jpg`. Um pedido que mistura `scene` e `source` é recusado.
   - Com `scene`, revise as variações e marque a escolhida com `bun scripts/images.ts review P D` e `bun scripts/images.ts choose P D --pick … --reason …`. A escolhida vai para `D/final/NN.jpg`. Com `source`, não há variações: abra `final/` e confira o recorte, que o comando avisa quando cortou as bordas.
3. **Legenda.**
   - Escreva `D/caption.txt` no tom da campanha: um único CTA e as hashtags no fim.
   - Se o projeto espelha na Página, escreva também `D/caption-facebook.txt`, com no máximo 2 hashtags e o link com `utm_source=facebook`.
   - Rode `bun scripts/publishing.ts caption P D`. Ele confere as legendas contra `publishing.json`: limites de palavras e emojis, de 3 a 5 hashtags no fim e só da lista, `#partyshare`, termos proibidos e exatamente um CTA. Ele aponta cada regra quebrada, e o post não avança enquanto houver erro.
4. **Hospedar.** Rode `bun scripts/publishing.ts host P D`. Ele envia cada `final/NN.jpg` pelo `scripts/upload-image.ts --check` e guarda as URLs públicas no `post.json`.
5. **Aprovação pelo Telegram.**
   - Rode `bun scripts/publishing.ts question P D`. A saída é o JSON de um `AskUserQuestion` que o agente usa tal como está.
   - A pergunta traz a legenda inteira e as imagens como `![](caminho absoluto)`, com as opções **Aprovar / Pedir ajuste / Descartar**.
   - O Kanban tira as imagens do texto e as manda no aviso do hub. O conector do Telegram mostra a foto com os botões embaixo, ou o álbum seguido da pergunta, quando é carrossel.
   - Com a resposta, rode `bun scripts/publishing.ts decision P D <answer>`.
6. **Pedir ajuste.**
   - O agente encerra o turno com "Responda a este card com o que ajustar". O Telegram só aceita a resposta de uma pergunta com opções quando ela é uma das opções, então o comentário chega numa resposta de texto ao card, que entra no card como a próxima instrução.
   - Com o comentário, rode `decision P D "Pedir ajuste" --comment "<texto>"`.
   - Para refazer, rode `redo P D`. Use `--request new.json` quando a cena mudou, ou `--caption-only`. Isso abre a rodada seguinte, volta ao passo 2 ou 3 e pergunta de novo. A pergunta nova mostra o ajuste pedido.
7. **Publicar.** Rode `bun scripts/publishing.ts publish P D`, só depois de "Aprovar". Na ordem, ele:
   1. conta os posts **publicados e agendados do projeto** numa janela de 24h, que inclui os agendados à frente. Se já houver 3, ele recusa e mostra o próximo dia livre. Com `--reschedule`, o post fica `scheduled` para o mesmo horário do dia seguinte, ou do próximo dia que couber. Um carrossel conta como uma publicação, e o espelho na Página não conta à parte;
   2. lê o `content_publishing_limit` da conta (`INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT`) e recusa se `quota_usage` tiver chegado a `quota_total`;
   3. cria os containers:
      - **post:** `INSTAGRAM_POST_IG_USER_MEDIA` com `image_url` e `caption`;
      - **carrossel:** um `INSTAGRAM_CREATE_CAROUSEL_CONTAINER` só, com os slides em `child_image_urls` e a legenda;
      - depois chama `INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH`, que espera o container ficar pronto (`max_wait_seconds`). O `INSTAGRAM_GET_POST_STATUS` está deprecado;
   4. lê o permalink (`INSTAGRAM_GET_IG_MEDIA`) e grava `instagram.mediaId`, `permalink`, `publishedAt` e os ids dos containers no `post.json`. Também compara a legenda publicada com a aprovada e avisa se diferirem;
   5. espelha na Página, se `facebook.mirror` estiver ligado e a Página estiver fixada: `FACEBOOK_CREATE_PHOTO_POST` para post, `FACEBOOK_CREATE_MULTI_PHOTO_POST` para carrossel, e depois `FACEBOOK_GET_POST` para o `permalink_url`. Se a Página falhar, o Instagram continua publicado, e a nova tentativa é `publish --facebook-only`.

**Só na Página, sem Instagram.** Enquanto o Instagram não está conectado no Composio, `connection` avisa e segue só com o Facebook. Fixe a Página com `connection P --save --page "Party Share"`. Num post `approved`, `publish P D --facebook-only` publica só na Página, com as mesmas travas: precisa do "Aprovar" da rodada e cabe no teto de 3 por 24h, e o post publicado só na Página conta nesse teto. Se a Página falhar, o post continua `approved` e o erro fica em `facebook.error`. Num post já `published`, a mesma flag só refaz o espelho.

O agendamento recorrente automático está fora desta fase. Um post `scheduled` vai ao ar quando alguém roda `publish` de novo no horário marcado, à mão ou por um card.

### Prompt do card de um post

Para criar o card de um item do calendário:

```sh
kanban task create --project-path <repo> --title "partyshare: post E02 (22/out)" --tags instagram,partyshare --prompt "$(cat <<'EOF'
Projeto selecionado: partyshare. Use só marketing/instagram/projects/partyshare/ (campanha, persona, publishing.json, posts); nada de outro projeto.
Item do calendário: 2026-10-22, E02 (bun scripts/publishing.ts calendar partyshare --date 2026-10-22).
Siga marketing/instagram/README.md → "Passo a passo de um post", do passo 1 ao 7, rodando os comandos de marketing/instagram/.
Na aprovação, faça a pergunta exatamente com o JSON de "publishing.ts question". Publique só depois de "Aprovar".
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
bun scripts/publishing.ts connection partyshare                                 # confere: conexões, @, tipo de conta, limite da Meta, Páginas
bun scripts/publishing.ts connection partyshare --save --page "Party Share" # fixa ig_user_id, @ e Página em projects/partyshare/publishing.json
```

A conta tem mais de uma Página (Party Share e il Burger). A do projeto é a já fixada, a ligada ao Instagram ou a que `--page` nomear. O script nunca escolhe por palpite.

Quando houver mais de uma conta do mesmo toolkit, `composioAccount` escolhe a do projeto e vai no campo `account` da execução. Os ids que ficam no `publishing.json` (`igUserId`, `pageId`, `composioAccount`) não são segredos. Eles são o que impede um projeto de publicar na conta de outro.

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

Num arquivo **fora do repositório**: `~/.config/cline-marketing/instagram.env` (ou o caminho em `INSTAGRAM_ENV_FILE`). Cada card do Kanban roda num worktree que é apagado quando o card termina, e um `.env` dentro dele some junto; foi assim que as chaves do R2 se perderam uma vez. `scripts/secrets.ts` lê esse arquivo em `publishing.ts` e `upload-image.ts`, e o que já estiver no ambiente (ou num `marketing/instagram/.env`) tem precedência.

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

### `projects/<project>/publishing.json`

| Campo | Para quê |
|---|---|
| `timezone`, `utcOffset` | Leitura de `--at YYYY-MM-DDTHH:MM` e horários na saída. O PartyShare usa `America/Sao_Paulo` e `-03:00` |
| `dailyLimit` | Teto de publicações do projeto em 24h. Hoje é 3 |
| `instagram` | Conta conectada no Composio, `ig_user_id` e @. Preenchido por `connection --save` |
| `facebook` | `espelhar`, a conta e a Página. Sem Página fixada, não há espelho |
| `caption`, `captionFacebook` | Regras conferidas por `caption`: `maxWords`, `maxEmojis`, `hashtags` (`min`, `max`, `required`, `allowed`, `forbidden`), `forbiddenTerms`, `ctas` e `link` |

Um projeto novo ganha o arquivo com `bun scripts/publishing.ts init <project>`, que cria a pasta do projeto se preciso e nunca sobrescreve um `publishing.json` existente. O `campaign.md` pode chegar depois: sem ele, o `init` só avisa, e nenhum post passa no `caption` até as regras serem preenchidas. Ele nasce com todos os ids em `null`. Depois, `connection <project>` mostra as contas e as Páginas que o Composio enxerga, e `connection <project> --save --page "<nome>"` grava `composioAccount`, `igUserId`, `username` e `pageId`. A Página nunca é escolhida por palpite, mas o Instagram gravado é o que o Composio devolver: confira o @ na saída sem `--save` antes de gravar. As regras de legenda (`caption`, `captionFacebook`) começam vazias e saem do `campaign.md`. Não copie o arquivo de outro projeto: ele traz as contas e os ids do outro.

### Dependências do fluxo

| Peça | Onde | Card |
|---|---|---|
| Motor de imagens (FLUX.2 klein via mflux) | `scripts/images.ts`, `scripts/images_pixels.py` | da0c0 |
| Hospedagem pública (Cloudflare R2) | `scripts/upload-image.ts` e as variáveis `R2_*` | 88547, já no main |
| Foto na pergunta do card, no Telegram | `HubUINotifyPayload.images` e o adapter do Telegram, neste repo | — |
| Foto na pergunta do card, no Kanban | Kanban, branch `feat/question-images`: tira as `![](…)` do `AskUserQuestion` e as manda no aviso | — |

Para o Telegram mostrar a foto, o board do Kanban e o conector do Telegram (`cline connect`) precisam estar rodando com essas mudanças. Sem elas, a pergunta chega só com o texto: a aprovação funciona, mas sem a imagem.

## Interações (comentários, respostas, mensagens, reações)

`scripts/social.ts` roda uma ação do Composio na conta do projeto e imprime o `data` dela em JSON. É o caminho para tudo que não é publicar: o agente do card não escreve cliente próprio nem chama o MCP direto.

```sh
bun scripts/social.ts partyshare FACEBOOK_GET_PAGE_POSTS '{"page_id":"$pageId","limit":10}'
bun scripts/social.ts partyshare FACEBOOK_CREATE_COMMENT '{"object_id":"<commentId>","message":"Obrigado!"}' --write
```

- **Parâmetros de uma ação:** `bun scripts/social.ts <project> <SLUG> --schema` mostra o esquema que o Composio declara (meta tool, sem custo). Consulte antes de chutar um nome de campo.
- **Conta e ids do projeto.** A conta vem de `publishing.json` (`instagram`/`facebook.composioAccount`). `"$pageId"` e `"$igUserId"` nos argumentos viram os ids do projeto.
- **Leitura passa direto; escrita pede `--write`.** Ações `GET_`, `LIST_`, `FETCH_` e `SEARCH_` rodam como estão. Qualquer outra muda algo público (comentário, resposta, curtida, mensagem) e só roda com `--write`.
- **Publicar não passa por aqui.** Criar, agendar, editar e apagar posts, as ações deprecadas, a administração da Página e as meta tools `COMPOSIO_*` são recusadas com o caminho certo.
- **Sem Instagram conectado** (`instagram.igUserId` em `null`), as ações `INSTAGRAM_*` param antes de chamar e dizem quem conecta.
- **Cada execução** entra em `projects/<project>/composio-calls.jsonl` com `"command": "social"`, então conta no consumo.

As ações, os parâmetros e as armadilhas de cada uma estão em `composio.md` e na skill `publishing-social-posts`.

## Métricas diárias

`scripts/metrics.ts` coleta todo dia, pelo Composio, as métricas de cada post e da conta de cada projeto e guarda o histórico em `metrics/<project>/`. A Graph API só mostra janelas recentes (séries diárias de até 30 dias, nada de posts com mais de 2 anos), então o que não for guardado aqui se perde.

### Rodar à mão

```sh
cd marketing/instagram
bun run metrics              # todos os projetos com publishing.json
bun run metrics partyshare   # só um projeto
bun run test                 # testes contra um Composio falso
```

A saída é uma linha por projeto, por exemplo `partyshare 2026-10-15: ok · 14 Composio calls (0 failed) · 1 Instagram posts · 1 Facebook posts · days 2026-10-13, 2026-10-14`, seguida dos erros, se houver. O código de saída é 1 só quando nenhuma das fontes configuradas respondeu. Falhas parciais (`partial`) saem com 0 e ficam registradas no arquivo.

Rodar de novo no mesmo dia é seguro: os valores são substituídos, não somados, e a execução nova entra em `runs`.

### Configuração

O script usa o mesmo cliente do fluxo de publicação (`scripts/composio.ts`, MCP da área de consumidor) e lê as chaves de `~/.config/cline-marketing/instagram.env` por `scripts/secrets.ts` (ver [Onde ficam as chaves](#onde-ficam-as-chaves)). Só precisa de `COMPOSIO_CONSUMER_API_KEY`.

**As contas vêm do projeto.** O script lê `projects/<project>/publishing.json`, o mesmo arquivo que o fluxo de publicação preenche com `publishing.ts connection <project> --save`:

| Campo | Uso |
|---|---|
| `instagram.composioAccount`, `instagram.igUserId` | Preenchidos por `connection --save`. Enquanto os dois forem `null`, o Instagram do projeto é pulado sem erro: é o caso da Party Share hoje |
| `facebook.pageId` | Com ele, a Página entra na coleta. `facebook.composioAccount` escolhe a conexão quando há mais de uma; em `null`, vale a conta padrão do Composio, como na publicação |
| `offset` | Fuso que define "um dia" (`-03:00`) |

Um projeto sem `publishing.json`, ou sem nenhuma conta preenchida nele, não é coletado. Um projeto nunca lê as contas de outro.

| Variável | Obrigatória | Descrição |
|---|---|---|
| `METRICS_UTC_OFFSET` | não | Substitui o `offset` do projeto. Padrão `-03:00` (São Paulo) |
| `METRICS_LOOKBACK_DAYS` | não | Quantos dias para trás o script confere se falta métrica da conta. Padrão 7, máximo útil 28 |
| `METRICS_DIR`, `METRICS_NOW` | não | Para testes: outra pasta de saída, outro "agora" |

### O que é coletado

| Onde | Métricas | Ação do Composio | Chamadas por execução |
|---|---|---|---|
| Cada post do Instagram | `views`, `reach`, `likes`, `comments`, `saved`, `shares`, `total_interactions` (totais da vida do post) | `INSTAGRAM_GET_IG_MEDIA_INSIGHTS` | 1 por post que ainda pode ter insights |
| Lista de posts | id, tipo, data, permalink, começo da legenda | `INSTAGRAM_GET_IG_USER_MEDIA` | 1 por página de 50 |
| Perfil | `followers_count`, `follows_count`, `media_count` | `INSTAGRAM_GET_USER_INFO` | 1 |
| Conta, por dia | `reach`, `views`, `accounts_engaged`, `total_interactions` | `INSTAGRAM_GET_USER_INSIGHTS` (`total_value`) | 1 por dia buscado (normalmente 2) |
| Novos seguidores, por dia | `follower_count` | `INSTAGRAM_GET_USER_INSIGHTS` (`time_series`) | 1, só com 100+ seguidores |
| Demografia | `follower_demographics` por idade, gênero, país e cidade, no mês corrente (`timeframe: this_month`) | `INSTAGRAM_GET_USER_INSIGHTS` | 4, uma vez por semana, só com 100+ seguidores |
| Página do Facebook | perfil; por dia `page_media_view` (visualizações), `page_total_media_view_unique` (alcance), `page_post_engagements`, `page_daily_follows_unique`, `page_follows` (seguidores) | `FACEBOOK_GET_PAGE_DETAILS`, `FACEBOOK_GET_PAGE_INSIGHTS` | 2 |
| Posts da Página | `post_media_view`, `post_total_media_view_unique` | `FACEBOOK_GET_PAGE_POSTS`, `FACEBOOK_GET_POST_INSIGHTS` | 1 + 1 por post |

`impressions`, `plays` e `video_views` foram descontinuadas pela Meta em 2025 e não são pedidas.

Num dia normal, com N posts no Instagram e M na Página, são `N + 5` chamadas para o Instagram (mais 4 no dia da demografia) e `M + 3` para a Página. A primeira execução busca também os dias que faltam na janela (até 7 chamadas a mais).

Para não gastar chamadas à toa:

- posts com mais de 2 anos não são consultados;
- um post que a Meta recusou de forma definitiva, como os publicados antes da conversão para conta profissional, fica marcado com `insightsUnavailable.permanent` e não é consultado de novo;
- se a Meta disser que uma métrica não vale para aquele tipo de mídia, o script tira essa métrica e tenta uma vez mais. Ela fica `null`.

**Menos de 100 seguidores:** a Meta não devolve demografia nem a série de novos seguidores. O script não faz essas chamadas, grava `demographics: { available: false, reason: … }` e deixa `new_followers: null`. O total de seguidores do perfil continua sendo gravado todo dia, então a variação diária pode ser calculada pela diferença entre dois dias.

### Formato: um JSON por dia

`metrics/<project>/<AAAA-MM-DD>.json`, um arquivo por dia e por projeto, em vez de SQLite, porque:

- o histórico é o que importa guardar, e o repositório é o backup. O `.gitignore` da raiz ignora `*.db`, e um banco binário no git não mostra diferença nem se resolve num conflito; um JSON por dia aparece no diff de cada commit;
- o volume é pequeno (dezenas de posts, um arquivo por dia) e não pede consultas;
- o agente e as pessoas leem o arquivo direto, sem cliente SQL;
- não duplicar é questão de chave, e o arquivo já resolve isso: os posts ficam num objeto por id e cada dia tem um arquivo só.

Cada valor fica num lugar só, no arquivo da data a que pertence:

```jsonc
{
  "schema": 1,
  "date": "2026-10-15",
  "utcOffset": "-03:00",
  "instagram": {
    "account": {
      "day": { "reach": 120, "views": 340, "accounts_engaged": 9, "total_interactions": 14, "new_followers": 2, "collectedAt": "…" }, // métricas DESTE dia
      "snapshot": { "username": "…", "followers_count": 325, "follows_count": 10, "media_count": 36, "collectedAt": "…" }, // lido NESTE dia
      "demographics": { "available": false, "reason": "…", "collectedAt": "…" }
    },
    "posts": {                        // totais da vida de cada post, lidos NESTE dia
      "17890…": {
        "permalink": "https://www.instagram.com/p/…/", "timestamp": "…", "mediaType": "IMAGE", "productType": "FEED", "caption": "…",
        "calendar": { "project": "partyshare", "post": "projects/partyshare/posts/2026-10-22-telao/post.json", "slug": "telao", "date": "2026-10-22", "code": "E02" },
        "metrics": { "views": 340, "reach": 120, "likes": 11, "comments": 2, "saved": 1, "shares": 0, "total_interactions": 14 },
        "collectedAt": "…"
      }
    }
  },
  "facebook": { "pageId": "…", "page": { "day": { … }, "snapshot": { … } }, "posts": { … } },
  "runs": [                           // cada execução deste dia
    { "startedAt": "…", "finishedAt": "…", "status": "ok", "composioCalls": { "total": 14, "failed": 0, "bySlug": { "INSTAGRAM_GET_USER_INFO": 1, … } }, "instagramPosts": 3, "facebookPosts": 1, "accountDays": ["2026-10-13", "2026-10-14"], "errors": [] }
  ]
}
```

- **Métricas da conta por dia** (`account.day`, `page.day`) vão no arquivo do dia medido. A execução de hoje busca ontem e anteontem de novo, porque a Meta ainda ajusta esses números por até 48h, e qualquer dia sem métrica nos últimos `METRICS_LOOKBACK_DAYS`. Por isso um dia em que o job não rodou é preenchido no dia seguinte, e buscar de novo substitui o valor em vez de somar.
- **Métricas de post** são totais acumulados. Cada dia guarda uma foto, e a evolução de um post é a sequência dessas fotos. Rodar de novo no mesmo dia troca a foto; se a nova chamada falhar, a foto anterior do dia é mantida.
- **`calendar`** liga o post ao item do calendário: o script procura em `projects/<project>/posts/*/post.json` o `publishing.instagram.mediaId`, o permalink ou o `publishing.facebook.postId`. Fica `null` quando o post não saiu do calendário.
- Os dias seguem `METRICS_UTC_OFFSET`. Séries diárias da Meta (`follower_count`, insights da Página) usam o dia do Pacífico e são encaixadas no dia local mais próximo.

Commite os arquivos de `metrics/<project>/` de tempos em tempos: são eles o histórico.

### Agendamento diário (schedules do Cline)

O agendamento usa os schedules do Cline (`cline schedule`, servidos pelo hub). O agente agendado só roda o script, que é quem faz as chamadas e conta cada uma. A linha de resumo fica no histórico do schedule, e a contagem completa fica em `runs` do arquivo do dia.

```sh
cd "$(git rev-parse --show-toplevel)"
bun run cli schedule create "Instagram: métricas diárias" \
  --cron "0 7 * * *" \
  --workspace "$PWD" \
  --cwd "$PWD/marketing/instagram" \
  --mode yolo \
  --timeout 900 \
  --tags instagram,metrics \
  --prompt "Em marketing/instagram, rode exatamente: bun run metrics. Não edite nenhum arquivo nem rode outro comando. Responda só com a linha de resumo que o comando imprimir e com os erros listados abaixo dela; se o comando sair com código diferente de 0, comece a resposta com FALHOU."
```

Às 7h, horário local da máquina, o dia anterior já fechou. A máquina e o hub precisam estar ligados nesse horário. Uma execução perdida não perde dados, desde que a próxima aconteça dentro de `METRICS_LOOKBACK_DAYS` dias. Os posts só não terão a foto do dia que faltou.

Para acompanhar:

```sh
bun run cli schedule list --tags metrics
bun run cli schedule trigger <schedule-id>          # roda agora
bun run cli schedule history <schedule-id> --limit 7
```

O agente agendado precisa de um provedor de LLM configurado (`cline auth`). A chave do Composio vem de `~/.config/cline-marketing/instagram.env`.

## Relatório semanal

`scripts/report.ts` cruza as métricas de `metrics/<project>/` com a campanha do projeto e grava `reports/<project>/<semana ISO>.md`, por exemplo `reports/partyshare/2026-W43.md`. O schedule semanal manda esse texto ao Telegram. Lá, uma mensagem longa vira um arquivo `.md` sozinha.

```sh
cd marketing/instagram
bun run report                                  # semana anterior (seg–dom), todos os projetos com publishing.json
bun run report partyshare --week 2026-W43     # uma semana escolhida
bun run report partyshare --no-comments     # sem chamar o Composio
```

O relatório sai no stdout, e a linha de resumo e os erros saem no stderr. Rodar de novo regrava o arquivo da semana.

### O que entra

| Seção | De onde vem |
|---|---|
| Alcance e seguidores | `account.day` e `page.day` da semana somados, com a variação contra a semana anterior. Seguidores vêm do perfil lido na manhã seguinte ao fim de cada semana. Engajamento = interações ÷ alcance |
| Posts da semana | A última foto de cada post publicado na semana, com 🥇 e 🔻 dentro de cada rede. O pilar e o formato vêm do `post.json` do calendário (`calendar.post`), da linha do calendário com a mesma data e o mesmo pilar, ou do tipo de mídia. A tabela "Por pilar e formato" compara a média de cada combinação |
| Fora do ar | Itens de feed do calendário da semana (tudo menos Story) sem post publicado |
| Comentários | Lidos pelo Composio só para os posts da semana: `INSTAGRAM_GET_IG_MEDIA_COMMENTS` nos posts com comentários e `FACEBOOK_GET_COMMENTS` em cada post da Página, até 50 por post. São agrupados por tema com palavras-chave (preço, TI e segurança, como funciona, wi-fi, datas e vagas, elogio). O relatório traz a contagem e um exemplo curto, sem autor e com as @ apagadas; o texto dos comentários não é guardado |
| Para a semana que vem | 3 recomendações, escolhidas por prioridade: Instagram desconectado; item do calendário que não saiu; objeção que se repete nos comentários (com o post da semana seguinte que pode respondê-la); formato, pilar ou horário que rendeu pelo menos 25% mais; queda de alcance de 20% ou mais; post mais salvo. Quando faltam dados, entram passos práticos: coleta que falhou e os próximos itens do calendário |
| Composio | Chamadas da coleta diária da semana (somadas de `runs`) e as deste relatório, seguidas da linha de [Consumo do Composio](#consumo-do-composio) (`usageLine`). As chamadas do relatório ficam em `projects/<project>/composio-calls.jsonl` com `"command": "report"`, então entram no total do mês |

Com Instagram, a comparação usa o engajamento dos posts do Instagram. Só com a Página, usa o alcance, porque a Página não dá interações por post.

### Agendamento semanal (schedules do Cline)

O relatório roda segunda às 8h, uma hora depois da coleta das 7h, que traz o domingo. O resultado vai para o tópico do Telegram em que os cards já avisam, pelo bot que roda `cline connect telegram`. A delivery usa a resposta final do agente agendado, então o prompt pede o relatório tal como saiu.

```sh
cd "$(git rev-parse --show-toplevel)"
cline schedule create "Instagram: relatório semanal" \
  --address 127.0.0.1:25463 \
  --cron "0 8 * * 1" \
  --workspace "$PWD" \
  --cwd "$PWD/marketing/instagram" \
  --mode yolo \
  --timeout 900 \
  --provider claude-code --model claude-sonnet-5 \
  --tags instagram,report \
  --delivery-adapter telegram \
  --delivery-bot fsrezende_cline_bot \
  --delivery-thread "telegram:-1004378402573:49" \
  --prompt "Em marketing/instagram, rode exatamente: bun run report. Não edite nenhum arquivo nem rode outro comando. Responda só com o Markdown que o comando imprimir no stdout, do título até a linha do Composio, sem acrescentar nem resumir nada. Se o comando sair com código diferente de 0, comece a resposta com FALHOU e copie o stderr."
```

Rode o comando na raiz do repositório **principal**, não num worktree de card. `--delivery-thread` é o que `/whereami` mostra no chat. Para acompanhar:

```sh
cline schedule list --tags report --address 127.0.0.1:25463
cline schedule trigger <schedule-id> --address 127.0.0.1:25463          # roda agora e manda ao Telegram
cline schedule history <schedule-id> --limit 4 --address 127.0.0.1:25463
```

Três cuidados, todos vistos no primeiro disparo:

- **Use `cline` (`bun apps/cli/src/index.ts`) a partir da raiz, não `bun run cli`.** `bun run cli` roda de dentro de `apps/cli`, e o schedule fica fora do escopo dessa pasta: `trigger` e `history` respondem "schedule does not exist in this workspace".
- **Passe `--address`.** Sem ele, o comando usa um cliente local, que roda o agente no próprio processo, e nada chega ao hub nem ao Telegram. O endereço é o `rpcAddress` de `~/.cline/data/connectors/telegram/<bot>.json`. `trigger` só aceita um schedule habilitado.
- **O provedor `claude-code` passa os comandos pelas permissões do Claude Code de quem roda o hub.** Sem uma regra que libere `bun run report` (por exemplo `Bash(bun run report:*)` em `permissions.allow`), o agente agendado tem o comando negado e a execução acaba em timeout. A outra saída é um provedor nativo (`cline auth`): em `--mode yolo`, ele roda o comando sem perguntar.

Commite os arquivos de `reports/<project>/` junto com os de `metrics/<project>/`.

## Consumo do Composio

A decisão do projeto: ficar no Composio enquanto o consumo couber no plano gratuito e construir o conector nativo da Meta se passar. `scripts/usage.ts` soma as chamadas que cada job registrou, projeta o mês e avisa no Telegram quando a projeção passa de **70% do gratuito**.

**Projeção hoje: ~140 chamadas/mês, 0,14% do gratuito** (só a Página, com o Instagram da Party Share ainda desconectado). Com o Instagram conectado, ~700/mês (0,7%); depois de um ano no ritmo do calendário, ~3.300/mês (3,3%). As contas estão em [Modelo da projeção](#modelo-da-projeção).

### O plano e de quem é a cota

| | Plano gratuito (Hobby), conferido em composio.dev/pricing em 15/10/2026 |
|---|---|
| Tool calls | 100 mil/mês. Cada execução de ação conta uma vez; as meta tools (busca, schemas, conexões) não são cobradas |
| Trigger events | 50 mil/mês. **Não usamos nenhum**: os toolkits de Instagram e Facebook não têm triggers (ver `composio.md`) |
| Excedente | US$ 0,0003 por chamada; o Pro custa US$ 29/mês em créditos |

**A cota é nossa, não da Cline.** Os scripts chamam o MCP da área de consumidor com a nossa chave `ck_` (`composio.dev → For You`), não o proxy de conectores da Cline API: as contas da Party Share estão conectadas lá, e o proxy fala com o projeto Composio da Cline, que não as enxerga. O consumo aparece no painel da nossa conta no composio.dev. Se um dia a publicação passar pelo proxy da Cline (`CLINE_COMPOSIO_BETA`), as chamadas caem no projeto da Cline e esta conta deixa de valer: aí o número tem de vir do time da Cline API.

### De onde vêm os números

Cada job registra as chamadas que fez, falhas incluídas, porque o Composio cobra a execução mesmo quando a Meta recusa:

| Fluxo | Onde o job registra |
|---|---|
| Métricas (`metrics.ts`) | `runs[].composioCalls` em `metrics/<project>/<AAAA-MM-DD>.json` |
| Publicação (`publishing.ts connection`, `publish`, `remove`) | uma linha por comando em `projects/<project>/composio-calls.jsonl`, gravada na saída, até quando o comando para no meio |

As meta tools (`COMPOSIO_MANAGE_CONNECTIONS`, de `connection`) ficam em `metaTools`, fora do total. As duas primeiras linhas do PartyShare foram reconstruídas do `history` do post de teste de 15/10 (`reconstructed` no registro), que rodou antes de haver registro.

```sh
cd marketing/instagram
bun run usage              # mês até agora, projeção, por projeto e por ação
bun run usage -- --line   # a linha do relatório semanal
bun run usage -- --warn   # a mesma linha; sai com 2 quando passa do aviso
bun run usage -- --json
```

**Projeção:** o que foi registrado no mês (no fuso `-03:00`) mais a média diária dos últimos 7 dias vezes os dias que faltam. Com menos de 7 dias de histórico, a média é desde o primeiro registro, o que pesa para cima logo depois de um job novo começar. `COMPOSIO_FREE_CALLS` e `USAGE_WARN_PCT` trocam o limite e o aviso, se o plano mudar.

### Linha no relatório semanal

O relatório semanal inclui a saída de `bun run usage -- --line`, como está, por exemplo:

```
Composio out/2026: 3 chamadas até 15/10 (publicação 3 · métricas 0) · projeção 52 no mês = 0,1% do gratuito (100 mil) · triggers 0
```

Quem gera o relatório em TypeScript pode usar `projectUsage(readUsageRecords(...))` e `usageLine(...)`, exportados por `scripts/usage.ts`.

### Aviso no Telegram

Um schedule do Cline roda o consumo toda segunda às 9h e entrega a resposta no chat do bot do Telegram (`--delivery-thread`). A entrega do schedule sempre manda a resposta final, então a mensagem chega toda semana: uma linha normal enquanto está abaixo de 70%, e uma que começa com `⚠️ Composio acima de 70% do gratuito` e lembra a decisão (conector nativo da Meta) quando passa.

```sh
cd "$(git rev-parse --show-toplevel)"   # o repositório principal, não o worktree de um card
bun run cli schedule create "Instagram: consumo do Composio" \
  --cron "0 9 * * 1" \
  --workspace "$PWD" \
  --cwd "$PWD/marketing/instagram" \
  --mode yolo \
  --timeout 300 \
  --tags instagram,composio \
  --delivery-adapter telegram \
  --delivery-thread <deliveryThread> \
  --prompt "Em marketing/instagram, rode exatamente: bun run usage -- --warn. Não edite nenhum arquivo nem rode outro comando. Responda só com a linha que o comando imprimir, sem mudar nada nela. Se o comando sair com código diferente de 0 e de 2, comece a resposta com FALHOU e diga o erro."
```

O `<deliveryThread>` sai de `/whereami` no chat do bot. O conector do Telegram (`cline connect telegram`) e o hub precisam estar rodando no horário. Para conferir: `bun run cli schedule list --tags composio` e `bun run cli schedule trigger <id>`.

A conferência é semanal porque o consumo anda devagar (ver o modelo abaixo): entre 0,1% e 3% do gratuito por mês, os 70% não chegam de uma semana para outra.

### Modelo da projeção

Chamadas por ação, contadas no código:

| Job | Chamadas |
|---|---|
| Publicar no Instagram (post ou carrossel) | 4: limite da Meta, container, publish, permalink |
| Espelho na Página | 2: post e permalink |
| `connection` | 2 a 3 ações (+1 meta tool, grátis) |
| Métricas, por dia | Instagram `N + 5` (+4 por semana com 100+ seguidores) e Página `M + 3`, com N e M os posts com menos de 2 anos |

O calendário da Party Share tem 3 a 4 posts de feed por mês nesta fase. Stories e Reels não passam pelo Composio.

| Cenário | Métricas/mês | Publicação/mês | Total/mês | % do gratuito |
|---|---|---|---|---|
| **Hoje**: só a Página (M ≈ 1), 3 posts | (1 + 3) × 31 ≈ 124 | 3 × 2 + `connection` ≈ 10 | **~140** | **0,14%** |
| Instagram conectado, ~10 posts antigos no IG, 3 posts/mês | (10 + 5,6 + 3 + 3) × 30 ≈ 650 | 3 × 6 ≈ 18 | ~700 | 0,7% |
| Depois de 12 meses no ritmo do calendário (N ≈ M ≈ 50) | (55,6 + 53) × 30 ≈ 3.260 | ≈ 24 | ~3.300 | 3,3% |
| Teto do projeto, 3 posts/dia, sustentado | +180 chamadas/dia a cada mês (90 posts no IG e 90 na Página) | ≈ 540 | 70% em ~13 meses | — |

O que mais pesa é a métrica por post, que cresce com cada post publicado nos últimos 2 anos. No ritmo do calendário, o gratuito sobra. Os 70% só chegam com uns 1.150 posts no Instagram e outros tantos na Página dentro da janela de 2 anos, ou com o polling da fase 2: cada recurso consultado a cada 5 minutos custa ~8.600 chamadas/mês, então umas 8 consultas desse tipo, somadas ao resto, passam dos 70%.
