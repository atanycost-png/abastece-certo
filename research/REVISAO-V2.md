# REVISÃO ADVERSARIAL DA V2 — Abastece Certo

**Revisor:** `revisor` (auditor independente)
**Data:** 17/10/2026
**Alvo:** working tree de `F:\WorkSpace DSH\abastece-certo` no momento da revisão (v2 ainda **não commitada**: `index.html`, `sw.js`, `README.md`, `REFERENCIA.md` aparecem como `M`; `tools/`, `icons/`, `manifest.webmanifest` como `??`). Se o Lead commitar depois, conferir o hash.
**Escopo:** revisão, não implementação — nada de produção foi alterado; escrita apenas em `research/`.
**Harness reproduzível:** `node research/review-v2.mjs` (96 checagens; 21 falhas = os achados abaixo; roda DOM stub + SW em `node:vm`, sem dependências).

## 1. Comandos pedidos

| Comando | Resultado |
|---|---|
| `node tools/test.mjs` | **OK — 122/122 testes** (exit 0) |
| `node tools/check.mjs` | **OK — 43/43 verificações** (exit 0), **1 aviso** não bloqueante (manifest sem screenshots). `REFERENCIA.md:98` já foi atualizado para 43 no working tree; a seção "Verificação realizada" (`REFERENCIA.md:105`) ainda diz "41/41 (2 avisos)" — doc parcialmente desatualizado (P2) |

Não rodei `tools/visual-check.mjs` (instrução do Lead; exige Edge fora do sandbox). Portanto **não validei** screenshots, overflow visual real, instalação PWA real, offline em modo avião nem leitores de tela. SW foi validado por simulação de runtime (Cache/fetch/activate/update) no harness, não em navegador.

## 2. Veredito

**Nenhum P0 novo encontrado.** O caminho crítico está bom: os dois modos calculam certo, a regra "empate = texto = cor" está consistente (250 casos aleatórios no harness, incluindo amostra ampla de limites), `NaN/Infinity` não chegam ao DOM (formatadores têm guarda; valores extremos viram `—`), migração v1 lê preços, XSS por **nome** de veículo está escapado, `aria-live` do resultado funciona com debounce, contraste WCAG corrigido (placeholder 5,18:1; borda de controle 3,11:1), `file://` calcula sem SW, e o SW v2 (network-first, precache tolerante, limpeza por prefixo, update com `SKIP_WAITING` sob confirmação) passou nos 19 cenários simulados.

**3 P1** e uma lista de P2 (abaixo). O mais importante é o parser: a suíte codifica `"1.234" → 1234`, o que faz preços de bomba com **três casas digitados com ponto** virarem milhares.

## 3. P1 — corrigir/decidir antes de entregar

### P1-1 — Parser: preço com 3 casas e ponto decimal vira milhar (`index.html:540`)

- **Entrada:** gasolina `5.899`, etanol `4,099` (ou gasolina `5.899` e etanol `4.099`).
- **Saída atual:** `5.899` → **5899**; resultado "ETANOL" com índice "0,1%" / "71,9 p.p. abaixo", warnings de preço fora da faixa e relação fora de 50–100%. No caso dos dois com ponto o índice fica correto por escala, mas o app exibe/salva R$ 5.899,00/L.
- **Deveria:** interpretar como R$ 5,899 (preço plausível) ou pedir confirmação; nunca tratar como 5899 sem bloqueio. Preços de bomba com 3 casas existem; `parseNumber("5,899")` já dá 5.899, então o problema é só o ponto.
- **Causa:** `else if (/^\d{1,3}(\.\d{3})+$/.test(s))` (`index.html:540`) trata qualquer `d.ddd` como milhar. O teste `["1.234", 1234]` (`tools/test.mjs:126`) oficializa a ambiguidade.
- **Sugestão:** em campos de preço/consumo, se a leitura "milhar" resultar em valor implausível (> 99,99 R$/L ou > 99,9 km/L) e a leitura "decimal" for plausível, preferir a decimal (e/ou mostrar confirmação "você quis dizer 5,899?"). Testar `"5.899"`, `"5.890"`, `"4.099"`, `"1.234"`, `"12.345"`.

### P1-2 — Slider sem foco visível (`index.html:147-151` vs `index.html:53`)

- **Entrada:** navegação por teclado (Tab até o slider de limite, setas).
- **Acontece:** `:focus-visible { outline: 2px … }` (especificidade 0,1,0) perde para `input[type=range] { outline: none }` (0,1,1); não existe regra `input[type=range]:focus/:focus-visible`. O slider fica **sem nenhum indicador de foco** — WCAG 2.4.7 (AA) e o README promete "foco visível".
- **Deveria:** `input[type=range]:focus-visible { outline: 2px solid var(--blue-soft); outline-offset: 6px; }` (ou não remover o outline).
- **Bônus:** o elemento do slider tem 6 px de altura (trilho) e thumb 24 px; área de toque efetiva é pequena (WCAG 2.5.8/2.5.5). README também promete "alvos de toque de 44 px", mas share=40 px, update=34 px e `<summary>`=28 px (`index.html:239,245,280`).
- **Evidência:** harness seção I ("slider tem regra de foco própria" = FAIL).

### P1-3 — Migração v1→v2 herda limite 70 sem aviso (`index.html:777`)

- **Entrada:** usuário que usou a v1 (`localStorage.ac_gas/ac_eta/ac_threshold`; a v1 persistia o limite 70 no primeiro uso).
- **Acontece:** migração copia `ac_threshold=70` para a v2; o default novo é **72% (E32)** (`index.html:754`), e README/rodapé dizem que a referência é E32/72. O usuário migrado segue decidindo com a regra antiga E30/E25 (70%) sem nenhum aviso; na faixa 70–72% a recomendação muda (v1 diz gasolina, referência E32 diz etanol).
- **Deveria:** decisão explícita — migrar 70→72 na primeira migração (ou mostrar um aviso único "atualize para 72%, E32") e documentar no REFERENCIA. Não é crash; é decisão de produto com impacto na recomendação.
- **Evidência:** harness seção A ("migração v1: limite 70 preservado" e FAIL "deveria virar 72").

## 4. P2 — correções rápidas / higiene

| # | Achado | Evidência |
|---|---|---|
| P2-1 | `ac.v2.threshold = null` ou `""` → `Number(...)===0` → clamp **55** (mínimo) em vez do default 72; valor corrompido muda a decisão para sempre | `index.html:785-786`; harness A |
| P2-2 | `id` do veículo é interpolado **sem escape** em `<option value="…">` (nome é escapado corretamente). Só explorável com `localStorage` adulterado (não é vetor remoto), mas é defesa em profundidade | `index.html:1071`; harness B |
| P2-3 | "seu carro" mostra **71,7%** mas aplica **71,5%** (arredonda o `data-t` para múltiplo de 0,5 e mantém o rótulo com 1 decimal) | `index.html:1000-1001,1007-1015`; harness C |
| P2-4 | Veículo com consumo em notação científica (`0,0000001` → `1e-7`) é salvo, mas o filtro do `loadState` usa `parsePositive` no número (vira string `"1e-7"`, inválida) e o veículo **desaparece no reload**; `toInputValue` também devolve `"1e-7"` nesses casos | `index.html:569-572,787-789,1088-1089`; harness C |
| P2-5 | Atalho/instalação `?modo=preciso`: a query força o modo **em todo reload**, ignorando o modo salvo quando o usuário volta para Rápido (o URL não é limpo via `history.replaceState`) | `index.html:1249-1254`; harness C |
| P2-6 | Sem limite duro de preço/consumo: `gasolina 0,000000001` + `etanol 5` gera big **"500.000.000.000,0"** (17 chars) que provavelmente estoura o card; só há warnings brandos. (Infinity/NaN literais não aparecem — formatadores devolvem `—`; bom.) | `index.html:179-180,670-690,890-897`; harness C |
| P2-7 | Primeira visita recarrega a página sozinha: `clients.claim()` no activate (`sw.js:49`) dispara `controllerchange` e o app chama `location.reload()` sem consentimento (`index.html:1239-1243`); pode interromper digitação/scroll (estado é salvo a cada tecla, então não perde dados) | harness E; `index.html:1239` |
| P2-8 | Erro de campo não é anunciado: a dica muda (`aria-invalid` + texto), mas `#live` é limpo no caso inválido (`announce("")`), e `.hint` não é `aria-live`/`role=alert` — usuário de leitor de tela digitando `abc` não ouve o erro | `index.html:826-837,949-984`; harness A |
| P2-9 | Barra "Nova versão disponível" não é anunciada (sem `role=status`/`aria-live`) e fica no fim do DOM; leitor de tela/teclado pode não perceber | `index.html:465-468,1212-1221`; harness I |
| P2-10 | Slider sem `aria-valuetext` ("72 por cento"); leitor anuncia só "72" | `index.html:362-363`; harness I |
| P2-11 | `README.md:25` promete "foco visível" e "alvos de toque de 44 px" — slider sem foco (P1-2) e 40/34/28 px nos botões/secundários | `README.md:25`; `index.html:239,245,280` |
| P2-12 | Fronteira exata ±0,5 p.p. ainda decidida por float: ex. `6,0000 / 3,2700 / 55%` → diff `-0.499999999999993` → **empate**, mas a regra documentada (`< 0,5`) diz ETANOL; 12 de 122 fronteiras exatas divergem com strings pt-BR | `index.html:583,612`; harness G |
| P2-13 | Texto do aviso de consumo diz "o carro costuma rodar **65–80%**", mas a condição é `cr < 0.55 || cr > 0.85` — consumo de 58% não gera aviso embora esteja fora do texto | `index.html:683-686`; harness G |
| P2-14 | `100vh` (barras móveis), sem `forced-colors` (alto contraste do SO), `orientation: portrait` no manifest — polimento/robustez | `index.html:46`; `manifest.webmanifest`; harness I |
| P2-15 | `REFERENCIA.md` parcialmente desatualizado: seção "Verificação realizada" (`:105`) diz "41/41 (2 avisos)" vs 43/1 atuais (a lista `:98` já foi corrigida); "`index.html` ~49 KB" vs 53,7 KB; diz "fronteiras de empate" testadas, mas o teste só cobre ±0,4/±0,6 p.p. | `REFERENCIA.md:105-107,97`; harness I |
| P2-16 | `staleWhileRevalidate` faz `cache.put(...)` sem `await/catch`; um `QuotaExceededError` vira rejeição não tratada (console), embora o asset ainda seja servido | `sw.js:78-89` |
| P2-17 | `navigator.share` existindo e rejeitando não cai para clipboard (catch vazio) — usuário toca "Compartilhar" e não acontece nada | `index.html:1179-1195` |
| P2-18 | `toast` e `update-bar` usam a mesma posição `fixed` no rodapé; quando ambos aparecem, se sobrepõem | `index.html:263-280,463-468` |
| P2-19 | Migração v1 no primeiro deploy: a v1 está em cache-first e não tem UI de update; a primeira visita pós-deploy ainda mostra a v1 (pageold) e só fecha/recarrega depois; documentar no release/REFERENCIA | `sw.js` v2 + comportamento v1; harness E |
| P2-20 | `VERSION` do SW é bump manual; `check.mjs` só valida o formato, não que a versão mudou desde o último deploy. Processo (P2) | `sw.js:12`; `tools/check.mjs:130-134` |

## 5. O que a suíte NÃO cobre (lacunas de teste)

1. **Domínio/DOM/integração:** `tools/test.mjs` só testa o CORE puro; `tools/check.mjs` é estático. Ficaram fora: migração v1→v2, `localStorage` corrompido/bloqueado, XSS pelo perfil (nome/id), modo via `?query`, `aria-live`/erros anunciados, update bar/`SKIP_WAITING`, `file://`, preset "seu carro", overflow de números extremos. Todos os achados P1/P2 desta revisão vieram de um harness DOM externo (`research/review-v2.mjs`), não do gate.
2. **Service worker em runtime:** o gate só checa regex/arquivos do `sw.js`; não testa install tolerante a 404, `activate` apagando só prefixo, network-first/SWR/offline, cross-origin, `SKIP_WAITING`. O harness cobre 19 cenários; vale incorporar (sem navegador) ao `tools/test.mjs` ou a um `tools/test-sw.mjs`.
3. **Fronteira exata do EPS:** testes existem para ±0,4 e ±0,6 p.p., não para `|diff| = 0,5` (a regra é `<`, mas o float decide; 12/122 divergem). O invariavel atual é auto-referente (usa a mesma comparação) e não pega isso.
4. **Parser de 3 casas com ponto:** os testes fixam `"1.234" → 1234` e não exercitam `"5.899"`/`"5.890"`/`"4.099"` no fluxo de preço — exatamente o caso P1-1.
5. **A11y automatizável:** sem checagem de foco visível (CSS), contraste, alvos de toque, `aria-valuetext`, anúncio de erro/update; `check.mjs` valida labels/ARIA estáticos, mas não o comportamento.
6. **PWA real:** sem validação de MIME do `.webmanifest` no host final (GitHub Pages), instalação real, offline em dispositivo, update de SW em navegador. `visual-check.mjs` (Edge) cobre parte, mas não roda neste ambiente e não é gate CI.
7. **Docs:** nenhum teste garante que contagens de testes/avisos/tamanho citados em README/REFERENCIA batem com a execução (hoje não batem).

## 6. Pontos fortes confirmados (para não regredir)

- CORE isolado e testável; `fastResult`/`preciseResult` consistentes; `gapText` derivado do veredito (não repete o bug da v1); gauge pinta pelo veredito; `fmtNum` normaliza `-0` e protege `NaN/Infinity`.
- `parseNumber` rejeita fullwidth, `0x10`, `1e3`, letras e separadores duplicados; aceita `R$`, milhar BR/en-US e unidades `km/L`/`reais`.
- PWA: manifest estático com PNGs 192/512/maskable reais + apple-touch-icon 180; metas iOS; `start_url`/`scope` relativos (subpasta GH Pages); SW versionado, network-first, precache com `cache:"reload"`, limpeza por prefixo, update sob confirmação.
- A11y: labels em todos os campos, abas ARIA com roving tabindex, `aria-pressed` em presets/preset do carro, `aria-live` do resultado com debounce, contraste corrigido, `prefers-reduced-motion`, `color-scheme`, safe-area, fontes ≥16 px (sem zoom iOS).
- `file://` funciona sem SW/localStorage (try/catch) e o SW é guardado por `location.protocol !== "file:"`.
- Privacidade: zero requisições externas; dados só em `localStorage`.

## 7. Limitações desta revisão

- Sem navegador real/leitor de tela; conclusões de foco/overflow/hit-area vêm de CSS/spec e do harness DOM.
- Não rodei `tools/visual-check.mjs` (proibido nesta rodada).
- SW testado por simulação de runtime, não em Chrome/Safari.
- Itens P2-7 (reload na 1ª visita), P2-19 (migração SW v1) e P2-6 (overflow) merecem confirmação em Chrome Android/iPhone antes de decidir severidade final.
