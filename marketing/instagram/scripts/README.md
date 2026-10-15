# Motor de imagens (FLUX.2 local)

Gera as imagens dos posts com **FLUX.2 klein 4B** rodando neste Mac via [mflux](https://github.com/filipstrand/mflux) (MLX). Não usa API paga nem LLM externo: o agente escreve as cenas e o script monta o resto a partir da campanha do projeto.

## Instalação

```sh
brew install uv
uv tool install --upgrade mflux        # testado com mflux 0.22.0
# baixa o modelo (~15 GB em ~/.cache/huggingface; sem login, licença Apache-2.0)
~/.local/bin/mflux-generate-flux2 --model flux2-klein-4b --prompt "test" --steps 4 --width 512 --height 512 --output /tmp/teste.png
```

Precisa de ~15 GB livres para o modelo, mais folga para o swap: com o disco cheio, o macOS mata o processo no meio da geração. O script usa o Python do próprio mflux (que já tem Pillow) para o JPEG final; defina `MFLUX_PYTHON` se ele não estiver em `~/.local/share/uv/tools/mflux/bin/python`.

## Modelo escolhido: klein 4B, bf16, 4 passos

| Variante (1088x1360, 4 passos, M4 Pro 48 GB) | Tempo por imagem¹ | Pico de memória MLX | Resultado |
|---|---|---|---|
| klein 4B bf16 | 36 s | 14,3 GB | referência |
| klein 4B q8 | 41 s | 14,3 GB | igual ao bf16 a olho |
| klein 4B q4 | 39 s | 14,3 GB | muda a forma do objeto |
| klein 4B bf16 + 1 imagem de referência | **63–72 s** | 14,4 GB | produto fiel à referência |
| FLUX.2 dev (32B) quantizado | — | — | não roda no mflux |

¹ Processo inteiro: carga do modelo (~7 s) + 4 passos + decodificação.

Por que não o **FLUX.2 dev**: o mflux 0.22 só implementa a família klein (4B, 9B, 9b-kv); o dev não tem comando nem pesos MLX. Além disso, o dev e o klein 9B estão sob a *FLUX Non-Commercial License* e são gated no Hugging Face, o que não serve para marketing, e o dev ocuparia mais de 60 GB. O **klein 4B** é Apache-2.0, cabe com folga nos 48 GB e com 4 passos já entrega foto editorial. Quantizar não compensou: o mflux quantiza na carga, então q8/q4 não reduzem o pico de memória nem o tempo neste chip, e o q4 perde fidelidade. Por isso, bf16.

Tempo médio no uso real, medido nos 2 posts do `exemplo-cline` (12 imagens com 1 referência): **66,8 s por imagem** (de 64,5 a 72,4 s). Um post com 3 variações leva ~3,5 min; um carrossel de 3 slides com 3 variações, ~10 min.

## Como rodar

Tudo é por projeto, em `marketing/instagram/projects/<projeto>/`: `campaign.md` (com a seção `## Direção visual`), `persona.md`, `contexto.md`, `assets/` e `posts/`. Nada é lido de outro projeto, e o script recusa um 4º post na mesma data.

1. **Pedido**: um JSON com `ideia`, `pilar`, `formato` (`post` | `carrossel` | `story`), `quantidade`, opcionalmente `proporcao` (`feed` 1080x1350 | `quadrado` 1080x1080; story é sempre 1080x1920), `variacoes` (padrão 3), `slug`, `data`, `seeds` e `referencias` (nomes em `assets/`; omitido = todos, `[]` = nenhum). Exemplos em `projects/exemplo-cline/pedidos/`.
2. **Brief**: o agente lê a campanha, a persona, a direção visual e os assets do projeto e escreve uma `cena` em inglês por imagem no pedido:
   ```sh
   bun marketing/instagram/scripts/imagens.ts brief exemplo-cline marketing/instagram/projects/exemplo-cline/pedidos/do-pedido-a-mudanca.json
   ```
3. **Gerar**: o prompt final é `cena` + regra de fidelidade às referências + continuidade de carrossel + o estilo da direção visual + "sem texto". O estilo sai de um bloco `` ```prompt `` na seção "Direção visual" (numerada ou não) ou, como no PartyShare, de um bloco-modelo com `[CENA: …]`: a cena entra no lugar dele, `[FORMATO: …]` vira a proporção e `[top|bottom]` fica com a primeira opção.
   ```sh
   bun marketing/instagram/scripts/imagens.ts gerar exemplo-cline marketing/instagram/projects/exemplo-cline/pedidos/do-pedido-a-mudanca.json
   ```
   Com fotos ou prints em `assets/`, usa `mflux-generate-flux2-edit --image-paths` (até 3 referências) para o produto não ser inventado. Num carrossel, todos os slides usam as mesmas seeds e referências, então `v2` de todos os slides forma um conjunto coerente. O resultado fica em `posts/<data>-<slug>/`: `NN-vK.jpg`, `prompts/NN.txt` e `post.json` com seeds, parâmetros, hash das fontes e o comando exato de cada variação (rodado em `marketing/instagram/`, refaz a imagem igual).
4. **Revisar**: monta `revisao.jpg` (folha de contato) e lista os critérios de descarte. O agente abre as variações, compara com `assets/` e escolhe:
   ```sh
   bun marketing/instagram/scripts/imagens.ts revisar exemplo-cline <pasta-do-post>
   bun marketing/instagram/scripts/imagens.ts escolher exemplo-cline <pasta-do-post> \
     --escolha v2 --motivo "..." --descartar "01-v1=motivo" --descartar "01-v3=motivo"
   ```
   `--escolha` aceita `v2` (todas as imagens) ou `01=v2,02=v2,03=v1`. A escolha, o motivo e os descartes vão para `post.json`, e as imagens escolhidas são copiadas para `final/NN.jpg`, conferidas como JPEG sRGB, abaixo de 8 MB e nas dimensões exatas.

Para refazer um post com as mesmas seeds: adicione `"seeds": [...]` ao pedido (copiadas do `post.json`) e rode `gerar ... --forcar`.
