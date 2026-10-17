# REFERENCIA — Abastece Certo (etanol × gasolina)

Documento de referência do projeto. Atualizar no mesmo dia de cada mudança, com histórico datado.

---

## 14/10/2026 — Criação (v1)

### Objetivo
Web app (PWA) que ajuda motoristas a decidir entre abastecer com etanol ou gasolina.

### Decisões tomadas
- **Formato:** PWA em arquivo HTML único (`index.html`) + `sw.js` (service worker opcional). Sem backend, sem build, sem framework. Offline-first.
- **Escopo v1:** apenas a **regra rápida do 70/71%** (só preços). O usuário rejeitou, nesta v1: cálculo preciso por consumo real, perfil do veículo (localStorage), e preços ao vivo da ANP (ficam para v2).
- **WSL: não usado.** Para HTML estático não há build/servidor/runtime Linux. WSL só entraria se v2 puxar preço da ANP com backend.

### Fatos técnicos (fonte: Fecombustíveis / O Estado de S. Paulo, 263643)
- Etanol hidratado tem **~70% do poder calorífico** (energia por litro) da gasolina C → origem da "regra dos 70%".
- Desde **ago/2025** a gasolina brasileira é **E30** (30% de etanol anidro; antes E27). Isso reduziu levemente a energia/litro da gasolina → referência sobe para **~71%** (Rogério Gonçalves, AEA).
- A regra é **aproximação**: o limiar real depende do motor (taxa de compressão, injeção, turbo, calibração) e do uso. Relação C_etanol/C_gasolina típica: 0,70–0,78.
- **Fórmula exata:** `P_etanol/P_gasolina < C_etanol/C_gasolina` (custo por km). A regra dos 70% é o caso C_etanol/C_gasolina = 0,70.

### Implementação
- `index.html`: ~17 KB, HTML+CSS+JS inline. Tema escuro, mobile-first (max-width 460px), gauge visual 60–80%.
- Parse de preço pt-BR: aceita "5,89", "5.89", "1.234,56" (vírgula = decimal; ponto = milhar quando há vírgula).
- Persistência leve em `localStorage` (últimos preços + limite) — só isso, sem "perfil".
- Empate técnico: |índice − limite| < 0,5 p.p.
- PWA sem arquivos extras: favicon/apple-touch-icon e `manifest` gerados em runtime via `data:` URI (encodeURIComponent); `sw.js` é o único arquivo adicional (service worker não aceita data:/blob:).

### Verificação (realizada)
- Lógica testada no Node: 5 casos (etanol/gasolina/empate/milhar/vazio) → corretos.
- `node --check` no `<script>` inline → sintaxe OK.
- Checagem IDs/selectores e balanço de tags → OK.

### Pitfalls
- `browser_exec` com `local=true` **falha** porque o navegador padrão do Ruan é **Firefox** (não-Chromium). Para testar renderização local, servir e usar backend não-local, ou usar Chromium.
- Service worker **não registra** em `file://` (só http/https). Por isso o registro é guardado por `location.protocol !== "file:"`.
- `manifest` em `data:` URI precisa de `encodeURIComponent`; nunca montar JSON com `#`/espaço crus.
- Não inventar "economia em R$" no modo rápido: isso exigiria supor consumo (justamente o que a reportagem diz ser impreciso).

### Fonte primária
https://www.fecombustiveis.org.br/noticia/etanol-ou-gasolina-entenda-como-a-regra-dos-70-pode-fazer-voce-perder-dinheiro/263643

### Próximos passos (backlog v2)
- Modo preciso por consumo real (km/L de cada combustível).
- Perfil do veículo (localStorage).
- Preços ao vivo da ANP (Sistema de Levantamento de Preços — exige backend/proxy CORS; aí sim considerar WSL ou função serverless).
- Ícone PNG 192/512 px para instalação PWA mais bonita (hoje usa SVG "any").

---

## 17/10/2026 — v2 completa (pesquisa independente + auditoria da v1 + reescrita)

### Contexto e método
Trabalho executado com dois agentes independentes em paralelo:
- **pesquisador** → `research/FINDINGS.md`: física, mistura vigente, dados da ANP, ecossistema GitHub, PWA/a11y. Todas as URLs abertas em 17/10/2026.
- **revisor** → `research/AUDITORIA.md`: auditoria adversarial da v1 congelada (`2dd8ab6`), com 19 bugs reproduzíveis, matriz de testes e lista P0.

Decisão central mantida: **o app continua um arquivo único, zero dependências, zero build**. Nenhuma biblioteca foi adotada (ver §Ecossistema).

### Descobertas da pesquisa que mudaram o produto
1. **A mistura vigente em out/2026 é E32, não E30.** Resolução CNPE nº 9/2026, de 30/07/2026, em vigor desde 01/08/2026, por 180 dias prorrogáveis uma vez; **a gasolina premium continua E25**. O par 70%/71% da v1 estava defasado.
   → default do modo rápido passou a **72%** (faixa defensável 71–73%), com presets **E32 (72%)**, **E30 (71%)** e **E25 premium (70%)**.
2. **A regra dos 70% é heurística de consumo, não igualdade de energia.** Etanol hidratado ≈ 66% da energia por litro da gasolina pura e ≈ 73% da gasolina C; motores flex ganham eficiência com etanol. O texto do app foi corrigido (antes dizia "70% da energia").
3. **Preços ao vivo da ANP são inviáveis em site estático:** XLSX/ZIP/PDF servidos **sem `Access-Control-Allow-Origin`**, sem API JSON pública; o resumo semanal é XLSX de ~297 KB e a série histórica é um CSV de 72 MB.
   → o app exibe **médias de referência com data** (semana 04–10/10/2026: gasolina R$ 6,54/L, etanol R$ 4,14/L) e o usuário digita o preço do posto.
4. **Consumo PBEV/Inmetro:** razão etanol/gasolina de 0,70–0,74 nos flex eficientes; placeholders do modo preciso viraram 12,0 / 8,6 km/L.
5. **Ecossistema:** nenhuma dependência de runtime se paga. gzip medido: Alpine 15,8 KB, Preact+htm 5,4 KB, Lit ~5–7 KB, Chart.js 68,4 KB, uPlot 21,6 KB, workbox-window 1,3 KB, just-validate 6,9 KB — contra um app inteiro de ~58 KB sem nenhuma delas.
6. **Instalabilidade:** service worker **não** é requisito no Chrome/Edge (manifest + ícones 192/512 + HTTPS bastam); `maskable` e `screenshots` são recomendados. O SW existe por offline, não por instalação.

### O que mudou no código
- **Dois modos** (`Rápido` e `Preciso`) com abas ARIA completas (roving tabindex, setas, Home/End).
- **Modo preciso** completo: custo por km, custo por 100 km, economia por 100 km, limite pessoal, preço de equilíbrio do etanol e da gasolina, consumos em L/100 km.
- **Perfil de veículo** em `localStorage`: nome + consumos, múltiplos veículos, salvar/excluir, limite pessoal vira preset do modo rápido.
- **PWA de verdade**: `manifest.webmanifest` estático, PNGs 192/512 + maskable + apple-touch-icon (gerados por `tools/make-icons.py`), favicon SVG.
- **Service worker v2**: cache versionado por prefixo, `network-first` na navegação, `stale-while-revalidate` nos estáticos, precache tolerante a 404, limpeza só dos caches do próprio app, `sw.js` nunca cacheado, atualização **sob confirmação** (barra "Nova versão disponível" → `SKIP_WAITING` → `controllerchange` → reload).
- **Acessibilidade**: `aria-live` persistente com `role="status"` e debounce, regiões vivas para erro de campo e aviso de atualização, labels em todos os campos, `aria-invalid` + dica textual, foco visível (inclusive no slider), alvos de toque ≥ 40 px (44 px nos principais), `aria-valuetext` no slider, `prefers-reduced-motion`, contraste corrigido (placeholder de 2,47:1 → ~5,2:1; bordas de controle ~3,1:1).
- **Compartilhar resultado** (Web Share API com fallback para clipboard/`execCommand`).
- **Avisos de sanidade** (não bloqueiam): preço fora da faixa comum, relação etanol/gasolina fora de 50–100%, consumos incoerentes (razão fora de 0,55–0,85).
- **Badge de offline** e rodapé com a data de referência do limite.

### Bugs da v1 corrigidos (mapeamento da auditoria)
| Bug da v1 | Correção na v2 |
|---|---|
| SW cache-first sem versionamento congelava o app | network-first na navegação + VERSION no nome do cache |
| `addAll` abortava o install inteiro | `add()` individual com `catch` |
| `activate` apagava **todos** os caches da origem | apaga só prefixo `abastece-certo-` |
| empate técnico com texto "acima/abaixo do limite" e cor errada | regra única: veredito empate ⇒ texto "dentro da margem de 0,5 p.p." e marcador âmbar |
| `skipWaiting()` automático misturava versões | atualização sob confirmação do usuário |
| parse silencioso (`R$ 5,89`→NaN, `1,234.56`→1,23456, `1e3`→1000, `0x10`→16) | parser pt-BR estrito: aceita R$, milhar e unidades; rejeita letras, fullwidth e separadores duplicados |
| `∞%` / `NaN` chegando ao DOM | resultados só existem com todos os campos válidos; formatadores com guarda |
| manifest `data:` URI + ícone SVG-only (instalação falha) | manifest estático + PNGs reais 192/512/maskable/apple |
| localStorage sem validação/migração | `loadState` valida veículos, valida o limite (corrompido → 72, nunca 55) e migra chaves da v1 |
| limite 70 da v1 herdado sem aviso (E32 pede 72) | migração converte 70 → 72 e mostra um toast explicando; só preserva limite personalizado |
| contraste insuficiente | placeholder e borda de controle ajustados (5,2:1 e 3,1:1) |
| slider sem foco visível (`outline:none` vencia o `:focus-visible` genérico) | regra `input[type=range]:focus-visible` própria + altura de 34 px |
| preset "seu carro" mostrava 71,7% e aplicava 71,5% | slider em passos de 0,1 e rótulo igual ao valor aplicado |
| `"5.899"` virava 5899 (milhar) | heurística: milhar implausível + decimal plausível → lê 5,899 |
| preço `500` gerava veredito absurdo / número gigante no card | teto duro `MAX_PRICE = 99,99` → campo marcado inválido |
| fronteira exata ±0,5 p.p. decidida por ruído de float | `roundPp` arredonda a diferença a 9 casas antes de comparar |
| 1ª visita recarregava a página sozinha (`clients.claim` → `controllerchange`) | primeiro claim não recarrega; só recarrega após atualização aceita |
| erro de campo e barra de update não anunciados | região viva `#liveForm` + `role="status"` na barra |
| `navigator.share` rejeitando sem fallback | rejeição (exceto cancelamento) cai para cópia |
| `cache.put` sem `catch` (QuotaExceeded virava unhandled rejection) | `.catch()` nos dois caminhos do SW |
| toast e barra de atualização se sobrepunham | toast sobe quando a barra está visível |

### Arquitetura de testes (gate de qualidade)
- `tools/test.mjs` — **143 testes** extraindo o bloco `CORE-START/CORE-END` do `index.html` e rodando em `node:vm` (sem duplicar código): parser (inclusive 3 casas com ponto e tetos), formatação, cálculo dos dois modos, fronteiras exatas de empate, invariante veredito×texto, avisos, gauge, integridade do HTML.
- `tools/check.mjs` — **47 checagens** de pacote: arquivos, JSON do manifest × dimensões reais dos PNG, precache do SW × arquivos existentes, sintaxe do JS embutido, ARIA/ids/labels, ausência de dependências externas, foco do slider, tetos de validação, orçamento de tamanho.
- `tools/visual-check.mjs` — Edge headless via DevTools Protocol (WebSocket nativo do Node, sem puppeteer): preenche campos, testa validação, empate técnico, modo preciso, persistência após reload, viewport de 360 px, alvos de toque e coleta erros de console. Gera `screenshots/*.png`.
- `tools/serve.mjs` — servidor estático local sem dependências (para testar SW/PWA).
- `tools/make-icons.py` — gera os ícones PNG (Pillow/numpy), com gota construída por tangência exata.

### Verificação realizada em 17/10/2026
- `node tools/test.mjs` → **143/143**.
- `node tools/check.mjs` → **47/47** (1 aviso não bloqueante: manifest sem screenshots, decisão consciente).
- `node tools/visual-check.mjs` → 10 etapas, **0 erros de console**, sem overflow horizontal em 360 px, veredito/texto/cor consistentes no empate, atalho `?modo=preciso` funcionando.
- Peso: `index.html` ~58 KB, `sw.js` ~3 KB, ícones ~103 KB no total.

### Pitfalls (novos)
- **Edge headless não roda sob o sandbox de arquivos do harness** (Mojo/`platform_channel` falha com "Acesso negado" ao abrir pipes nomeados). Rodar `tools/visual-check.mjs` com o ambiente liberado; é ferramenta de dev, não requisito.
- **`manifest` em `data:` URI** continua quebrando instalação (iOS/Safari e Chrome tratam mal). Sempre arquivo real, mesmo que ≥ 2 requisições.
- **`skipWaiting()` automático** + `clients.claim()` pode servir HTML novo com CSS/JS em cache antigo. Em app pequeno o risco é baixo, mas o padrão correto é atualizar sob confirmação — foi o que a v2 faz. O `clients.claim()` da primeira visita **não** recarrega mais a página.
- **Migração de SW:** a v1 usava cache-first sem versionamento; na primeira visita após publicar a v2, o service worker antigo ainda pode servir o HTML velho até o usuário fechar/recarregar. Não há como corrigir retroativamente do lado cliente — vale avisar quem já instalou a v1. Depois dessa primeira atualização, o network-first resolve.
- **`VERSION` do SW é bump manual** a cada release (`sw.js`); trocar a versão é parte do passo de publicar.
- **Não cachear o próprio `sw.js`** e nunca apagar caches de outras origens/escopos (prefixo obrigatório em `*.github.io`).
- **Parse de preço nunca deve "limpar" caracteres em silêncio**: `[^\d.,]` transformava dígitos fullwidth (`５,89`) em `89`. A v2 valida a string inteira antes.
- **Texto e cor do veredito precisam sair da mesma fonte de verdade** (`verdict`), nunca de comparações recalculadas no template.
- `file://` é contexto seguro mas **não é instalável** e não registra SW — o app precisa funcionar (e funciona) sem SW.
- A mistura **E32 é temporária**; o rodapé mostra a data de referência e o limite é ajustável.

### Backlog (v3 possível)
- Preços semanais automáticos via GitHub Action → JSON no próprio repositório (única forma estática de manter números atualizados; mostrar data da última atualização e falhar em silêncio mantendo o valor anterior).
- Importar `resumo_semanal_lpc_*.xlsx`/CSV local via `FileReader` (recurso avançado, opcional).
- Histórico local de preços/abastecimentos (gráfico em SVG próprio, sem Chart.js).
- Screenshots no manifest (rich install UI) — exige imagens `wide` 1280×720 e `narrow`.
- Rodar Lighthouse/axe reais em dispositivo Android e iOS para fechar a verificação de instalação.

---

## 17/10/2026 — v3 (preços semanais da ANP, histórico local e gate ampliado)

### Objetivo
Fechar os itens de backlog que mais afetavam utilidade e confiança: dados de preço atualizáveis sem backend,
memória dos cálculos do usuário e testes de integração/runtime dentro do gate.

### Decisões
- **Preços:** XLSX oficial da ANP → `precos.json` por `tools/update-prices.mjs`, **sem dependências**
  (leitor ZIP próprio com `node:zlib`, XML por regex, números pt-BR, validação antes de gravar e escrita
  atômica — nunca gera JSON parcial). O GitHub Action (`atualizar-precos.yml`) roda semanalmente, roda os
  testes, e só commita se o dado mudou; reexecução sem novidade preserva `atualizadoEm` e os bytes.
- **App:** busca `./precos.json` na **mesma origem** (sem CORS), cacheia em `localStorage` (`ac.v3.prices`)
  e, se o fetch falhar, mantém o cache ou o texto de referência embutido — nunca quebra a calculadora.
  Bloco "Referência ANP" com semana, seletor Brasil/UF e botão **Usar médias**.
- **Histórico:** `localStorage` (`ac.v3.history`, máx. 50), botão "Salvar no histórico", lista da mais nova
  para a mais antiga, **sparkline em SVG próprio** (sem Chart.js) com linha tracejada do limite, e CSV com
  BOM + `;` + vírgula decimal (abre corretamente no Excel pt-BR). Limpeza exige confirmação em duas etapas.
- **PWA:** screenshots `narrow` 430×932 e `wide` 1280×720 no manifest, gerados pelo `visual-check` com
  recorte fixo em coordenadas do documento; `precos.json` no precache; `forced-colors` para alto contraste;
  versão **3.0.0** no app, no SW e no `package.json`.
- **Gate:** quatro suítes — `test.mjs` (lógica pura), `test-dom.mjs` (integração com DOM simulado),
  `test-sw.mjs` (runtime do service worker) e `test-prices.mjs` (pipeline ZIP/XLSX/schema). `npm test` roda
  todas; `check.mjs` valida o pacote (manifesto, screenshots reais, precache, ARIA, tamanho).

### O que foi promovido da revisão adversarial
O harness `research/review-v2.mjs` virou **`tools/test-dom.mjs` + `tools/test-sw.mjs`**, agora parte do gate
oficial. A lacuna apontada na revisão ("`test.mjs` só cobre o CORE, o SW não tem teste de runtime") foi fechada.

### Verificação (17/10/2026)
- `node tools/test.mjs` → **157/157**.
- `node tools/test-dom.mjs` → **95/95**.
- `node tools/test-sw.mjs` → **33/33**.
- `node tools/test-prices.mjs` → **99/99**.
- `node tools/check.mjs` → **52/52**.
- `node tools/visual-check.mjs` → **13 etapas**, 0 erros de console; preços da ANP e histórico validados no
  navegador; screenshots do manifest regravados com as dimensões exatas.
- Dados conferidos contra a fonte oficial: gasolina **6,54**, aditivada **6,72**, etanol **4,14**
  (semana 04–10/10/2026; 4.474 / 3.443 / 3.833 postos), 27 UFs.
- Peso: `index.html` ~75 KB · `sw.js` ~3,5 KB · `precos.json` ~2,5 KB · ícones ~103 KB.

### Pitfalls (novos)
- **`fetch` não funciona em `file://`** — o bloco ANP só carrega quando servido por http(s); em `file://`
  fica o texto de referência embutido. Isso é intencional e testado.
- **Screenshot do manifest não pode variar de tamanho**: nada de captura de página inteira; usar clip fixo
  em **coordenadas do documento** + `captureBeyondViewport: true` e `deviceScaleFactor: 1`. Com a página
  rolada e clip em `y=0` a imagem sai vazia (aconteceu e foi corrigido).
- **`precos.json` pode envelhecer** se a Action falhar: o app mostra a semana do arquivo e o cache local; a
  Action preserva os bytes quando não há dado novo para não criar commit vazio.
- **XLSX sem biblioteca** exige ZIP (EOCD/diretório central/store+deflate) e `sharedStrings.xml`; a semana do
  LPC é **domingo–sábado**; `min`/`max` são de médias **municipais**, não de posto.
- **Histórico é local por aparelho** (não sincroniza) e não substitui diário fiscal.
- **Migração da v2 para a v3:** `ac.v2` continua válido; `ac.v3.prices` e `ac.v3.history` são chaves novas e
  não apagam nada. O aviso de 70→72 só aparece quando o limite é realmente trocado.

### Backlog (v4 possível)
- Importar `resumo_semanal_lpc_*.xlsx`/CSV do próprio usuário via `FileReader`.
- Sincronizar histórico entre aparelhos (exigiria conta/backend — decisão de produto).
- Layout realmente “desktop” (duas colunas) para um screenshot `wide` menos espaçado.
- Lighthouse/axe reais em Android/iOS para fechar a verificação de instalação.
- Deploy automatizado (GitHub Pages) + versão visível numa tela "sobre".

---

## 17/10/2026 — v4 (visual "app nativo limpo" + modo escuro)

### Contexto
Depois da v3, o visual foi avaliado como "cara de IA". Três mockups iniciais (papel/recibo, revista,
placa) foram rejeitados; a pesquisa de referências reais (Energy Plus/GS Caltex, Drivvo, GasBuddy) gerou
três mockups novos (A, B, C) e o **A — "app nativo limpo"** foi o escolhido, com pedido explícito de
**modo escuro**.

### Decisões
- **Visual A (base Energy Plus):** fundo `#f6f7f9`, cartões brancos de 16 px com sombra suave, **um** acento
  verde, segmentado estilo iOS, CTA escuro e números sans grandes (sem serifada, sem papel, sem placa).
- **Modo escuro com três estados:** escuro (**padrão**), automático (segue o sistema) e claro. Persistido
  em `localStorage["ac.theme"]`, aplicado **antes do primeiro paint** por um script no `<head>`
  (`data-theme` no `<html>`) para não haver flash; botão 44×44 no cabeçalho alterna os estados;
  `meta[name=theme-color]` acompanha o tema (`#0b0e14` / `#f1f4f9`); tokens próprios para cada tema
  (`#0b0e14` / `#141926` / `#e8edf5` no escuro), não inversão de cores.
- **Melhorias de produto no mesmo pacote:** UF escolhida é **lembrada** (`localStorage["ac.uf"]`); a
  referência ANP mostra a **faixa min–máx** nacional de gasolina/etanol; o slider do limite tem
  preenchimento verde proporcional; versão **4.0.0** (app, SW e `package.json`).
- **Máscara de preço consolidada** (entrou na v3.1): só dígitos, `6 → 6,00`, `654 → 6,54`, teto 4 dígitos.

### Verificação (17/10/2026)
- `tools/test.mjs` → **159/159** (inclui faixa min–máx).
- `tools/test-dom.mjs` → **114/114** (inclui tema escuro/claro/automático, persistência, UF lembrada e a
  regressão da máscara digitando tecla por tecla).
- `tools/test-sw.mjs` → **33/33** · `tools/test-prices.mjs` → **99/99** · `tools/check.mjs` → **55/55**
  (novas checagens de tema: bootstrap, tokens, botão e cores do manifest).
- `tools/visual-check.mjs` → **15 etapas**, 0 erros de console: capturas no tema escuro (padrão),
  screenshot do tema claro, alternância manual, automático seguindo o sistema (`prefers-color-scheme`) e
  **máscara digitada de verdade** (CDP `Input.insertText` → `456` → `4,56`; tecla por tecla `6,5,4` → `6,54`).
- Publicado em <https://atanycost-png.github.io/abastece-certo/> (v4).

### Pitfalls (novos)
- **Máscara + evento sintético:** ao formatar, o app dispara um `input` sintético para re-renderizar. O
  listener de fallback relia o valor formatado (`"6,00"` → dígitos `"600"`), então digitar `6 → 5 → 4`
  resultava em `"4,00"`. Corrigido com a flag `maskNotifying` (ignora o evento que o próprio app disparou) e
  coberto por teste DOM + digitação real no Edge.
- **Flash de tema**: aplicar `data-theme` antes do CSS pintar; qualquer atraso aparece como “piscada”.
- **Transições enganam teste**: medir cor logo após clicar no tema pega o meio da transição (0,15 s). Esperar
  ~300–450 ms antes de medir/capturar.
- **Edge headless herda o tema do SO**: o `visual-check` emula `prefers-color-scheme: light` para as
  capturas padrão e `dark` para o teste do automático.
- **`color-mix()`** no anel de foco é suportado nos navegadores atuais (Edge/Chrome/Safari modernos); em
  navegador antigo o anel simplesmente não aparece (degrada sem quebrar).
- **Input de preço** usa `type="text"` + `inputmode="numeric"` + máscara; `type="number"` atrapalha o
  controle de dígitos e o backspace.
- **`100vh`** no mobile precisa de `100dvh` como fallback.

### Backlog (v5 possível)
- Lighthouse/axe reais em Android/iOS; testar instalação e tema escuro no aparelho.
- Screenshots do manifest também no tema escuro (Chrome escolhe por `prefers-color-scheme`).
- Consumo cidade/estrada separados no modo preciso (dois campos por combustível).
- Preços por município (o LPC tem a aba `MUNICIPIOS`) com busca por cidade.
- Tela "sobre" com versão e data dos dados; deploy automático já existe (Pages).

---

## 17/10/2026 — v4.2 (máscara reescrita, instalar/sobre/imagem, custo mensal, CI)

### Contexto
Depois da v4.1 o usuário relatou que a **máscara ainda falhava** no PC e que o **tema claro não agradou**
(por isso virou padrão escuro na v4.1). Pediu também: quais APIs dá para puxar (já pesquisadas em
`research/FINDINGS.md`) e se estamos no limite do offline/sem backend.

### Máscara: por que ainda falhava e o que mudou
O desenho anterior guardava os dígitos em um `WeakMap` e disparava um `input` sintético para re-renderizar.
Isso quebrava em três cenários comuns de PC: **desfazer (Ctrl+Z)**, **colar** e **selecionar parte do texto** —
o valor do campo e o dígito guardado saíam de sincronia e a tecla seguinte entrava no lugar errado.
- **Reescrita sem estado paralelo:** o valor exibido é sempre derivado dos dígitos do próprio campo a cada
  `input`; digitação, cola, undo e autofill se auto-corrigem.
- Enquanto digita: `6` → `6`, `65` → `65`, `654` → `6,54`, `456` → `4,56`, `1050` → `10,50`.
- Ao sair do campo (`blur`): `6` → `6,00`, `65` → `65,00`.
- 5º dígito é ignorado; colagem longa fica com os últimos 4 dígitos; letras somem; `R$ 6,54` colado vira `6,54`.
- Sem `beforeinput` próprio e sem evento sintético: menos superfície para bug.

### Outras entregas
- **Instalar app:** `beforeinstallprompt` mostra o botão; no iOS (sem evento) o toque ensina
  *Compartilhar → Adicionar à Tela de Início*; `appinstalled` esconde o botão.
- **Sobre e dados:** bottom sheet com versão, semana da ANP, fonte, **Atualizar preços** e
  **Apagar dados deste aparelho** (confirmação em dois toques; limpa `ac.theme`, `ac.uf`, `ac.v2`,
  cache de preços e histórico).
- **Compartilhar imagem:** cartão PNG 900×1200 desenhado em `<canvas>` (tema escuro, veredito, índice,
  preços, semana) com `navigator.share({files})` quando suportado e download como fallback.
- **Custo mensal:** campo opcional "Rodo por mês (km)" no modo preciso; o resultado mostra
  "Rodando 1.000 km/mês: cerca de R$ X/mês com etanol".
- **Histórico com veículo:** cada item salvo guarda o nome do veículo ativo (CSV continua com 8 colunas).
- **CI de qualidade:** workflow `Qualidade` roda as 5 suítes em cada push e um **Lighthouse informativo**
  (performance/acessibilidade/boas práticas/SEO) contra a versão publicada; acessibilidade do Lighthouse
  já usa axe-core por baixo.
- Screenshots do manifest agora saem no tema escuro padrão (o claro fica como captura opcional).

### Verificação (17/10/2026)
- `tools/test.mjs` → **159/159** · `tools/test-dom.mjs` → **122/122** (inclui máscara sequencial, blur,
  instalar, sobre, apagar dados, imagem, custo mensal e veículo no histórico).
- `tools/test-sw.mjs` → **33/33** · `tools/test-prices.mjs` → **99/99** · `tools/check.mjs` → **55/55**.
- `tools/visual-check.mjs` → **16 etapas**, 0 erros de console: digitação real (incluindo 5º dígito e blur),
  Sobre, custo mensal, temas escuro/automático/claro e capturas (`09-tema-claro`, `10-sobre`,
  `11-custo-mensal`).

### APIs: conclusão para este app
Ver `research/FINDINGS.md` §2.1–2.2 (checagens de 17/10/2026): **não existe API oficial de preços com
CORS**; a ANP publica XLSX semanal (297 KB) e CSV da série histórica (72 MB), ambos bloqueados por CORS
para sites estáticos. O caminho atual (Action semanal → `precos.json` na mesma origem) é o teto sem backend.
- **Candidatas gratuitas:** [API de Localidades do IBGE](https://servicodados.ibge.gov.br/api/v1/localidades/estados/SP/municipios)
  (lista de municípios, útil para o seletor de cidade) e [Overpass API/OSM](https://overpass-api.de/)
  (`amenity=fuel` perto do usuário; exige coordenadas e respeitar rate limit).
- **De terceiros pagos:** scrapers/APIs da ANP no [Apify](https://apify.com/latinamericadata/anp-precos-combustiveis-brasil/api)
  — não recomendados para este app (chave, custo, dependência de terceiro e possível violação de termos).
- **Limite do offline/sem backend:** média nacional/UF (e município, se embutida no JSON) cabe; **preço por
  posto em tempo real, mapa e sincronização entre aparelhos não** — exigiriam backend ou dados comunitários.

---

## 17/10/2026 — v4.3 (preço por cidade, "meus postos" e status de instalação)

### Contexto
Depois da v4.2 o usuário confirmou que a máscara está OK e pediu, nesta ordem: **custo por cidade**,
**seu posto** e um **teste de instalação no celular**.

### Preço por cidade (dados)
- O pipeline (`tools/update-prices.mjs`) passou a ler também a aba **MUNICIPIOS** do XLSX semanal:
  `municipios: { "SP": { "São Paulo": [gasolina, etanol], ... } }` compacto (array de 2 posições).
- A amostra semanal tem **394 municípios** (387 completos) em 27 UFs; `precos.json` foi de ~2,5 KB para
  **~26 KB** — cabe no precache offline.
- A ANP manda nomes em CAIXA ALTA e sem acento; o script consulta a **API de Localidades do IBGE** para
  recuperar a grafia/acentos. **Pitfall:** o IBGE devolve **HTTP 400** para User-Agent de script; precisa
  mandar UA de navegador (resolvido em `baixarNomesIBGE`).
- Validação: `validarMunicipios` confere UF, formato `[gasolina, etanol]`, faixas plausíveis, total ≤ 6000;
  `montarPrecos` só grava o bloco quando há cidades.
- No app: `normalizePrices` sanitiza o bloco (array ou objeto, números plausíveis, limite de 6000) e o
  seletor de **cidade** aparece quando a UF escolhida tem dados; a cidade é lembrada (`ac.cidade`).

### "Meus postos" (local, sem backend)
- Até 15 postos em `ac.v4.stations`: nome + gasolina + etanol + data; lista com índice calculado e botões
  **Usar** (preenche os dois campos) e **Excluir**; tudo no aparelho, nada sai dele.
- Salvar usa os preços válidos do momento; sem os dois preços, o app avisa.

### Teste de instalação no celular
- "Sobre e dados" agora mostra **Modo** (instalado na tela inicial × aberto no navegador) e
  **Service worker** (ativo × inativo) — é o check rápido depois de instalar/testar offline.
- Roteiro: abrir no Chrome/Safari → menu → *Instalar app / Adicionar à Tela de Início* → abrir pelo ícone →
  confirmar "instalado na tela inicial" no Sobre → ativar modo avião e calcular.

### Verificação (17/10/2026)
- `tools/test.mjs` → **160/160** (inclui normalização de municípios) · `tools/test-dom.mjs` → **124/124**
  (inclui cidade lembrada e meus postos) · `tools/test-sw.mjs` → **33/33** ·
  `tools/test-prices.mjs` → **99/99** (valida o `precos.json` real com municípios) ·
  `tools/check.mjs` → **55/55** · `tools/visual-check.mjs` → **16 etapas** (inclui cidade e posto no Edge).
- Versão **4.3.0** (app, SW e `package.json`).

### Pitfalls
- **Amostra municipal é parcial:** só entram as cidades pesquisadas naquela semana; não prometer cobertura
  nacional. O seletor lista o que existe no JSON.
- **Teste de ids duplicados** do `test.mjs` varre o HTML inteiro, inclusive strings de template: usar
  `data-id` repetido em `innerHTML` dispara falso positivo — trocamos por `data-sta`.
- **Tamanho do precos.json** precisa continuar pequeno; por isso só 2 produtos por cidade e arrays curtos.

---

## 17/10/2026 — v4.4 ("Postos perto de mim" via OpenStreetMap)

### Contexto
A instalação PWA no Android (Chrome) foi validada pelo usuário. Próximo passo escolhido: **postos
próximos**, aproveitando a API do Overpass/OSM pesquisada em `research/FINDINGS.md` §2.4.

### O que entrou
- Botão **“Postos perto de mim”** dentro de "Meus postos" (só aparece se o navegador tem geolocalização).
- A localização é pedida **apenas no toque** (`getCurrentPosition`, timeout 9 s, sem persistência); consulta
  `node["amenity"="fuel"](around:2000,...)` e monta a lista com **nome, distância (Haversine), marca**.
- Cada item tem **Mapa** (abre o Google Maps na coordenada) e **Usar nome** (copia o nome para o campo do
  posto; o usuário digita o preço e salva).
- **Fallback:** se todas as instâncias do Overpass falharem, aparece **“Abrir no Google Maps”** com a
  posição atual — o usuário não fica sem resposta.
- "Sobre e dados" explica que o OSM só é consultado no toque e que a localização não é guardada.

### Descobertas de infraestrutura
- O Overpass devolve `Access-Control-Allow-Origin: *` para GET (verificado com `Origin` no Node), mas
  **`overpass-api.de` deu timeout no navegador deste ambiente**; o espelho **`overpass.private.coffee`**
  respondeu e trouxe 9 postos no teste real (Edge headless + geolocalização simulada).
- Por isso o app tenta três instâncias em ordem (`private.coffee` → `overpass-api.de` → `kumi`) e tem o
  fallback do Maps. Este tipo de dependência externa **não pode ser gate rígido** no `visual-check`:
  erros de rede externa são registrados como aviso, não como falha (o teste valida a UI, não o serviço).

### Verificação (17/10/2026)
- `tools/test.mjs` → **162/162** (Haversine e `parseOverpassStations`: ordenação, dedupe, inválidos) ·
  `tools/test-dom.mjs` → **125/125** (botão só com geolocalização) · `tools/test-sw.mjs` → **33/33** ·
  `tools/test-prices.mjs` → **99/99** · `tools/check.mjs` → **55/55** ·
  `tools/visual-check.mjs` → **17 etapas**: geolocalização simulada via CDP + Overpass real (9 postos,
  screenshot `13-postos-proximos.png`).
- Versão **4.4.0** (app, SW e `package.json`).

### Pitfalls
- **CORS do Overpass existe, mas a disponibilidade não é garantida**: sempre ter fallback (Maps) e tratar
  erro sem quebrar o app.
- **Não persistir localização**; pedir só no toque e deixar claro no "Sobre".
- **Instância pública**: consulta leve (raio 2 km, só nodes, timeout 8 s) para não abusar do serviço.
- **Teste visual com rede externa**: separar erros do serviço dos erros do app (filtro por mensagem).

---

## 17/10/2026 — v4.5 (consumo cidade/estrada + diário de abastecimentos)

### Contexto
O usuário escolheu as duas próximas melhorias do roadmap: **consumo ponderado cidade/estrada** e
**diário de abastecimentos** (estilo Drivvo), alimentando o modo preciso.

### Consumo cidade/estrada (média harmônica)
- Cada combustível ganhou **dois campos**: cidade e estrada (`#gasKmL`/`#gasRoadKmL`,
  `#etaKmL`/`#etaRoadKmL`) + slider **“Uso na cidade”** (0–100%, padrão 70%).
- A média é **harmônica** — `1 / (w/consumo_cidade + (1-w)/consumo_estrada)` — porque o correto é somar
  litros por km, não km/L. Se só um dos campos é informado, ele vale para os dois (compatível com veículos
  salvos na v4.4).
- Abaixo do slider aparece o **consumo efetivo considerado**; o limite pessoal e o custo por 100 km passam
  a usar esse valor. `weightedKmL` e `averageConsumption` são funções puras no bloco CORE (testadas).
- Veículo salvo agora inclui `gasRoadKmL`, `etaRoadKmL` e `cityPct`; a migração de veículos antigos
  funciona (campos novos viram `null`/70).

### Diário de abastecimentos
- Seção recolhível no cartão do veículo: combustível (gasolina/etanol), **litros** e **km rodados desde o
  último abastecimento**; cada registro mostra seu km/L; o resumo soma litros e km por combustível
  (`km/L = soma_km / soma_litros`).
- **“Usar consumo real no modo preciso”** preenche cidade **e** estrada com a média medida (o peso não
  distorce, já que os dois lados ficam iguais).
- Até **80 registros** em `ac.v4.fills`, validados na leitura (combustível, litros 0–200, km 0–3.000,
  timestamp); nada sai do aparelho.

### Verificação (17/10/2026)
- `tools/test.mjs` → **164/164** (`weightedKmL`: 100%/0%/50%, fallback; `averageConsumption`: somas,
  filtros, plausibilidade) · `tools/test-dom.mjs` → **128/128** (peso muda o limite; veículo salva os 4
  campos + pct; diário salva/calcula/aplica/exclui/limpa) · `tools/test-sw.mjs` → **33/33** ·
  `tools/test-prices.mjs` → **99/99** · `tools/check.mjs` → **55/55** ·
  `tools/visual-check.mjs` → **18 etapas** (diário real: 2 registros → 12,4 km/L; consumo aplicado;
  screenshot `14-consumo-real.png`).
- Versão **4.5.0** (app, SW e `package.json`). `index.html` chegou a **130 KB** (≈34 KB gzip); o limite do
  `check` subiu de 120 KB para 150 KB.

### Pitfalls
- **Média harmônica, não aritmética**: média simples de km/L superestima o consumo efetivo quando cidade e
  estrada diferem. O teste fixa os números (10/14 a 50% → 11,67 km/L).
- **Compatibilidade de IDs**: `#gasKmL`/`#etaKmL` continuam sendo os campos “cidade”, então testes e dados
  antigos seguem válidos.
- **Não arredondar antes da conta**: guardar km/L com 1 decimal e calcular com o valor medido; só formatar
  na exibição.
- **Orçamento de tamanho**: arquivo único passou de 120 KB; o gate agora usa 150 KB e o número real de
  gzip é reportado no README/check.

---

## 17/10/2026 — v4.6 (hodômetro no diário + relatório mensal)

### Contexto
O usuário escolheu as duas melhorias seguintes: **hodômetro** (em vez de “km desde o último abastecimento”)
e **relatório mensal** com custo, km/L e economia acumulada.

### Hodômetro no diário
- O campo do diário virou **“Hodômetro (km total do carro)”** (`#fillOdometer`). O primeiro registro é só a
  **leitura inicial** (km = 0); os seguintes calculam `hodômetro - anterior` automaticamente.
- `recomputeOdometerKm` (CORE) ordena as leituras por hodômetro e reencadeia as distâncias — é usado na
  leitura do storage, ao salvar e **ao excluir** (excluir um registro não deixa distâncias órfãs).
- Regras: hodômetro não pode regredir; diferença máxima de 3.000 km por registro; entrada antiga (sem
  hodômetro, só com km) continua válida e é preservada.
- Cada registro mostra a leitura, litros e `+X km` (ou “leitura inicial”); ao salvar, toast informa os km
  calculados.

### Relatório mensal
- `monthlyReport` (CORE) agrupa o diário por mês (`AAAA-MM`): **litros**, **km**, **custo**
  (`litros × preço salvo no registro`), **km/L real** (só registros com km) e **economia estimada**
  (`(km/consumo_outro) × preço_outro - litros × preço_atual`).
- Cada abastecimento passa a guardar `price`, `otherPrice`, `kmL` e `otherKmL` do momento do registro;
  registros antigos (sem preço) entram em litros/km, mas não em custo/economia.
- Card “Relatório mensal” com total no topo e linhas mês a mês; atualiza junto com o diário.

### Verificação (17/10/2026)
- `tools/test.mjs` → **166/166** (recompute: encadeamento, ordem, legado; monthlyReport: agrupamento,
  custo, km/L, economia com números fechados) · `tools/test-dom.mjs` → **128/128** (hodômetro inicial,
  segundo registro 620 km/50 L → 12,4 km/L, regressão recusada, relatório no resumo, usar/excluir/limpar) ·
  `tools/test-sw.mjs` → **33/33** · `tools/test-prices.mjs` → **99/99** · `tools/check.mjs` → **55/55** ·
  `tools/visual-check.mjs` → **18 etapas** (diário real com hodômetro + relatório; screenshot
  `14-consumo-real.png`).
- Versão **4.6.0** (app, SW e `package.json`).

### Pitfalls
- **Hodômetro é do carro, não do combustível**: a distância desde a leitura anterior é atribuída ao
  abastecimento atual (mesma convenção de apps de consumo).
- **Excluir no meio da cadeia** muda as distâncias seguintes: por isso o recálculo é centralizado em
  `recomputeOdometerKm` e roda em toda mutação.
- **Custo só existe com preço no registro**: capturamos os preços do app na hora do salvamento; sem eles,
  o relatório mostra km/L mas “sem preço”.
- **Meses usam data local** (`getFullYear/getMonth`), não UTC — registros perto da meia-noite caem no mês
  local correto.
