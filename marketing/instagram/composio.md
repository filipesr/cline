# Instagram e Facebook via Composio — fase 1

Levantamento feito em 15/10/2026: o que o Composio oferece para a conta Instagram e a Página do Facebook, o que foi testado (só leitura), limitações, triggers e como medir o consumo. Nada foi publicado, respondido ou apagado.

## Como a conexão foi feita

O plano era usar a integração do Cline (`sdk/packages/core/src/extensions/composio/`), que chama o Composio pelo proxy de conectores da Cline API. Isso não foi possível nesta máquina:

- não há conta Cline logada (`~/.cline/data/settings/providers.json` não tem `auth.accountId` no provider `cline`);
- `CLINE_COMPOSIO_BETA` é avaliada por conta no PostHog e precisa de `TELEMETRY_SERVICE_API_KEY`, que só os builds publicados trazem.

O caminho usado foi a **área de consumidor do Composio** (composio.dev → "For You"), onde as contas já estavam conectadas:

| | Valor |
|---|---|
| Endpoint MCP | `https://connect.composio.dev/mcp` (streamable HTTP) |
| Autenticação | header `x-consumer-api-key: ck_…` (copiar em **Connect my agent**) |
| Meta tools expostas | `COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_GET_TOOL_SCHEMAS`, `COMPOSIO_MANAGE_CONNECTIONS`, `COMPOSIO_WAIT_FOR_CONNECTIONS`, `COMPOSIO_MULTI_EXECUTE_TOOL`, `COMPOSIO_REMOTE_BASH_TOOL`, `COMPOSIO_REMOTE_WORKBENCH`, `COMPOSIO_SUBMIT_FEEDBACK`, `COMPOSIO_SEARCH_SKILLS`, `COMPOSIO_USE_SKILL`, `COMPOSIO_MANAGE_SKILL` |

São as mesmas meta tools de busca/conexão/execução que o proxy da Cline expõe, mas **as conexões não se transferem**. O Composio separa projeto de consumidor (chave `ck_`), projeto de desenvolvedor (chave `ak_`) e o projeto da Cline (chave no servidor). Quando a integração do Cline for usada, Instagram e Facebook precisam ser conectados de novo por lá.

### Contas conectadas

Estado em 15/10/2026, depois de focar na Party Share:

| Toolkit | Conta | Status | Observação |
|---|---|---|---|
| `facebook` | Filipe Salvarez Rezende (perfil) | ACTIVE | Dá acesso às Páginas **Party Share** (foco) e **il Burger**, com todas as tarefas (MANAGE, CREATE_CONTENT, MODERATE, MESSAGING, ANALYZE, ADVERTISE). |
| `instagram` | — | INITIATED | Tentativa de conectar o Instagram da Party Share. Não concluída (senha). Pendente. |

O `@f.s.rezende` (conta Creator pessoal, conectada por **Instagram Login** em `graph.instagram.com`) foi usado nos testes de Instagram abaixo e depois **removido**. Os testes de Instagram precisam ser repetidos com a conta da Party Share quando ela for conectada.

Nenhuma Página retornou `instagram_business_account`, ou seja, **nenhum Instagram está ligado a uma Página**. Com Instagram Login isso não é necessário para ler posts, insights e DMs, mas as ações "via Página" (por exemplo `INSTAGRAM_GET_PAGE_CONVERSATIONS`) só funcionam com esse vínculo.

Permissões concedidas ao Facebook: `pages_show_list`, `pages_read_engagement`, `pages_read_user_content`, `pages_manage_posts`, `pages_manage_engagement`, `pages_manage_metadata`, `pages_messaging`, `read_insights`, `business_management`, `email`, `public_profile`.

## Party Share (Página do Facebook em foco)

Leitura feita em 15/10/2026 com `FACEBOOK_GET_PAGE_DETAILS`, `GET_PAGE_POSTS`, `GET_PAGE_INSIGHTS`, `GET_PAGE_CONVERSATIONS` e `GET_PAGE_ROLES`:

| | |
|---|---|
| Página | Party Share — formato novo de Páginas (tem perfil próprio), criada por volta de 23/09/2026 |
| Categoria / site | Product/service — `http://partyshare.me/` |
| Sobre / descrição / contato | Vazios |
| Seguidores | 0 (insights de 16/09 a 14/10 confirmam: sem variação) |
| Posts | 1 (atualização da foto de perfil, 23/09/2026) |
| Instagram ligado | Nenhum |
| Inbox do Messenger | Vazia |
| Administradores | 1 (Filipe), com todas as tarefas |

O que dá para fazer nela pelo Composio:

- **Já validado (leitura):** posts, métricas da Página e dos posts, inbox do Messenger, papéis.
- **Validado no teste de 15/10 (ver abaixo):** publicar texto, ler comentários, responder como a Página, ler reações e apagar o post.
- **A validar quando houver conteúdo:** insights por post com dados reais.
- **Escrita disponível, ainda não testada:** preencher o perfil (`FACEBOOK_UPDATE_PAGE_SETTINGS`); publicar texto/link, foto, várias fotos ou vídeo; **agendar** (`scheduled_publish_time`) e reagendar; editar/apagar posts; responder, ocultar e apagar comentários; enviar mensagens no Messenger (só por consulta periódica, sem triggers).

Para o Instagram da Party Share: a conta precisa ser **Profissional** (Business/Creator). Vale **ligá-la à Página** na Central de Contas da Meta (inbox unificada, publicação cruzada) e conectá-la no Composio como conta adicional do toolkit `instagram` (o Composio aceita várias contas por toolkit; cada chamada escolhe uma pelo parâmetro `account`).

## Ações disponíveis

O toolkit Instagram tem 40 ações e o Facebook 53 (catálogo em docs.composio.dev/toolkits). Os parâmetros abaixo vêm dos schemas devolvidos por `COMPOSIO_SEARCH_TOOLS`; os marcados com * são obrigatórios. As ações sem parâmetros listados não tiveram o schema completo consultado.

### Instagram — leitura

| Slug | Parâmetros principais | Para quê |
|---|---|---|
| `INSTAGRAM_GET_USER_INFO` | `ig_user_id` (`"me"`), `fields` | Perfil: nome, bio, seguidores, nº de mídias |
| `INSTAGRAM_GET_IG_USER_MEDIA` | `ig_user_id`* (`"me"`), `fields`, `limit`, `since`, `until`, `after` | Lista posts (paginado) |
| `INSTAGRAM_GET_IG_MEDIA` | `ig_media_id`*, `fields` | Detalhe de um post |
| `INSTAGRAM_GET_IG_MEDIA_CHILDREN` | — | Itens de um carrossel |
| `INSTAGRAM_GET_IG_MEDIA_COMMENTS` | `ig_media_id`*, `fields`, `limit`, `after` | Comentários de um post |
| `INSTAGRAM_GET_IG_COMMENT_REPLIES` | `ig_comment_id`*, `fields`, `limit` | Respostas a um comentário |
| `INSTAGRAM_GET_IG_MEDIA_INSIGHTS` | `ig_media_id`*, `metric`* (array: `views`, `reach`, `saved`, `likes`, `comments`, `shares`, `total_interactions`…), `breakdown` | Métricas de um post (sempre `lifetime`) |
| `INSTAGRAM_GET_USER_INSIGHTS` | `metric` (array: `reach`, `views`, `accounts_engaged`, `total_interactions`, `profile_views`, `follower_count`, `*_demographics`…), `period` (`day`/`lifetime`), `metric_type` (`total_value`/`time_series`), `since`, `until`, `timeframe`, `breakdown` | Métricas da conta |
| `INSTAGRAM_GET_IG_USER_STORIES` | — | Stories ativos (24h) |
| `INSTAGRAM_GET_IG_USER_LIVE_MEDIA` | — | Live em andamento |
| `INSTAGRAM_GET_IG_USER_TAGS` | — | Mídias em que a conta foi marcada |
| `INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT` | `ig_user_id`, `since` | Cota de publicação (24h) |
| `INSTAGRAM_GET_MULTIPLE_NODES` | — | Mesmos campos para vários IDs |
| `INSTAGRAM_LIST_ALL_CONVERSATIONS` | `limit`, `fields`, `user_id`, `after` | Conversas de DM |
| `INSTAGRAM_LIST_ALL_MESSAGES` | `conversation_id`*, `fields`, `limit` | Mensagens de uma conversa |
| `INSTAGRAM_GET_CONVERSATION` | — | Detalhe de uma conversa |
| `INSTAGRAM_GET_PAGE_CONVERSATIONS` | `ig_user_id`*, `platform`, `limit` | DMs via Página ligada (exige vínculo com Página) |
| `INSTAGRAM_GET_MESSENGER_PROFILE` | — | Ice breakers / menu de DM |
| `INSTAGRAM_LIST_SUBSCRIBED_APPS` | — | Apps inscritos em webhooks da conta |

### Instagram — escrita (não testadas)

| Slug | Parâmetros principais | Para quê |
|---|---|---|
| `INSTAGRAM_POST_IG_USER_MEDIA` | `ig_user_id`*, `image_url` / `video_url` / `image_file` / `video_file` / `children`, `media_type` (`REELS`, `CAROUSEL`, `STORIES`), `caption`, `user_tags`, `alt_text`, `cover_url`, `location_id`, `share_to_feed` | Passo 1 da publicação: cria o container |
| `INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH` | `ig_user_id`*, `creation_id`*, `max_wait_seconds` | Passo 2: publica o container (espera o processamento) |
| `INSTAGRAM_CREATE_CAROUSEL_CONTAINER` | `ig_user_id`*, `child_image_urls` / `child_video_urls` / `children`, `caption` | Carrossel de 2–10 itens em uma chamada |
| `INSTAGRAM_POST_IG_MEDIA_COMMENTS` | `ig_media_id`*, `message`* | Comentar num post |
| `INSTAGRAM_POST_IG_COMMENT_REPLIES` | — | Responder a um comentário |
| `INSTAGRAM_POST_IG_USER_MENTIONS` | — | Responder a menções |
| `INSTAGRAM_DELETE_COMMENT` | — | Apagar comentário |
| `INSTAGRAM_SET_MEDIA_COMMENT_ENABLED` | — | Ligar/desligar comentários de um post |
| `INSTAGRAM_SEND_TEXT_MESSAGE`, `INSTAGRAM_SEND_IMAGE` | — | Enviar DM |
| `INSTAGRAM_MARK_SEEN` | — | Marcar DM como lida |
| `INSTAGRAM_UPDATE_MESSENGER_PROFILE`, `INSTAGRAM_DELETE_MESSENGER_PROFILE` | — | Ice breakers / menu de DM |
| `INSTAGRAM_ENABLE_WEBHOOK_SUBSCRIPTIONS` | — | Inscreve campos de webhook da conta (ver Triggers) |

Deprecadas, que não devem ser usadas: `INSTAGRAM_CREATE_MEDIA_CONTAINER`, `INSTAGRAM_CREATE_POST`, `INSTAGRAM_GET_POST_COMMENTS`, `INSTAGRAM_GET_POST_INSIGHTS`, `INSTAGRAM_GET_POST_STATUS`, `INSTAGRAM_GET_USER_MEDIA`, `INSTAGRAM_REPLY_TO_COMMENT`.

### Facebook (Página) — leitura

| Slug | Parâmetros principais | Para quê |
|---|---|---|
| `FACEBOOK_LIST_MANAGED_PAGES` | `fields`, `limit`, `after` | Páginas que o usuário administra |
| `FACEBOOK_GET_PAGE_DETAILS` | `page_id`*, `fields` | Dados da Página (seguidores, IG ligado…) |
| `FACEBOOK_GET_PAGE_POSTS` | `page_id`*, `limit`, `since`, `until`, `fields` | Posts do feed da Página |
| `FACEBOOK_GET_POST` | `post_id`*, `fields` | Um post |
| `FACEBOOK_GET_COMMENTS` | `object_id`*, `fields`, `limit`, `order`, `filter` | Comentários de um post/comentário |
| `FACEBOOK_GET_COMMENT` | `comment_id`*, `fields` | Um comentário |
| `FACEBOOK_GET_POST_REACTIONS` | — | Reações de um post |
| `FACEBOOK_GET_PAGE_INSIGHTS` | `page_id`*, `metrics` (`page_follows`, `page_daily_follows_unique`, `page_media_view`, `page_post_engagements`…), `period` (`day`/`week`/`days_28`…), `since`, `until` (máx. 90 dias) | Métricas da Página |
| `FACEBOOK_GET_POST_INSIGHTS` | `post_id`*, `metrics` (`post_media_view`, `post_total_media_view_unique`), `period` | Métricas de um post |
| `FACEBOOK_GET_PAGE_PHOTOS`, `FACEBOOK_GET_PAGE_VIDEOS`, `FACEBOOK_LIST_VIDEO_THUMBNAILS` | — | Mídias da Página |
| `FACEBOOK_GET_PAGE_TAGGED_POSTS` | — | Posts que marcam a Página |
| `FACEBOOK_GET_SCHEDULED_POSTS` | — | Posts agendados |
| `FACEBOOK_GET_PAGE_CONVERSATIONS` | `page_id`*, `fields`, `limit` | Conversas do Messenger |
| `FACEBOOK_GET_CONVERSATION_MESSAGES` | `page_id`*, `conversation_id`*, `fields`, `limit` | Mensagens de uma conversa |
| `FACEBOOK_GET_MESSAGE_DETAILS` | — | Uma mensagem |
| `FACEBOOK_GET_PAGE_ROLES`, `FACEBOOK_LIST_PERMISSIONS`, `FACEBOOK_GET_CURRENT_USER`, `FACEBOOK_GET_GRAPH_OBJECT` | — | Papéis, permissões, token, leitura genérica |
| `FACEBOOK_SEARCH_PAGES`, `FACEBOOK_LIST_BUSINESSES`, `FACEBOOK_LIST_OWNED_PAGES`, `FACEBOOK_LIST_CLIENT_PAGES` | — | Descoberta de Páginas/negócios |
| `FACEBOOK_LIST_AD_ACCOUNTS`, `FACEBOOK_LIST_OWNED_AD_ACCOUNTS`, `FACEBOOK_LIST_ADS`, `FACEBOOK_GET_AD_INSIGHTS`, `FACEBOOK_SEARCH_GEOGRAPHIC_TARGETING_LOCATIONS` | — | Anúncios (fora do escopo) |

### Facebook (Página) — escrita (não testadas)

| Slug | Parâmetros principais | Para quê |
|---|---|---|
| `FACEBOOK_CREATE_POST` | `page_id`*, `message`*, `link`, `published`, `scheduled_publish_time`, `targeting` | Post de texto/link (permite agendar) |
| `FACEBOOK_CREATE_PHOTO_POST` | `page_id`*, `url` ou `photo`, `message`, `published`, `scheduled_publish_time` | Post com foto |
| `FACEBOOK_CREATE_MULTI_PHOTO_POST` | `page_id`*, `photo_urls`*, `message` | Post com várias fotos |
| `FACEBOOK_CREATE_VIDEO_POST` | `page_id`*, `file_url` ou `video`, `title`, `description`, `published`, `scheduled_publish_time` | Post com vídeo |
| `FACEBOOK_UPLOAD_PHOTOS_BATCH` | — | Até 50 fotos de uma vez |
| `FACEBOOK_UPDATE_POST`, `FACEBOOK_DELETE_POST`, `FACEBOOK_RESCHEDULE_POST`, `FACEBOOK_PUBLISH_SCHEDULED_POST` | — | Editar, apagar, reagendar, publicar agendado |
| `FACEBOOK_CREATE_COMMENT`, `FACEBOOK_UPDATE_COMMENT` (`is_hidden` oculta), `FACEBOOK_DELETE_COMMENT` | — | Comentar, editar/ocultar, apagar |
| `FACEBOOK_LIKE_POST_OR_COMMENT`, `FACEBOOK_UNLIKE_POST_OR_COMMENT` | — | Curtir |
| `FACEBOOK_SEND_MESSAGE` | `page_id`*, `recipient_id`*, `message_text`*, `messaging_type`, `tag` | Mensagem no Messenger |
| `FACEBOOK_SEND_MEDIA_MESSAGE`, `FACEBOOK_MARK_MESSAGE_SEEN`, `FACEBOOK_TOGGLE_TYPING_INDICATOR` | — | Messenger |
| `FACEBOOK_UPDATE_PAGE_SETTINGS`, `FACEBOOK_ASSIGN_PAGE_TASK`, `FACEBOOK_REMOVE_PAGE_TASK`, `FACEBOOK_REFRESH_URL_SCRAPE` | — | Administração da Página |

## O que foi testado

Todas as chamadas foram de leitura, por `COMPOSIO_MULTI_EXECUTE_TOOL`. O cliente de teste recusava, antes de enviar, qualquer slug cujo verbo não fosse `GET_`/`LIST_`/`FETCH_`/`SEARCH_`, e qualquer `MANAGE_CONNECTIONS` que não fosse `action: "list"`.

| Teste | Ação | Resultado |
|---|---|---|
| Conexões ativas | `COMPOSIO_MANAGE_CONNECTIONS` (`list`) | ✅ Instagram e Facebook ACTIVE |
| Dados da conta IG | `INSTAGRAM_GET_USER_INFO` (`me`) | ✅ Creator, 325 seguidores, 585 seguindo, 35 mídias |
| Últimos posts IG | `INSTAGRAM_GET_IG_USER_MEDIA` | ✅ 27 mídias retornadas (o perfil diz 35) com legenda, tipo, data, curtidas, nº de comentários e link |
| Comentários de um post IG | `INSTAGRAM_GET_IG_MEDIA_COMMENTS` (reel de 26/08/2023) | ✅ Comentários com texto, autor, data, curtidas e respostas aninhadas |
| Insights de um post IG | `INSTAGRAM_GET_IG_MEDIA_INSIGHTS` (post de 11/09/2025) | ❌ HTTP 400: *"The media was posted before the most recent time that the user's account was converted to a business account"* |
| Insights da conta IG (totais, 16/09–14/10) | `INSTAGRAM_GET_USER_INSIGHTS` (`total_value`) | ✅ reach 0, views 3, accounts_engaged 0, total_interactions 0, profile_views 0 |
| Seguidores por dia IG (01–14/10) | `INSTAGRAM_GET_USER_INSIGHTS` (`follower_count`, `time_series`) | ✅ Série diária de novos seguidores |
| Cota de publicação IG | `INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT` | ✅ 0 de 100 em 24h |
| DMs IG (só IDs e datas) | `INSTAGRAM_LIST_ALL_CONVERSATIONS` | ✅ Funciona via Instagram Login. O conteúdo das mensagens não foi lido |
| Páginas do FB | `FACEBOOK_LIST_MANAGED_PAGES` | ✅ il Burger e Party Share |
| Permissões do FB | `FACEBOOK_LIST_PERMISSIONS` | ✅ 11 permissões concedidas (lista acima) |
| Detalhes das Páginas / vínculo IG | `FACEBOOK_GET_PAGE_DETAILS` | ✅ Sem `instagram_business_account` nas duas |
| Posts da Página | `FACEBOOK_GET_PAGE_POSTS` (il Burger) | ✅ Posts com texto, mídia e link |
| Insights da Página (28 dias) | `FACEBOOK_GET_PAGE_INSIGHTS` | ✅ `page_follows` diário etc. |
| Insights de um post da Página | `FACEBOOK_GET_POST_INSIGHTS` | ✅ `post_media_view` 2, `post_total_media_view_unique` 1 |
| Comentários de um post da Página | `FACEBOOK_GET_COMMENTS` | ❌ Erro `#10`: pede `pages_read_user_content` ou "Page Public Content Access", embora a permissão apareça como concedida |
| Conversas do Messenger (só IDs) | `FACEBOOK_GET_PAGE_CONVERSATIONS` | ✅ Funciona |

## Teste de escrita na Página da Party Share (15/10/2026)

Um ciclo completo feito com a chave de consumidor (na época em `~/.config/composio/api_key`; hoje em `~/.config/cline-marketing/instagram.env`) pelo endpoint MCP, com o Filipe comentando e curtindo pelo perfil pessoal:

| Etapa | Ação | Argumentos | Resultado |
|---|---|---|---|
| Publicar | `FACEBOOK_CREATE_POST` | `page_id: "1351629444696145"`, `message`, `published: true` | ✅ post `1351629444696145_122115160641489529` |
| Permalink | `FACEBOOK_GET_POST` | `post_id`, `fields: "id,permalink_url"` | ✅ |
| Ler comentários | `FACEBOOK_GET_COMMENTS` | `object_id: <post_id>`, `filter: "stream"` | ✅ texto, autor e id do comentário |
| Responder como a Página | `FACEBOOK_CREATE_COMMENT` | `object_id: "<comment_id>"` (só o número), `message` | ✅ resposta com `from` = Party Share |
| Ver curtida na resposta | `FACEBOOK_GET_COMMENT` | `fields: "id,like_count,reactions.summary(total_count){name,type}"` | ✅ reação LOVE do Filipe |
| Apagar | `FACEBOOK_DELETE_POST` | `post_id` | ✅ o post, o comentário e a resposta somem; um `GET_POST` depois responde `#10` |

O que o teste ensinou:

- **Responder a um comentário exige o id do comentário sozinho.** O id que `GET_COMMENTS` devolve vem como `<postId>_<commentId>`. Passado assim, a ação lê o `<postId>` como id de Página e recusa: *"The requested Facebook Page with ID … was not found in your managed pages"*. Com só o `<commentId>`, funciona.
- **`like_count` só conta 👍.** Outras reações (❤️, 😂…) aparecem só em `reactions`. Para "alguém reagiu?", peça `reactions.summary(total_count)`.
- **O erro `#10` também quer dizer "o objeto não existe".** Depois de apagar o post, `FACEBOOK_GET_POST` respondeu com o mesmo `#10` (*"Object does not exist, cannot be loaded due to missing permission…"*). A falha de `GET_COMMENTS` na il Burger provavelmente não era falta de permissão: na Party Share, ler comentários funcionou.
- **A chave de consumidor (`ck_`) só funciona pelo MCP** (`connect.composio.dev/mcp`, header `x-consumer-api-key`). Ela não abre a API v3.1, que pede chave de projeto (`ak_`). Cada ação vai por `COMPOSIO_MULTI_EXECUTE_TOOL`, com o id da conta (`facebook_cerago-policy`) em `account`. O resultado volta em `data.results[0].response`.
- **Cuidado com `COMPOSIO_MANAGE_CONNECTIONS`.** `toolkits` é uma lista de objetos (`[{"name": "facebook", "action": "list"}]`). Passado como lista de nomes, a ação assume `action: "add"` e **abre um pedido de conexão novo**. Foi assim que surgiram, por engano, as conexões pendentes `facebook_arba-tho` e talvez `instagram_gant-gegg` (ver abaixo).
- **Os parâmetros de data variam de ação para ação.** `FACEBOOK_GET_PAGE_INSIGHTS` exige `since`/`until` como texto (`"1760497200"`). `INSTAGRAM_GET_USER_INSIGHTS` aceita número, mas não aceita `ig_user_id: "me"`: só id numérico ou nada, e nada quer dizer a conta conectada. A demografia (`follower_demographics`) exige `timeframe`, e só `this_week` e `this_month` ainda valem.
- **Consumo do teste:** 9 execuções de ação (publicar, ler, responder em duas tentativas, conferir, apagar), mais as meta tools de schema e de conexões.

### Conexões pendentes depois do teste

| Toolkit | Id | Status | Origem |
|---|---|---|---|
| `facebook` | `facebook_cerago-policy` (alias `filipe.rezende`) | ACTIVE, padrão | A conexão em uso |
| `facebook` | `facebook_arba-tho` | INITIATED/initializing | Aberta por engano no teste. Pode ser removida (`action: "remove"`) |
| `instagram` | `instagram_gant-gegg` | INITIATED/initializing | A tentativa anterior ou a aberta por engano. Para conectar a Party Share, gere um link novo |

## Limitações encontradas

- **Insights por post só existem para mídias publicadas depois da conversão para conta profissional.** Os posts atuais do `@f.s.rezende` são anteriores, então hoje não há insights por post. Os posts novos terão.
- **Posts com mais de 2 anos não têm insights** (regra da Meta descrita no schema). O schema também diz que é preciso ter ≥ 1.000 seguidores. Isso não foi confirmado: os insights da conta funcionaram com 325 seguidores, e o teste por post falhou por outro motivo.
- **Publicar exige mídia acessível pela Meta.** `image_url` / `video_url` precisam ser URLs **públicas** HTTP/HTTPS (imagem só JPEG, vídeo MP4) e precisam continuar acessíveis até o container ser processado. Há a alternativa `image_file` / `video_file`, mas ela espera um arquivo já no armazenamento do Composio (`s3key`), não um arquivo local. Na prática, a fase de publicação precisa de um lugar para hospedar as imagens.
- **Publicar no IG são dois passos:** `POST_IG_USER_MEDIA` cria o container e `POST_IG_USER_MEDIA_PUBLISH` publica. O container expira em menos de 24h. Vídeo/Reel leva de 30 a 120 s de processamento. `VIDEO` foi deprecado: use `REELS`. Carrossel tem de 2 a 10 itens.
- **Cota de publicação:** 100 posts por 24h (janela móvel) nesta conta. Dá para ler antes com `GET_IG_USER_CONTENT_PUBLISHING_LIMIT`.
- **Legenda:** o schema pede `#` codificado como `%23`. Comentários têm no máximo 300 caracteres e 4 hashtags.
- **O Instagram não está ligado a nenhuma Página.** As ações "via Página" do IG não se aplicam. Se a Página do Facebook for parte da estratégia, vale ligar o `@f.s.rezende` a ela (Central de Contas da Meta).
- **Comentários de posts da Página do FB falharam** com erro `#10` na il Burger. Na Party Share, ler e responder comentários funcionou (ver o teste acima); o `#10` da il Burger provavelmente vinha do objeto, não da permissão.
- **A Página "il Burger" está fechada** (último post em 2018), e a "Party Share" tem 0 seguidores. Definir qual Página entra no plano.
- **Métricas antigas do Facebook foram descontinuadas** em 15/11/2025 (`post_impressions`, `post_clicks`, `post_engaged_users`…). Agora são `post_media_view` e `post_total_media_view_unique`.
- **Contas pessoais não funcionam.** Os dois toolkits só aceitam IG Business/Creator e Páginas do FB.
- **Limites de taxa da Graph API** (erros 4/613) em chamadas em volume.

## Triggers (decide a fase 2)

**O Composio não oferece triggers para Instagram nem para Facebook.** O catálogo dos dois toolkits mostra **"Triggers: 0"**. Não há evento em tempo real de novo comentário, nova DM, menção ou mensagem no Messenger.

O que existe:

- **Polling por ações de leitura.** `INSTAGRAM_LIST_ALL_CONVERSATIONS` / `LIST_ALL_MESSAGES`, `INSTAGRAM_GET_IG_MEDIA_COMMENTS`, `FACEBOOK_GET_PAGE_CONVERSATIONS` / `GET_CONVERSATION_MESSAGES` e `FACEBOOK_GET_COMMENTS` funcionam e podem ser chamadas periodicamente, comparando com o último `updated_time` / ID visto. Cada consulta é uma chamada de ferramenta cobrada.
- **`INSTAGRAM_ENABLE_WEBHOOK_SUBSCRIPTIONS` / `INSTAGRAM_LIST_SUBSCRIBED_APPS`** inscrevem campos de webhook da conta para o **app da Meta usado pelo Composio**. Os eventos vão para esse app, não para um endpoint nosso. Sem trigger no Composio, isso sozinho não entrega eventos.

Conclusão para a fase 2: com o Composio, DMs e comentários automatizados só são viáveis **por polling**, com atraso e custo por consulta. Tempo real exigiria webhook próprio da Meta, ou seja, o conector nativo que está fora do escopo.

## Como medir o consumo

Hoje: `bun run usage` soma o que os jobs de publicação e métricas registram e projeta o mês; o aviso de 70% vai ao Telegram por um schedule. Ver README → "Consumo do Composio". O que segue é o levantamento de 15/10.

### Neste levantamento (área de consumidor, conta pessoal)

- O Composio cobra por **chamada de ferramenta**. Pela página de preços em 15/10/2026, o plano gratuito (Hobby) inclui 100 mil chamadas/mês e 50 mil execuções de trigger/mês. Excedente: US$ 0,0003 por chamada. Pro: US$ 29/mês em créditos. Fontes de terceiros citam números diferentes (20 mil, 50 mil): confirmar no painel.
- **Meta tools de busca são gratuitas** segundo a página de preços. Não está documentado se `COMPOSIO_MULTI_EXECUTE_TOOL` conta uma vez ou uma vez por ação interna; o conservador é contar por ação interna.
- Cada resposta traz um `log_id` (ex.: `log_9o4lvg5gG7JZ`), que é o identificador da execução nos logs do Composio.
- Para ver o consumo: no painel do composio.dev (área de faturamento/uso). Não confirmamos a tela exata da área de consumidor. Por API, a Usage API (contagens agregadas) e a Logs API (`POST /api/v3.1/logs/tool_execution`) exigem chave de projeto (`x-api-key`) ou de organização (`x-org-api-key`). Não foi possível consultá-las com a chave de consumidor.
- Uso deste levantamento: 1 `MANAGE_CONNECTIONS`, 2 buscas e 4 lotes de `MULTI_EXECUTE` com **18 ações** no total.

### Pelo proxy da Cline (integração do produto)

- A chave do Composio fica no servidor da Cline API, e o `user_id` do Composio é derivado da conta Cline (`apps/examples/desktop-app/sidecar/cline-connectors-api.ts`). O consumo cai no projeto Composio **da Cline**, não numa conta do usuário.
- O cliente no repositório não expõe cota nem uso. Os endpoints usados são `toolkits`, `connections`, `toolkits/{slug}/tools`, `tools/{slug}/execute`, `meta-tools/sessions` e `meta-tools/{slug}/execute`, e nenhum deles retorna contagem. Se houver cota por conta, ela é aplicada no servidor e só aparece como erro HTTP repassado pelo proxy (`Cline connectors proxy returned HTTP …`).
- Para medir: pedir ao time da Cline API os números do projeto Composio da Cline (Usage API / logs filtrados pelo `user_id` derivado da conta). Do lado do cliente, dá no máximo para contar as chamadas de ferramenta `composio-tools` nas sessões.

## Próximos passos sugeridos

1. Gerar uma nova chave de consumidor no Composio. A atual foi exposta durante este levantamento.
2. Preencher o perfil da Party Share (sobre, descrição, contato), que hoje está vazio.
3. Conectar o Instagram da Party Share (conta Profissional), ligá-lo à Página e repetir os testes de leitura de Instagram com ele.
4. Definir onde hospedar as imagens/vídeos públicos para publicação.
5. Quando a conta Cline com `CLINE_COMPOSIO_BETA` estiver disponível, reconectar Instagram e Facebook pela integração do Cline e repetir os testes de leitura.
