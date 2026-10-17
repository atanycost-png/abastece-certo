# AUDITORIA INDEPENDENTE — Abastece Certo v1 → requisitos para a v2

**Revisor:** teammate `revisor` (auditor cético independente)
**Data:** 17/10/2026
**Escopo auditado:** v1 no commit `2dd8ab6` ("baseline: v1 importada do projeto original")
**Arquivos analisados:** `index.html` (388 linhas, 17.182 bytes), `sw.js` (24 linhas), `README.md`, `REFERENCIA.md`
**Método:** leitura estática + execução real do `<script>` inline em `node:vm` com DOM stub + `node:test`-less harness em Node v24.18.0; cálculo de contraste WCAG; verificação de spec/docs da web. Harness reproduzível: [audit-v1.mjs](audit-v1.mjs) (lê o snapshot imutável [v1-index-snapshot.html](v1-index-snapshot.html), gerado de `git show 2dd8ab6:index.html`).
**Limitações:** não houve execução em navegador real/leitor de tela nesta rodada (não há automação de browser disponível); comportamento de browser citado vem da spec/implementações documentadas e está marcado como "validar em QA". Nenhum arquivo de produção foi alterado — escrita restrita a `research/`.

> **Nota de contexto:** o `index.html` de trabalho já está em reescrita para a v2 durante esta auditoria (o arquivo em disco mudou de 17 KB para ~50 KB e `sw.js`/`manifest.webmanifest`/`icons/` foram adicionados). Para não auditar alvo móvel, **todos os bugs da seção 1 são da v1 congelada no commit `2dd8ab6`**. As seções 2–5 são requisitos/aceitação para a v2 e não julgam o WIP.

---

## Sumário executivo

A v1 é **boa no caminho feliz**: cálculo correto para preços comuns, layout mobile-first, sem dependências, funciona em `file://`, persistência com `try/catch` e explicação conceitual honesta (a regra é aproximação). Os riscos graves estão nas bordas: **atualização/offline do PWA**, **coerência das mensagens do empate técnico** e **entrada de dados real (R$, formatos en-US, valores absurdos)**.

**Os 3 problemas mais graves da v1 (detalhe na §1):**

1. **`sw.js` congela o app para sempre (P0).** Cache-first em `./` e `./index.html` com nome de cache fixo `"abastece-certo-v1"` e sem versionamento por conteúdo. Se `index.html` mudar sem mudar `sw.js`, o navegador não instala SW novo, o fetch nunca vai à rede e **o usuário fica na versão antiga até limpar dados do site**. Reprodução: servir a v1, abrir, editar um texto do `index.html`, recarregar → texto antigo. Agravantes: qualquer 404 em `addAll` aborta a instalação inteira (offline nunca liga, erro engolido) e o `activate` apaga **todos** os caches da origem, inclusive de outros PWAs em `usuário.github.io`.
2. **Empate técnico com mensagem contraditória (P1).** A decisão usa `EPS = 0,005` na fração (= 0,5 p.p.), mas o texto de distância só considera "exatamente no limite" quando `|diff| < 0,05` p.p. (10× menor). Resultado: veredito **"Empate técnico — indiferente"** acompanhado de **"0,2 p.p. acima do limite"** (e ponto do gauge azul de gasolina) — o usuário lê que está acima do limite mas recebe "indiferente". Reprodução: gasolina `5,00`, etanol `3,51`, limite 70% → índice 70,2%, texto "· 0,2 p.p. acima do limite", veredito "Empate técnico". Na fronteira exata de ±0,5 p.p. há ainda 4 casos em 42 em que o *float* decide o lado (ex.: `5,00`/`3,475`/70% → empate, embora a regra documentada diga etanol).
3. **Parse silencioso/enganoso e sem estado de erro (P1).** `"R$ 5,89"` → `NaN` → a tela volta ao estado "Informe os dois preços" (parece que o app ignorou o que foi digitado); `"1,234.56"` (en-US) → `1,23456` (erro de 1000×, sem aviso); `"1e3"` → 1000, `"0x10"` → 16, `"0b11"` → 3 são aceitos como preço. Não há limite de faixa: `gasolina = 500` gera veredito confiante. Reprodução: gasolina `R$ 5,89`, etanol `3,99` → nenhum resultado e mensagem genérica; gasolina `1,234.56`, etanol `3,99` → "323,2%" e "Abasteça com GASOLINA".

**P0 para a v2 "completa" (lista completa na §5):** cálculo determinístico e sem `NaN/Infinity` no DOM; regra de empate única (decisão + texto + cor + gauge); parser/validação com erro explícito por campo; modo preciso correto e rotulado; PWA instalável de verdade (ícones 192/512 PNG + manifest estático + verificação iOS); SW sem cache velho (versionamento + network-first de navegação + precache tolerante + limpeza namespaced + update avisado); funcionamento em `file://`; suíte automatizada + docs sincronizados.

---

## 1. Bugs e riscos reproduzíveis da v1

Severidades: **P0** = bloqueia release/perda de dados ou de confiança na decisão; **P1** = defeito relevante com reprodução fácil; **P2** = polimento/edge. "v1" sempre se refere a `2dd8ab6`.

### 1.1 P0

#### BUG-01 — Service worker cache-first sem versionamento congela o app (P0)

- **Cenário:** publicar v1; abrir no Chrome/Android (SW ativa); alterar qualquer coisa no `index.html` e publicar de novo **sem alterar `sw.js`**; recarregar/abrir o app online.
- **Acontece:** o navegador busca `sw.js`, vê bytes idênticos → não instala SW novo; o handler `fetch` responde `caches.match(...) || fetch(...)`; como `./` e `./index.html` estão no cache, **a rede nunca é consultada**. A versão antiga fica para sempre (até "limpar dados do site" ou desregistrar o SW).
- **Deveria:** navegação ser network-first (ou cache versionado por conteúdo/build) com fallback de cache apenas offline; nova versão detectada e aplicada.
- **Evidência:** `index.html:379-384` registra `./sw.js` após `load`; `sw.js:2-3` cache fixo, `sw.js:19-24` cache-first sem versão.
- **Agravante A (P1):** `sw.js:5-9` usa `addAll` para `["./", "./index.html"]`. Se **qualquer** URL falhar (404/404 em hosts sem directory index, erro de rede na 1ª instalação), o `install` rejeita, o SW **nunca ativa** e o app não fica offline — o erro é engolido por `.catch(function(){})` na página.
- **Agravante B (P1):** `sw.js:11-17` no `activate` faz `caches.keys().filter(k => k !== CACHE).map(delete)`. A Cache Storage é **por origem**, não por escopo. Em `usuario.github.io`, vários PWAs compartilham a origem: instalar/atualizar o Abastece Certo apaga os caches **dos outros apps**. Deveria filtrar por prefixo do próprio app (ex.: `abastece-certo-*`).
- **Agravante C (P2):** `addAll`/`cache.add` usam fetch com cache HTTP default; em host com `Cache-Control` longo no HTML (GitHub Pages manda `max-age=600`), um SW novo pode precachear um HTML **velho** do cache HTTP. Precisa `new Request(url, {cache: "reload"})` ou URL versionada.

#### BUG-02 — Instalação PWA prometida no README não é confiável (P0 para o requisito "PWA completo", P1 para o app em si)

- **Cenário:** publicar v1 em HTTPS (GitHub Pages) e tentar "Instalar app" / prompt de instalação no Chrome Android; adicionar à tela inicial no iPhone.
- **Acontece:** o manifest é gerado em runtime e injetado via `data:application/manifest+json,...` (`index.html:374-377`), com `start_url: "."`, `scope: "."` e **um único ícone SVG** `sizes: "any"` (`index.html:362-373`). Critérios documentados do Chromium exigem `icons` com **192 px e 512 px**; SVG `sizes:any` não fornece esses tamanhos (risco real de o Chrome nem contar o ícone para instalação/promoção). O `apple-touch-icon` também é SVG (`index.html:351-360`), formato **não suportado** pelo iOS (ele quer PNG, tipicamente 180×180); no iOS o ícone cai para captura de tela genérica. Manifest em `data:` ainda tem resolução relativa de `start_url`/`scope` contra a URL `data:` (a spec prevê *fallback* para a URL do documento, mas o comportamento varia por engine/versão e há bugs conhecidos do Chromium com manifest inline).
- **Deveria:** manifest estático (`manifest.webmanifest`) com `name`/`short_name`, `start_url`, `scope`, `display: standalone`, ícones PNG 192×192 + 512×512 + versão `maskable`, `theme_color`/`background_color`, e `apple-touch-icon` PNG 180×180; instalação validada em Chrome Android e iOS (iOS 26+ já abre qualquer site como web app por padrão, mas o ícone/título e o comportamento em iOS antigo ainda dependem das metas/Apple icons).
- **Evidência:** `index.html:346-377`; `README.md:16,26-29`; `REFERENCIA.md:48` (trata o ícone PNG apenas como "mais bonito", subestimando o risco).
- **Referências:** [MDN — Making PWAs installable](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable) (Chromium exige 192 e 512; HTTPS/localhost; Firefox não instala por manifest); [Chrome — revisão dos critérios de instalação](https://developer.chrome.com/blog/update-install-criteria) (Chrome 108/112 removeu exigência de SW para instalar pelo menu, mas o prompt automático ainda pede `fetch handler`); [W3C Web App Manifest](https://www.w3.org/TR/appmanifest/) (processamento de `start_url`/`scope` e *fallback*); [iOS 26 muda o comportamento de web apps na tela inicial](https://www.heise.de/en/news/iOS-26-and-iPadOS-26-Changed-web-app-behaviour-on-the-home-screen-10749652.html) (padrão passa a ser abrir como web app; ícones do manifest são usados quando definidos; Safari não exige SW).

### 1.2 P1

#### BUG-03 — Empate técnico: faixa de decisão ≠ faixa do texto (10×) e cor do gauge contraditória (P1)

- **Cenário (reproduzido no harness):** gasolina `5,00`, etanol `3,51`, limite `70%`.
- **Acontece:** `diff = +0,002` na fração (`+0,2 p.p.`); `Math.abs(diff) < EPS(0,005)` → veredito **"Empate técnico — indiferente"**; porém `gapAbs = 0,2 ≥ 0,05` → texto **"· 0,2 p.p. acima do limite"**. Além disso `dotCls = diff <= 0 ? "green" : "blue"` → ponto **azul (cor de gasolina)** enquanto o veredito é âmbar. Simétrico: `5,00`/`3,49` → empate, "0,2 p.p. abaixo do limite", ponto verde (cor de etanol).
- **Deveria:** um único `EPS` (em p.p.) governa decisão **e** texto — ex.: "dentro da margem técnica (±0,5 p.p.)" em vez de "acima/abaixo" quando o veredito é empate; cor do gauge âmbar no empate; margem documentada em um só lugar.
- **Evidência:** `index.html:244` (`EPS = 0.005` fração), `index.html:299-301` (faixa), `index.html:313-316` (limiar `0,05` p.p. + `fmt(gapAbs,1)`), `index.html:321` (cor do ponto).
- **Contradição interna nos docs:** `REFERENCIA.md:27` fala 0,5 p.p.; o texto usa 0,05 p.p.

| Entrada (limite 70%) | Índice exibido | Texto exibido | Veredito | Problema |
|---|---|---|---|---|
| g 5,00 / e 3,51 | 70,2% | "· 0,2 p.p. acima do limite" | Empate técnico | texto diz "acima" e cor azul, decisão "indiferente" |
| g 5,00 / e 3,49 | 69,8% | "· 0,2 p.p. abaixo do limite" | Empate técnico | texto diz "abaixo" e cor verde, decisão "indiferente" |
| g 5,00 / e 3,5249 | 70,5% | "· 0,5 p.p. acima do limite" | Empate técnico | pior caso: mensagem de 0,5 p.p. com "indiferente" |
| g 5,00 / e 3,4755 | 69,5% | "· 0,5 p.p. abaixo do limite" | Empate técnico | idem |
| g 5,00 / e 3,498 | 70,0% | "exatamente no limite" | Empate técnico | está 0,04 p.p. fora do limite ("exatamente" falso) |

Fabrica-se ainda "exatamente no limite" para diferenças de até 0,049 p.p., o que é falso: o caso só é exato com `diff == 0`.

#### BUG-04 — Fronteira de ±0,5 p.p. decidida pelo erro de ponto flutuante (P1/P2)

- **Cenário:** `diff` matematicamente igual a ±0,5 p.p. (`|diff| = EPS` → a regra diz **não empate**).
- **Acontece:** dependendo da representação binária, `Math.abs(diff) < 0.005` pode dar `true`, virando empate. Varredura de 42 fronteiras (limites 60..80, ±0,5 p.p.) encontrou **4 divergências** da regra documentada:

| Limite | Gasolina | Etanol (entrada) | Índice real | Esperado pela regra | v1 decide |
|---|---|---|---|---|---|
| 70% | 5,00 | 3,475 | 69,500% | ETANOL (−0,5 p.p.) | empate |
| 68% | 5,00 | 3,425 | 68,500% | GASOLINA (+0,5 p.p.) | empate |
| 72% | 5,00 | 3,575 | 71,500% | ETANOL (−0,5 p.p.) | empate |
| 78% | 5,00 | 3,925 | 78,500% | GASOLINA (+0,5 p.p.) | empate |

- **Deveria:** semântica explícita e determinística (`<` ou `≤`), idealmente comparando **p.p. arredondado a 2–3 casas** (ou inteiros de centésimos) e com testes de fronteira que fixem o comportamento; nunca depender do último bit do float.
- **Evidência:** `index.html:296-301`; ver `research/audit-v1.mjs` (bloco "divergencias na fronteira exata").

#### BUG-05 — Formato/estado inválido sem mensagem: "Informe os dois preços" mesmo com os dois preenchidos (P1)

- **Cenário:** colar `R$ 5,89` no campo gasolina e digitar `3,99` no etanol.
- **Acontece:** `parsePrice("R$ 5,89")` → `NaN`; guarda `!(g > 0)` → `result.innerHTML` volta ao **estado vazio genérico "Informe os dois preços para ver o resultado."** (`index.html:289-292`). O usuário preencheu os dois campos, não vê erro, e conclui que o app está quebrado. O mesmo vale para `abc`, `5,8,9`, `0`, `-3`, `1e309`.
- **Deveria:** estado de erro por campo ("Não entendi o preço. Use 5,89 ou 5.89"), `aria-invalid`, mensagem associada, e o veredito antigo esmaecido/limpo; não confundir "vazio" com "inválido".
- **Evidência:** `parsePrice` `index.html:247-255`; guarda `index.html:289-292`.
- **Evidência de execução:** `parsePrice("R$ 5,89") = NaN`; `parsePrice("R$5,89") = NaN`; `parsePrice(" 5,89 ") = 5.89`; `parsePrice("\u00a05,89") = 5.89`.

#### BUG-06 — Parser aceita formatos que deveriam ser erro e troca formatos que deveriam ser aceitos (P1)

Cenários e resultados reais (função do `index.html` executada no harness):

| Entrada | v1 | Deveria (pt-BR seguro) | Por quê |
|---|---|---|---|
| `"1,234.56"` | **1,23456** | 1234,56 ou erro explícito | en-US; hoje erra por 1000× silenciosamente |
| `"1.234"` | 1,234 | 1234 (milhar) se regra "último separador é decimal"; documentar | ponto só com 3 casas é ambíguo |
| `"1e3"` | **1000** | erro | notação científica não é preço de bomba |
| `"0x10"` | **16** | erro | hexadecimal aceito por `Number()` |
| `"0b11"` | **3** | erro | binário aceito por `Number()` |
| `"+5,89"` | 5,89 | erro (ou normalizar e documentar) | sinal não esperado |
| `"5,"` | 5 | 5 (estado "digitando") | ok, desde que não pisque erro |
| `"5,8,9"` | NaN | erro | ok |
| `""` / `"   "` | NaN | vazio (sem erro) | ok |
| `"0"` / `"0,00"` | 0 | erro "maior que zero" | guarda existe, mas sem mensagem |
| `"-3"` | −3 | erro | guarda existe, mas sem mensagem |
| `"R$ 5,89"` | NaN | 5,89 (limpar moeda) | entrada real muito provável |
| `"10,5 km/L"` | NaN | 10,5 (modo preciso) | unidade colada é comum |
| `"1.234,56"` | 1234,56 | 1234,56 | ok |
| `" 5,89 "` / NBSP | 5,89 | 5,89 | ok |
| `"999999999999999999999"` | 1e21 | erro de faixa | gera layout/decimais absurdos |
| `"5e-324"` | 5e-324 | erro de faixa | ver BUG-07 |

- **Deveria:** parser com teste de tabela (a matriz §2.1), faixa de sanidade (ex.: preço 0,01–99,99 com aviso fora de 2–20; consumo 0,1–99,9) e distinção `empty`/`invalid`.
- **Evidência:** `index.html:247-255`; `localStorage` persiste o texto cru (`index.html:260-266`), então um valor ilegível também reaparece no reload.

#### BUG-07 — `Infinity`/números gigantes chegam ao DOM; `fmt` pode gerar `-0,0` (P1→P2)

- **Cenário A:** gasolina `5e-324`, etanol `5` → `e/g` = `Infinity` (passa pelo guard `g > 0` porque `Number("5e-324")` é o menor subnormal finito). O DOM recebe literalmente **"∞%"**, "∞ p.p. acima do limite" e gauge no extremo (`index.html:294-333`). Não quebra, mas vaza valor não numérico para a UI.
- **Cenário B:** gasolina `0,000000001`, etanol `5` → **"500.000.000.000,0%"** e "499.999.999.930,0 p.p. acima do limite": o número não cabe no card de 460 px (overflow horizontal / quebra de layout).
- **Cenário C:** `fmt(-0,1)` retorna **"-0,0"** (Intl formata zero negativo); não é alcançável na v1, mas é armadilha para a v2 (ver F-05).
- **Deveria:** validar faixa de preço/consumo antes de calcular; exibir no máximo o valor real com formatação limitada (ou `—` + aviso); nunca renderizar `Infinity/NaN`; normalizar `-0`.
- **Evidência de execução:** seção 3 do `research/audit-v1.mjs` (cenários `subnormal => Infinity no DOM`, `huge ratio layout`).

#### BUG-08 — Restauração de estado sem validação, sem schema e sem migração (P1)

- **Cenário A:** `localStorage.ac_threshold = "abc"` → `threshold.value = "abc"`; pela sanitização de `<input type=range>` o valor cai para o **default (70)**; `thresholdVal` mostra "70%" e o preset 70 fica ativo. Nenhum aviso de que o limite salvo foi perdido. (Harness emula a spec; validar em browser.)
- **Cenário B:** `ac_threshold = "0"` / `"100"` → clamp para 60 / 80; `"71.5"` → aceito, nenhum preset ativo e `thresholdVal` "71.5%".
- **Cenário C:** `ac_gas = "<img src=x onerror=alert(1)>"` → não há XSS (ver BUG-12), mas o campo reaparece com esse texto e o resultado é o estado vazio genérico, sem explicação.
- **Cenário D:** `localStorage.getItem` lançando (modo restrito/iframe/sandbox) → `restore()` aborta no primeiro `getItem` e **não chama `syncPresets()`**; os preços nem são tentados. O app continua funcional com defaults (ok), mas nenhum aviso e o botão ativo pode ficar inconsistente com o valor real em estados parciais.
- **Deveria:** validar tipos/faixas ao restaurar, migrar dados de versões anteriores (as chaves `ac_gas`, `ac_eta`, `ac_threshold` da v1), versionar schema, ignorar silenciosamente o inválido **com fallback coerente** e nunca persistir valores que o parser rejeita. Perfil de veículo da v2 deve ser JSON versionado e validado.
- **Evidência:** `restore()` `index.html:267-275`; `syncPresets()` dentro do `try` `index.html:273`; `persist()` grava cru `index.html:260-266`; `render()` usa `threshold.value` sanitizado (`index.html:284,287`).
- **Bônus:** não há escuta de evento `storage` (duas abas divergem) nem botão "limpar dados" — P2.

#### BUG-09 — Acessibilidade: falhas AA reproduzíveis na v1 (P1)

Ver §3 para a lista completa com correção; resumo do que falha hoje:

| # | Problema | Evidência |
|---|---|---|
| A1 | Slider de limite **sem nome acessível** (o texto "Etanol compensa até" é `<span>`, não `<label for>` e não há `aria-label`) | `index.html:200-208`; `<input id="threshold">` sem label |
| A2 | Resultado dinâmico **sem `aria-live`/`role=status`** → leitor de tela não anuncia o veredito | `index.html:212-214`, `index.html:323-333` |
| A3 | Presets **sem `aria-pressed`/grupo** e estado ativo só por cor | `index.html:204-207,277-281` |
| A4 | `input[type=range]` com `outline: none` e nenhum substituto → **foco invisível no teclado** | `index.html:93-97` |
| A5 | Sem mensagens de erro/`aria-invalid` (WCAG 3.3.1) | `index.html:289-292` |
| A6 | Placeholder **2,47:1** e borda de input **1,23:1** (abaixo de 4,5:1 / 3:1) | calculado no harness, §3.2 |
| A7 | Slider com **6 px de altura** e thumb 24 px → alvo de toque muito abaixo de 24/44 px; `<summary>` ~19,5 px de altura | `index.html:93-97,144-151` |
| A8 | `prefers-reduced-motion`, `color-scheme`, `forced-colors` ignorados; SVGs de veredito sem `aria-hidden` | harness: `prefers-reduced-motion: false`, `aria-*: 1` (só o logo) |

#### BUG-10 — Documentação x implementação divergentes (P1 para a v2, pois `REFERENCIA.md` é a fonte de verdade do projeto)

| Doc | Afirma | Código v1 faz | Impacto |
|---|---|---|---|
| `README.md:27` | Veredito ETANOL se "índice ≤ limite" | Aplica primeiro a faixa de empate; ETANOL só se `índice ≤ limite − 0,5 p.p.` | Quem lê o README espera ETANOL no empate exato; recebe "empate" |
| `README.md:34` vs `README.md:27` | Fórmula usa `<`; veredito usa `≤` | Código usa `≤` para etanol (após faixa) / `<` para empate | Duas semânticas no mesmo README |
| `README.md:26` | "aceita vírgula ou ponto" | Não aceita `R$ 5,89`, erra `1,234.56`, aceita `1e3`/`0x10` | Overpromise; ver BUG-05/06 |
| `README.md:16` | Instalar via HTTPS + "Adicionar à tela inicial" | Ícones SVG-only + manifest em `data:`; critérios Chromium de 192/512 não atendidos | Instalação/promoção falha no Chrome; ícone genérico no iOS |
| `REFERENCIA.md:27` | Empate se `|índice − limite| < 0,5 p.p.` | Texto usa 0,05 p.p.; cor do ponto não é âmbar | Contradição interna (BUG-03) |
| `REFERENCIA.md:31` | "Lógica testada no Node: 5 casos … corretos" | 5 casos felizes; 38 entradas de parse e fronteiras não cobertas | Falsa sensação de cobertura |
| `REFERENCIA.md:24` | "gauge visual 60–80%" | Valores fora de 60–80 são clampados em 0/100 **sem aviso**; eixo fixo 60/70/80 | Leitura errada de "quase no limite" |
| `REFERENCIA.md:35-39` | Lista pitfalls (browser_exec, SW em file://, data: URI) | **Não** documenta o maior risco: cache-first sem versionamento (BUG-01) nem isolamento de cache | Risco crítico invisível no doc |
| `REFERENCIA.md:48` | "Ícone PNG 192/512 para instalação mais bonita" | Sem 192/512 pode não haver promoção de instalação | Prioriza estética quando é requisito funcional |
| `README.md:19` | `npx serve .` | OK (dev), mas contradiz "zero dependências" se lido como runtime | Redigir "sem dependências em runtime" |

#### BUG-11 — iOS/PWA: meta tags e ícones ausentes (P1)

- **Cenário:** instalar no iPhone (iOS 16/17/18; iOS 26 já muda o default) e abrir na tela inicial.
- **Acontece:** não há `<meta name="apple-mobile-web-app-capable">`, `apple-mobile-web-app-status-bar-style`, `apple-mobile-web-app-title`; o `apple-touch-icon` é SVG (iOS ignora). Em iOS antigo, abre no Safari com barra de endereço; o ícone é captura de tela.
- **Deveria:** PNG 180×180 + metas Apple; no iOS 26+, validar que "Abrir como app da web" está ativo e que ícone/nome vêm do manifest (a Apple passou a usar ícones do manifest quando definidos).
- **Evidência:** `index.html:346-377`; `README.md:16`.
- **Referências:** Apple Safari Web Content Guide (archive) e [WebKit Features in Safari 26](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/#every-site-can-be-a-web-app-on-ios-and-ipados).

### 1.3 P2

#### BUG-12 — XSS: não explorável na v1, mas a v2 abre caminho (P2 hoje, requisito P0 se houver perfil/nome)

- **Verificação:** o único `innerHTML` com dados dinâmicos é `result.innerHTML` (`index.html:323-333`), alimentado por `fmt()` (locale string) e `threshold.value` (range sanitiza para número). Preços **não** entram como HTML — entram no estado vazio genérico quando inválidos. Teste com `ac_gas = "<img src=x onerror=alert(1)>"` → o HTML não aparece no DOM do resultado (harness §4). Portanto **não há XSS explorável na v1**.
- **Risco para a v2:** perfil de veículo/nome/apelido, preços importados, histórico, textos de compartilhamento e migração de storage serão interpolados; qualquer um em `innerHTML` vira XSS. **Requisito:** usar `textContent` para todo dado do usuário; HTML só para markup estático; teste com payloads (`<img onerror>`, `"><svg onload=...>`, `javascript:`), `esc()` proibido por padrão.
- **Bônus:** localStorage pode ser manipulado por XSS/extensões; nunca confiar nele para HTML. `target="_blank" rel="noopener"` no link externo está correto (`index.html:225`).

#### BUG-13 — Gauge: clamp silencioso, eixo fixo e detalhes visuais (P2)

- **Cenário:** gasolina `5,00` / etanol `2,00` (40%) ou `4,50` (90%); limite 60% ou 80%.
- **Acontece:** `left` é clampado em 0%..100% (`index.html:319-320`), então 40% e 55% ficam ambos no extremo esquerdo; 90% e 110% no direito. O eixo é sempre "60% 70% 80%" (`index.html:332`), mesmo com limite 60/80; o marcador "limite" em 0%/100% fica meio para fora do trilho (transform `translateX(-1.5px)`/`translate(-50%)` + `overflow: visible` no track), podendo invadir o padding do card; o texto "limite" com 10 px pode colidir com a bolinha quando o índice está no mesmo ponto.
- **Deveria:** sinalizar "abaixo/acima da faixa" textualmente, reposicionar/rotular eixo dinamicamente (ou escala fixa com marcador de faixa), garantir que o marcador não saia do card, e cor âmbar no empate.
- **Evidência:** `index.html:122-142,318-333`.

#### BUG-14 — Slider e UX mobile: alvos pequenos, resultado fora da dobra, sem "Enter" (P2)

- Slider: `<input type=range>` com `height: 6px`; a área de toque efetiva fica muito pequena (o polegar de 24 px é desenhado para fora; a caixa do elemento tem 6 px) — difícil de arrastar, especialmente com dedo/molhado. `outline: none` agrava no teclado.
- Resultado fica no 3º card (abaixo de preços + limite): em 360×640 com teclado aberto, o veredito sai da tela; não há rolagem automática nem resumo fixo.
- Teclado decimal do iOS não tem tecla "Enter"/"Done" (o campo é `type=text`); não há `enterkeyhint`, não há handler de Enter para `blur()`, então o usuário tem que tocar fora para fechar o teclado e ver o resultado.
- Sem botão "limpar", sem troca rápida de preços (erro comum), sem feedback de persistência.
- `orientation: portrait` no manifest prende o app em retrato (iOS não suporta `orientation`, Android sim); sem justificativa documentada.
- Tema só escuro (`color-scheme` ausente → controles/scrollbars do navegador podem ficar claros), sem `prefers-color-scheme`/`prefers-contrast`/`forced-colors`.
- `100vh` no body → em Safari iOS com barras dinâmicas pode sobrar/rolar 1 tela; `dvh`/`svh` é mais adequado.
- Sem `<noscript>`: com JS bloqueado, a tela mostra apenas o card vazio e nada explica.
- **Evidência:** `index.html:5,8,26-34,93-107,144-151,184-195,208,212-214,362-373`.

#### BUG-15 — Compatibilidade/legado: `NodeList.forEach` e baseline não documentados (P2)

- `syncPresets()` e os listeners usam `presets.forEach` (`index.html:278,339`). Em navegadores antigos (Android WebView < 53, Safari antigo), `NodeList.prototype.forEach` não existe: `restore()` engole o erro (está dentro de `try`), mas o `forEach` dos listeners fica no topo do script e **aborta o script** — presets e todo o bloco PWA não funcionam. O `<script>` é ES5 no resto, então a falha é silenciosa e difícil de diagnosticar.
- **Deveria:** documentar baseline (evergreen moderno; iOS 15+/Chrome 90+) ou usar `Array.prototype.forEach.call`/`for`. Teste de "HTML sem recursos externos" e `node --check` não cobrem isso.
- **Evidência:** `index.html:234-385`; harness executa com NodeList-like, mas browsers reais antigos diferem.

#### BUG-16 — `file://`: funciona hoje, mas o requisito precisa ser testado a cada release (P2)

- **Hoje:** o app abre e calcula por duplo clique (JS inline, `localStorage` com `try/catch`); o SW é guardado por `location.protocol !== "file:"` (`index.html:379-384`); não há `fetch` de recursos (`fetch(` ausente no harness). Manifest e ícones dinâmicos não têm efeito prático em `file://` e falham silenciosamente.
- **Riscos para a v2:** se o Lead adicionar `manifest.webmanifest`, `icons/*.png` e um `<link rel="manifest">` estático, em `file://` o navegador tenta carregar o manifest e pode logar erro (não deve bloquear o app); qualquer `fetch()` de arquivo local no boot quebra o requisito; localStorage em `file://` pode variar por navegador (Firefox/Chrome permitem, Safari/ambientes corporativos podem bloquear) — o `try/catch` deve cobrir leitura e escrita; o app não pode depender de SW para funcionar.
- **Deveria:** teste manual documentado (duplo clique no Windows; Chrome e Firefox), verificação de que **não há erro de console bloqueante** e que cálculo/persistência funcionam (ou degradam sem mensagem alarmante). PWA (instalar/offline via SW) **não** existe em `file://` — README deve dizer isso explicitamente.

#### BUG-17 — Manifest gerado em runtime: detalhes de robustez (P2)

- O `<link rel="manifest">` é criado **depois** do parse do documento, no fim do script (`index.html:374-377`). Navegadores processam manifest dinâmico, mas a promoção de instalação pode ser avaliada antes do link existir (primeiros segundos); o ideal é `<link rel="manifest">` estático no `<head>` (o WIP v2 já fez isso).
- `start_url: "."` / `scope: "."` relativos a uma URL `data:`: a spec manda resolver contra a URL do manifest; falhando, `start_url` cai para a URL do documento e o `scope` deriva dela. Na prática o app instalado deve abrir a página certa, mas isso depende do engine/versão e de bugs conhecidos de manifest inline. **Requisito:** manifest estático com `start_url`/`scope` explícitos (ou absolutos calculados em runtime), e teste de instalação nos dois sistemas.
- Faltam `id`, `lang`, `dir`, `display_override`, `shortcuts`, `screenshots`, `categories`; `orientation: portrait` sem justificativa. Nenhum é obrigatório; `id` evita reinstalação duplicada ao mudar `start_url`.
- Ícone com `purpose: "any"` apenas; sem `maskable` (Android mostra círculo branco/recorte feio).
- **Evidência:** `index.html:346-377`.

#### BUG-18 — Formatação/arredondamento: decisão mais fina que o exibido (P2)

- O índice é exibido com **1 decimal** (`fmt(pct,1)`), mas a decisão usa 3+ casas (ex.: 70,04% → exibe "70,0%" e decide empate; 70,05% → exibe "70,1%"); o `gap` é exibido com 1 decimal, então diferenças de 0,04–0,05 p.p. aparecem como "0,0"/"0,1" e ativam textos imprecisos ("exatamente no limite").
- `fmt` pt-BR usa arredondamento do `Intl` (ex.: `70.05 → "70,1"`, `1.005 → "1,0"`, `0.049 → "0,0"`); a v2 precisa de testes de formatação congelados (ver F-01..F-16) para não "consertar" para outro comportamento sem querer.
- `toLocaleString("pt-BR")` é explícito (bom); porém números gigantes geram strings longas (BUG-07) e `-0` gera "-0,0".
- **Evidência:** `index.html:256-258,284,313-316,324-325`; harness §2.

#### BUG-19 — Service worker: detalhes além do cache velho (P2)

- O handler intercepta **qualquer GET**, inclusive cross-origin (`sw.js:19-24`), sem filtro de origem; offline, um GET externo (link, recurso) rejeita e vira erro de rede no `respondWith`. Não há fallback para navegação não precacheada (ex.: `/repo` sem barra final, `?utm=...`).
- `registration` falha é engolida (`index.html:382`): usuário não sabe que ficou sem offline. Não há `registration.update()` em `visibilitychange`; em hosts com `max-age` (GitHub Pages) a checagem periódica de 24 h pode atrasar atualização.
- `skipWaiting()` incondicional no install (`sw.js:7`) + `clients.claim()` no activate (`sw.js:15`): o SW novo assume controle sem a página recarregar; com cache-first, o resultado é uma mistura de versões até o próximo reload (risco de estado inconsistente).
- Não há versão/hash do conteúdo no nome do cache; o processo de release depende de lembrar de mudar `CACHE`.
- **Deveria:** network-first para navegação com fallback offline, precache com `cache:"reload"`, versionamento explícito por release, limpeza só do prefixo próprio, update avisado ("nova versão — recarregar"), filtro de origem/método e fallback para navegação. **No WIP v2 observado, `sw.js` já caminha nessa direção** (VERSION, network-first, add() com catch, prefixo) — o que falta é teste automatizado/checklist de release e a UX de update.

---

## 2. Matriz de casos de teste para a v2

**Convenções**
- Valores do CORE em fração/percentual com até 3 decimais quando útil; exibição de índice/limite/gap em **p.p. com 1 decimal** (pt-BR), custos em **R$ com 2 decimais**.
- `EPS_PP = 0,5` (p.p.) como tolerância de empate — se o Lead adotar outra semântica (`≤`, tolerância relativa), atualizar **um único lugar** e esta matriz.
- Fronteiras marcadas com `*` exigem decisão explícita e teste congelado (hoje o float decide — BUG-04).
- "Erro" = estado de validação visível no campo + sem veredito (não confundir com "vazio").
- Sugestão de organização da suíte: `node tools/test.mjs` (CORE puro) + `node tools/test-dom.mjs` (estrutura/DOM/a11y estática) + checklist manual de PWA/SW (§4). Sem dependências.

### 2.1 Parser de número — `parseNumber` (preço, consumo, limite salvo)

| ID | Entrada | Saída esperada | Estado/observação |
|---|---|---|---|
| P-01 | `"5,89"` | `5.89` | ok |
| P-02 | `"5.89"` | `5.89` | ok |
| P-03 | `"1.234,56"` | `1234.56` | milhar BR |
| P-04 | `"1,234.56"` | `1234.56` | en-US: último separador decimal |
| P-05 | `"1.234.567,89"` | `1234567.89` | |
| P-06 | `"1,234,567.89"` | `1234567.89` | |
| P-07 | `"R$ 5,89"` | `5.89` | limpar moeda |
| P-08 | `"r$5,89"` | `5.89` | |
| P-09 | `" 5,89 "` | `5.89` | trim |
| P-10 | `"\u00a05,89"` | `5.89` | NBSP |
| P-11 | `"5,"` | `5` | digitando (não piscar erro) |
| P-12 | `",5"` | `5` | digitando |
| P-13 | `"10,5 km/L"` | `10.5` | unidade removida |
| P-14 | `"7,3km/l"` | `7.3` | |
| P-15 | `"5,89 reais"` | `5.89` | |
| P-16 | `"1.234"` | `1234` | ponto como milhar (decisão explícita) |
| P-17 | `"12.34"` | `12.34` | ponto decimal |
| P-18 | `""`, `"   "`, `null`, `undefined` | `NaN` | estado **empty**, não erro |
| P-19 | `"abc"`, `"R$"`, `","`, `"."`, `"5,8,9"`, `"5.8.9"`, `"1e3"`, `"1.2.3"`, `"NaN"`, `"Infinity"`, `"0x10"`, `"0b11"`, `"+3"`, `"-3"`, `"5 89"`, `"5,89 kg"` | `NaN` | estado **invalid** |
| P-20 | `"0"`, `"0,00"` | `0` (parse) / inválido (parsePositive) | erro "maior que zero" |
| P-21 | `"999999999999999999999"`, `"1e309"`, `"5e-324"` | `NaN` ou rejeitado por faixa | nunca chegar ao DOM |
| P-22 | `"５,89"` (dígitos fullwidth) | `NaN` | hoje o parser do WIP cairia em `89` — teste de regressão |
| P-23 | `"1.234,5"` | `1234.5` | |
| P-24 | `"5."` / `"."` | `5` / `NaN` | |
| P-25 | `"0,001"` | `0.001` parse; inválido como preço (faixa) | faixa |
| P-26 | `"999"` (preço) | `999` parse; inválido por faixa (preço > 99,99) | faixa |
| P-27 | `"0,1"` (consumo) | `0.1` parse; válido? decidir faixa mínima | faixa |
| P-28 | `"120"` (consumo) | inválido/acima da faixa | faixa |
| P-29 | texto de 1 MB | truncado/rejeitado sem travar (limite `maxlength` 12) | robustez |
| P-30 | `parse(fmt(n))` para `n` em {0.01, 5.89, 1234.56} | ≈ n (±0,01) | round-trip de exibição |

**Funções de apoio exigidas:** `priceStatus(raw) ∈ {empty, ok, invalid}` (v1 não tem), `parsePositive`, `clamp`, e um único ponto de faixa (`PRICE_MIN/MAX`, `CONSUMPTION_MIN/MAX`) reutilizado pelo parser, pelo render e pelos testes.

### 2.2 Modo rápido — `fastResult(gas, etanol, limite%)`

| ID | Gasolina | Etanol | Limite | Índice % | Δ p.p. | Veredito | Texto de distância esperado |
|---|---|---|---|---|---|---|---|
| Q-01 | 5,89 | 3,99 | 70 | 67,742 | −2,258 | ETANOL | "2,3 p.p. abaixo do limite" |
| Q-02 | 5,89 | 4,20 | 70 | 71,307 | +1,307 | GASOLINA | "1,3 p.p. acima do limite" |
| Q-03 | 5,89 | 4,20 | 71 | 71,307 | +0,307 | EMPATE | "dentro da margem (±0,5 p.p.)" |
| Q-04 | 5,89 | 4,20 | 72 | 71,307 | −0,693 | ETANOL | "0,7 p.p. abaixo do limite" |
| Q-05 | 10,00 | 7,00 | 70 | 70,000 | 0,000 | EMPATE | "exatamente no limite" |
| Q-06 | 10,00 | 7,04 | 70 | 70,400 | +0,400 | EMPATE | "dentro da margem (±0,5 p.p.)" |
| Q-07 | 10,00 | 7,06 | 70 | 70,600 | +0,600 | GASOLINA | "0,6 p.p. acima do limite" |
| Q-08 | 10,00 | 6,96 | 70 | 69,600 | −0,400 | EMPATE | "dentro da margem" |
| Q-09 | 10,00 | 6,94 | 70 | 69,400 | −0,600 | ETANOL | "0,6 p.p. abaixo do limite" |
| Q-10* | 10,00 | 7,05 | 70 | 70,500 | +0,500 | GASOLINA (se `<` estrito) | "0,5 p.p. acima" |
| Q-11* | 10,00 | 6,95 | 70 | 69,500 | −0,500 | ETANOL (se `<` estrito) | "0,5 p.p. abaixo" |
| Q-12 | 5,00 | 2,99 | 60 | 59,800 | −0,200 | EMPATE | "dentro da margem" |
| Q-13 | 5,00 | 3,05 | 60 | 61,000 | +1,000 | GASOLINA | "1,0 p.p. acima" |
| Q-14 | 5,00 | 3,99 | 80 | 79,800 | −0,200 | EMPATE | "dentro da margem" |
| Q-15 | 5,00 | 4,05 | 80 | 81,000 | +1,000 | GASOLINA | "1,0 p.p. acima" |
| Q-16 | 5,00 | 6,00 | 70 | 120,000 | +50,000 | GASOLINA | "50,0 p.p. acima"; gauge fora da faixa |
| Q-17 | 5,00 | 5,00 | 70 | 100,000 | +30,000 | GASOLINA | "30,0 p.p. acima" |
| Q-18 | 6,19 | 4,33 | 70 | 69,951 | −0,048 | EMPATE | exibe "70,0%" e "exatamente no limite" (caso de arredondamento a documentar) |
| Q-19 | 5,00 | 3,50 | 70 | 70,000 | 0,000 | EMPATE | exato; gauge/dot consistentes com empate |
| Q-20* | 5,00 | 3,475 | 70 | 69,500 | −0,500 | ETANOL | hoje empate por float (BUG-04) |
| Q-21* | 5,00 | 3,425 | 68 | 68,500 | +0,500 | GASOLINA | hoje empate |
| Q-22* | 5,00 | 3,575 | 72 | 71,500 | −0,500 | ETANOL | hoje empate |
| Q-23* | 5,00 | 3,925 | 78 | 78,500 | +0,500 | GASOLINA | hoje empate |
| Q-24 | 5,00 | 3,51 | 70 | 70,200 | +0,200 | EMPATE | texto **não** pode dizer "acima" sozinho (BUG-03) |
| Q-25 | 5,00 | 3,49 | 70 | 69,800 | −0,200 | EMPATE | idem para "abaixo" |
| Q-26 | 5,89 | 4,20 | 70,5 | 71,307 | +0,807 | GASOLINA | limite fracionário aceito se UI permitir |
| Q-27 | 6,00 | 4,20 | 70 | 70,000 | 0,000 | EMPATE | exato; cor do gauge âmbar |
| Q-28 | 6,00 | 4,21 | 70 | 70,167 | +0,167 | EMPATE | margem |
| Q-29 | 6,00 | 4,24 | 70 | 70,667 | +0,667 | GASOLINA | |
| Q-30 | 6,00 | 4,16 | 70 | 69,333 | −0,667 | ETANOL | |

### 2.3 Modo preciso — `preciseResult(gas, etanol, km/L gas, km/L etanol)`

Fórmulas: `custo/km = preço ÷ consumo`; `custo/100 km = custo/km × 100`; `índice = P_e/P_g`; `limite pessoal = C_e/C_g`; veredito = comparação `índice` × `limite pessoal` com `EPS_PP = 0,5`; `economia/100 km = |custo100(g) − custo100(e)|` **indicando qual combustível economiza**; `preço de equilíbrio do etanol = P_g × C_e/C_g`; `preço de equilíbrio da gasolina = P_e ÷ (C_e/C_g)`.

**Decisão e índice:**

| ID | P_g | P_e | C_g km/L | C_e km/L | Índice % | Limite pessoal % | Δ p.p. | Veredito |
|---|---|---|---|---|---|---|---|---|
| C-01 | 5,89 | 3,99 | 10,5 | 7,3 | 67,742 | 69,524 | −1,782 | ETANOL |
| C-02 | 5,89 | 4,50 | 10,5 | 7,3 | 76,401 | 69,524 | +6,877 | GASOLINA |
| C-03 | 5,00 | 3,50 | 10 | 7 | 70,000 | 70,000 | 0,000 | EMPATE |
| C-04 | 5,00 | 3,46 | 10 | 7 | 69,200 | 70,000 | −0,800 | ETANOL |
| C-05 | 5,00 | 3,56 | 10 | 7 | 71,200 | 70,000 | +1,200 | GASOLINA |
| C-06 | 5,00 | 3,53 | 10 | 7 | 70,600 | 70,000 | +0,600 | GASOLINA |
| C-07 | 5,00 | 3,51 | 10 | 7 | 70,200 | 70,000 | +0,200 | EMPATE |
| C-08 | 5,00 | 4,90 | 10 | 10 | 98,000 | 100,000 | −2,000 | ETANOL |
| C-09 | 5,00 | 4,90 | 10 | 9 | 98,000 | 90,000 | +8,000 | GASOLINA |
| C-10 | 5,89 | 4,094952 | 10,5 | 7,3 | 69,524 | 69,524 | ≈0,000 | EMPATE (preço de equilíbrio) |
| C-11 | 5,00 | 3,55 | 10 | 7,1 | 71,000 | 71,000 | 0,000 | EMPATE |
| C-12 | 5,00 | 5,00 | 10 | 12 | 100,000 | 120,000 | −20,000 | ETANOL (limite pessoal > 100%; gauge fora da faixa, texto obrigatório) |
| C-13 | 3,00 | 2,10 | 8 | 5,6 | 70,000 | 70,000 | 0,000 | EMPATE (outra escala) |
| C-14 | 8,99 | 6,99 | 12 | 8,4 | 77,753 | 70,000 | +7,753 | GASOLINA |
| C-15 | 4,00 | 2,80 | 7 | 5 | 70,000 | 71,429 | −1,429 | ETANOL |
| C-16 | 4,00 | 2,90 | 7 | 5 | 72,500 | 71,429 | +1,071 | GASOLINA |
| C-17 | 4,00 | 2,87 | 7 | 5 | 71,750 | 71,429 | +0,321 | EMPATE |
| C-18 | 4,00 | 2,86 | 7 | 5 | 71,500 | 71,429 | +0,071 | EMPATE (arredondamento de exibição: 71,5% × 71,4%) |

**Custos, economia e equilíbrio (mesmas entradas):**

| ID | Custo/100 km gasolina | Custo/100 km etanol | Economia/100 km | Equilíbrio etanol (R$/L) | Equilíbrio gasolina (R$/L) | Litros/100 km (g / e) |
|---|---|---|---|---|---|---|
| C-01 | R$ 56,10 | R$ 54,66 | R$ 1,44 (etanol) | 4,09 | 5,74 | 9,52 / 13,70 |
| C-02 | R$ 56,10 | R$ 61,64 | R$ 5,55 (gasolina) | 4,09 | 6,47 | 9,52 / 13,70 |
| C-03 | R$ 50,00 | R$ 50,00 | R$ 0,00 | 3,50 | 5,00 | 10,00 / 14,29 |
| C-04 | R$ 50,00 | R$ 49,43 | R$ 0,57 (etanol) | 3,50 | 4,94 | 10,00 / 14,29 |
| C-05 | R$ 50,00 | R$ 50,86 | R$ 0,86 (gasolina) | 3,50 | 5,09 | 10,00 / 14,29 |
| C-06 | R$ 50,00 | R$ 50,43 | R$ 0,43 (gasolina) | 3,50 | 5,04 | 10,00 / 14,29 |
| C-07 | R$ 50,00 | R$ 50,14 | R$ 0,14 (gasolina) | 3,50 | 5,01 | 10,00 / 14,29 |
| C-08 | R$ 50,00 | R$ 49,00 | R$ 1,00 (etanol) | 5,00 | 4,90 | 10,00 / 10,00 |
| C-09 | R$ 50,00 | R$ 54,44 | R$ 4,44 (gasolina) | 4,50 | 5,44 | 10,00 / 11,11 |
| C-10 | R$ 56,10 | R$ 56,10 | R$ 0,00 | 4,09 | 5,89 | 9,52 / 13,70 |
| C-11 | R$ 50,00 | R$ 50,00 | R$ 0,00 | 3,55 | 5,00 | 10,00 / 14,08 |
| C-12 | R$ 50,00 | R$ 41,67 | R$ 8,33 (etanol) | 6,00 | 4,17 | 10,00 / 8,33 |

**Regras do modo preciso que os testes devem travar:**
- À direita da vírgula: exibir 2 decimais para R$ e 1 decimal para %; nunca exibir `NaN`/`Infinity`/`-0,0`; texto explícito de qual combustível economiza e de que a economia é por 100 km.
- Se `C_e = C_g` → limite pessoal 100% e o etanol só vence se for mais barato.
- Se `C_e > C_g` (fisicamente incomum) → limite pessoal > 100%; rotular claramente e não quebrar o gauge.
- O modo rápido deve ser exatamente o caso particular `preciseResult` com `C_e/C_g = limite/100` (teste de consistência: Q-01 e C-01 com limite pessoal 67,742%? não — teste de equivalência usando `limite = 100·C_e/C_g`, ex.: C-03 com limite 70 → Q-05).

### 2.4 Formatação/arredondamento pt-BR

| ID | Chamada | Esperado |
|---|---|---|
| F-01 | `fmtNum(67.7419, 1)` | `"67,7"` |
| F-02 | `fmtNum(70.049, 1)` | `"70,0"` |
| F-03 | `fmtNum(70.05, 1)` | `"70,1"` (`Intl`; documentar) |
| F-04 | `fmtNum(1.005, 1)` | `"1,0"` (binário; documentar — não "consertar" sem decisão) |
| F-05 | `fmtNum(-0, 1)` | `"0,0"` (normalizar `-0`; v1/WIP atual tende a "-0,0") |
| F-06 | `fmtNum(NaN,1)` / `fmtNum(Infinity,1)` | `"—"` |
| F-07 | `fmtNum(1234.5, 1)` | `"1.234,5"` |
| F-08 | `fmtBRL(5.89)` | `"R$ 5,89"` |
| F-09 | `fmtBRL(1234.5)` | `"R$ 1.234,50"` |
| F-10 | `fmtBRL(1.4377)` | `"R$ 1,44"` |
| F-11 | `fmtBRL(0)` | `"R$ 0,00"` |
| F-12 | `pctLabel(70)` | `"70%"` |
| F-13 | `pctLabel(71.5)` | `"71,5%"` |
| F-14 | `pctLabel(69.95)` | `"70%"` (arredonda para 1 decimal) |
| F-15 | `pctLabel(100)` | `"100%"` |
| F-16 | `pctLabel(NaN)` | `"—"` |
| F-17 | gap `+0,31` p.p. / `+0,049` p.p. / `+0,5` p.p. | `"0,3"` / "dentro da margem" (não "exatamente") / `"0,5"` |
| F-18 | `shareText(fastResult(5.89,3.99,70))` | contém "ETANOL", "67,7%", "70%", "R$ 5,89"; não contém NaN/undefined; ≤ 200 chars |
| F-19 | `shareText(preciseResult(5.89,3.99,10.5,7.3))` | contém "R$ 54,66", "R$ 56,10", "ETANOL" |
| F-20 | `shareText(null)` | `""` |

### 2.5 Gauge

| ID | Entrada | Esperado |
|---|---|---|
| G-01 | `gaugePos(55)` | `0` (mín. da escala) |
| G-02 | `gaugePos(85)` | `100` |
| G-03 | `gaugePos(70)` | `50` |
| G-04 | `gaugePos(69.524)` | `48,4` |
| G-05 | `gaugePos(54)` / `(40)` / `(NaN)` | `0` e `gaugeOutside = true` |
| G-06 | `gaugePos(86)` / `(120)` | `100` e `gaugeOutside = true` |
| G-07 | limite 60 e 80 | marcador em 0%/100% sem sair do card; rótulo legível; sem overflow |
| G-08 | nível 59,5% / 70% / 81% | posição monotônica, sem `NaN`, sem `Infinity` no style |
| G-09 | empate | cor do marcador do índice em âmbar (ou neutra), nunca verde/azul de um veredito |
| G-10 | fora da faixa | texto explícito "abaixo/acima da faixa do gauge" (clamp não pode enganar) |

### 2.6 Estados inválidos/de validação

| ID | Ação | Esperado |
|---|---|---|
| E-01 | Tudo vazio | estado inicial "Informe os dois preços…", sem erro vermelho |
| E-02 | Só gasolina | mensagem específica "Informe o preço do etanol" (não genérica) |
| E-03 | Só etanol | "Informe o preço da gasolina" |
| E-04 | `"abc"` em um campo | erro de formato no campo; `aria-invalid="true"`; sem veredito; resultado anterior limpo/esmaecido |
| E-05 | `"R$ 5,89"` | aceito = 5,89; erro nenhum |
| E-06 | `"1,234.56"` | 1234,56 (não 1,23456) |
| E-07 | `"5,8,9"` | erro de formato |
| E-08 | `"0"` / `"-3"` | erro "preço deve ser maior que zero" |
| E-09 | `"1e3"` / `"0x10"` / `"0b11"` | erro de formato |
| E-10 | preço > 99,99 | erro de faixa ("confira o preço") |
| E-11 | preço > 20 e ≤ 99,99 | aviso não bloqueante ("preço fora do usual") |
| E-12 | consumo `"0"`, `"-1"`, `"abc"` | erro específico de consumo; sem resultado |
| E-13 | consumo > 99,9 | erro/aviso de faixa |
| E-14 | consumo com unidade `"10,5 km/L"` | aceito |
| E-15 | limite salvo `"abc"` / `"0"` / `"100"` | fallback determinístico (70) ou clamp + coerência com presets; nunca `NaN%` |
| E-16 | storage JSON corrompido (v2) | defaults sem crash e sem tela quebrada |
| E-17 | localStorage bloqueado | app funciona; persistência silenciosamente indisponível; sem exceção não tratada |
| E-18 | colar 1 MB | truncado/rejeitado; sem travar |
| E-19 | payload `<img src=x onerror=...>` em qualquer campo | exibido como texto/erro; **não** executa |
| E-20 | payload no nome do veículo (v2) | escapado (`textContent`); não executa |
| E-21 | alternar rápido ↔ preciso | valores compatíveis preservados; resultados não se misturam |
| E-22 | Enter em campo de texto | fecha teclado/confirma (não submete formulário) |
| E-23 | mudar limite após resultado | recálculo imediato e coerente |
| E-24 | modo preciso com só 3 dos 4 campos | mensagem aponta o campo faltante específico |

### 2.7 Persistência/estado

| ID | Caso | Esperado |
|---|---|---|
| S-01 | round-trip: preços, limite, consumos, modo, perfil | restaurados exatamente (formatos válidos) |
| S-02 | storage com valores inválidos | ignorados; defaults; sem crash |
| S-03 | migração v1 (`ac_gas`, `ac_eta`, `ac_threshold`) | importa valores válidos; não quebra; remove/marca chaves antigas |
| S-04 | quota cheia no `setItem` | `catch`; app funcional; aviso discreto |
| S-05 | storage bloqueado (Safari antigo/iframe) | `catch`; app funcional |
| S-06 | JSON corrompido de versão futura | ignorado; defaults |
| S-07 | limpar dados | volta ao estado inicial; presets/limite/modo coerentes |
| S-08 | duas abas abertas | gravações não corrompem; (opcional) sincronização via `storage` |
| S-09 | perfil sem nome | texto padrão; sem HTML cru |
| S-10 | dados salvos de preço fora da faixa | não persistir ou marcar inválido na restauração |

### 2.8 Estrutura/HTML/segurança (testes estáticos automatizáveis)

| ID | Verificação | Esperado |
|---|---|---|
| H-01 | IDs referenciados no JS existem; sem IDs duplicados | ok (v2 já tem esse teste) |
| H-02 | `<label for>` de todo campo; slider e grupos com nome acessível | ok |
| H-03 | nenhum recurso externo obrigatório (`<script src>`, `<link href>` externos, `@import`) | ok (offline-first) |
| H-04 | `lang="pt-BR"`, `meta viewport` sem `maximum-scale`/`user-scalable=no` | ok |
| H-05 | `theme-color`, `color-scheme` dark, `<link rel="manifest">` estático, apple meta + icon PNG | ok |
| H-06 | nenhum `innerHTML` recebendo dado do usuário; `textContent` para dados | ok |
| H-07 | `<script>` inline sem `eval`/`new Function`, sem `fetch` no boot | ok |
| H-08 | `node --check` no JS inline e no `sw.js` | ok |
| H-09 | arquivo único de app (CSS/JS inline), sem build; artefatos PWA declarados no README | ok/decisão |
| H-10 | core extraído por marcador único (ou `AC` exposto) e testado sem DOM | ok |
| H-11 | `manifest.webmanifest` válido, JSON parseável, `icons` 192/512/maskable, arquivos existem | ok |
| H-12 | `sw.js` contém `VERSION`, precache de arquivos existentes, filtro de origem e prefixo de limpeza | ok |
| H-13 | HTML não tem IDs/classes referenciados por CSS inexistentes (smoke) | opcional |
| H-14 | tamanho do app (HTML+CSS+JS) razoável (≤ ~80 KB), sem imagens pesadas | ok |

### 2.9 `file://` (checklist manual, requisito P0)

| ID | Caso | Esperado |
|---|---|---|
| L-01 | Duplo clique em `index.html` (Chrome/Firefox desktop) | App renderiza e calcula normalmente; CSS/JS inline completos |
| L-02 | Registro do SW em `file://` | Não tenta registrar (guard de protocolo) e **não** lança erro bloqueante no console |
| L-03 | Boot em `file://` | Nenhum `fetch()` de arquivo local necessário para a UI e o cálculo; links `manifest`/ícones são passivos e podem falhar sem quebrar o app |
| L-04 | `localStorage` disponível | Preços/limite/consumos restaurados normalmente |
| L-05 | `localStorage` bloqueado no `file://` | `try/catch` cobre leitura e escrita; app funcional sem persistência e sem exceção não tratada |
| L-06 | Cálculo e veredito em `file://` | Idênticos ao servido em HTTPS (mesmo CORE) |
| L-07 | Documentação | README explica que em `file://` **não** há PWA/SW/instalação; uso mobile via HTTPS/localhost |

### 2.10 Invariantes / property-based (sem dependências; `node:test` + gerador determinístico)

| ID | Invariante |
|---|---|
| I-01 | Escalar ambos os preços por `k > 0` não muda índice nem veredito (tolerância 1e-9). |
| I-02 | `fastResult` nunca retorna `verdict` fora de `{etanol, gasolina, empate}`; `pct`/`diffPp` finitos ou `null`. |
| I-03 | Aumentar `P_etanol` (demais fixos) nunca muda veredito de ETANOL para outro que não GASOLINA/EMPATE na direção esperada (monotonicidade). |
| I-04 | `preciseResult` com `C_e/C_g = limite/100` reproduz exatamente `fastResult` (status, índice, veredito) nos mesmos preços. |
| I-05 | `savingsPer100 = |per100Gas − per100Eta|` e `breakEvenEta`/`breakEvenGas` satisfazem as fórmulas com tolerância 1e-6. |
| I-06 | `gaugePos` é monotônica não decrescente e ∈ [0,100]; `gaugeOutside` verdadeiro exatamente fora de [55,85]. |
| I-07 | Nenhuma string renderizada contém `"NaN"`, `"undefined"`, `"Infinity"`, `"null"` (varredura de todos os textos). |
| I-08 | `parseNumber` nunca lança exceção para nenhuma string de 0–64 chars (fuzz 10k seeds). |
| I-09 | `fmtNum(n, d)` idempotente e independente do locale do ambiente (forçar pt-BR). |
| I-10 | Estado restaurado + recalculado == estado calculado na sessão (idempotência). |
| I-11 | `shareText(resultado)` não contém NaN/undefined e sempre contém o veredito. |
| I-12 | Fuzz de preços/consumos uniformes/log: com faixas válidas, nunca gera ∞/NaN nem estoura o card (verificação de tamanho de texto). |

---

## 3. Acessibilidade e UX mobile

### 3.1 Achados (v1) e correções exigidas

| ID | Achado na v1 | Critério | Sev. | Correção exigida na v2 |
|---|---|---|---|---|
| A-01 | Resultado dinâmico não anunciado | WCAG 4.1.3 | P1 | Região `role="status" aria-live="polite"` para o veredito; anunciar erro em `role="alert"`/`aria-live="assertive"`. **Debounce** (ex.: 400 ms após parar de digitar) para não spammar a cada tecla. |
| A-02 | Slider sem nome acessível | 1.3.1 / 4.1.2 | P1 | `<label for="threshold">` visível ou `aria-labelledby`; `aria-valuetext="70 por cento"`; `aria-describedby` da escala. |
| A-03 | Presets sem estado exposto e estado só por cor | 1.4.1 / 4.1.2 | P1 | `aria-pressed` nos botões (ou `role="radio"` + `aria-checked` no grupo), agrupamento com `role="group"`/`fieldset`; indicador não cromático (✓/borda). |
| A-04 | Range com `outline: none` e sem foco visível | 2.4.7 | P1 | `:focus-visible` com anel de ≥3:1; nunca remover sem substituto; testar Tab. |
| A-05 | Sem erro de validação visível/associado | 3.3.1 / 3.3.3 | P1 | Mensagem por campo + `aria-invalid` + `aria-describedby`; foco no primeiro campo inválido ao tentar confirmar; texto com sugestão ("use 5,89"). |
| A-06 | Contraste: placeholder 2,47:1; borda de input 1,23:1; borda de card 1,21:1 | 1.4.3 / 1.4.11 | P1 | Placeholder e textos ≥4,5:1; contorno/fundo de campo com ≥3:1 (ex.: borda mais clara); verificar também foco e estados. |
| A-07 | Alvos de toque pequenos: range 6 px de altura, summary ~19,5 px, link do rodapé 11 px | 2.5.8 / 2.5.5 | P1 | Range com trilho visual de 6 px mas **área de toque ≥44 px** (padding/wrapper); summary com padding vertical; botões de modo/tab ≥44 px. |
| A-08 | Sem `prefers-reduced-motion`; transições .12–.25 s | 2.3.3 (AAA) / boa prática | P2 | `@media (prefers-reduced-motion: reduce) { * { transition: none; animation: none } }`. |
| A-09 | Sem `color-scheme`/`forced-colors`; tema só escuro | 1.4.3 / 1.4.11 | P2 | `<meta name="color-scheme" content="dark">`; regras `@media (forced-colors: active)` para bordas/foco; (opcional) tema claro via `prefers-color-scheme`. |
| A-10 | SVGs de veredito sem `aria-hidden`; `"＋"` do summary por pseudo-elemento | 1.1.1 / 4.1.2 | P2 | `aria-hidden="true"` nos ícones decorativos; texto do summary via conteúdo real; gauge decorativo com `aria-hidden` e resumo textual equivalente. |
| A-11 | Resultado sem heading; card sem região nomeada | 1.3.1 / 2.4.6 | P2 | `<h2>Resultado</h2>` (visualmente oculto se necessário) e `section aria-labelledby`. |
| A-12 | Sem `<noscript>` | 1.1.1 / robustez | P2 | `<noscript>` explicando que o cálculo exige JavaScript e que os dados não saem do aparelho. |
| A-13 | `inputmode="decimal"` presente; sem `enterkeyhint`, `autocapitalize`, `spellcheck` | 1.4.4 / UX | P2 | Manter `inputmode="decimal"`; `enterkeyhint="done"`; `autocapitalize="off" spellcheck="false"`; `font-size ≥16px` (evitar zoom iOS). |
| A-14 | Zoom permitido (bom); sem teste de reflow a 320 px com números grandes | 1.4.4 / 1.4.10 | P2 | Não usar `maximum-scale`; testar 320×568 e fonte 200%; quebrar/limitar números grandes. |
| A-15 | Sem verificação com leitor de tela | 4.1.x | P1 | Teste manual VoiceOver (iOS) e TalkBack (Android): preencher preços, ouvir veredito, erro, slider e presets. |

### 3.2 Contraste medido (v1, calculado no harness)

Fundo: `--bg #0b1020`, `--card #121a2e`, `--card-2 #0d1526`. Limiares: 4,5:1 texto normal; 3:1 texto grande e elementos não textuais.

| Par | Razão | Veredito |
|---|---|---|
| Texto `#e6edf7` / card | **14,69:1** | ok |
| Muted `#8a97b0` / card (13 px) | **5,88:1** | ok |
| Muted / card-2 (presets) | **6,19:1** | ok |
| Muted / bg (footer 11 px) | **6,43:1** | ok |
| Veredito verde `#4ade80` / fundo verde | **7,84:1** | ok |
| Veredito azul `#60a5fa` / fundo azul | **5,68:1** | ok |
| Veredito âmbar `#fbbf24` / fundo âmbar | **8,23:1** | ok |
| Link `#60a5fa` / card | **6,81:1** | ok |
| **Placeholder `#4a566e` / card-2** | **2,47:1** | **falha** (texto normal) |
| **Borda do input `rgba(255,255,255,.08)` / card-2** | **1,23:1** | **falha** (não textual/limite de campo) |
| **Borda do card / bg** | **1,21:1** | baixa (decorativa; não é limite de campo) |
| Anel de foco azul `#3b82f6` / card-2 | **4,95:1** | ok (não textual) |

**Recomendações de contraste:** placeholder `#8a97b0` ou mais claro (≥4,5:1); borda de input `#2a3a5c`/equivalente ≥3:1 contra o fundo do campo e do card; garantir que o anel de foco tenha ≥3:1 também contra o fundo do campo; manter os vereditos como estão.

### 3.3 UX mobile — requisitos e riscos de regressão

| ID | Requisito de UX | Risco de regressão na v2 |
|---|---|---|
| U-01 | Resultado visível sem rolar: em 360×640 e com teclado aberto, mostrar resumo fixo/sticky ou rolar automaticamente quando o resultado fica válido | Layout maior da v2 (perfil, modo, cards) empurra o resultado para fora da dobra |
| U-02 | Fluxo rápido: digitar 2 preços → veredito em ≤ 2 s, sem toques extras | Novos campos do perfil/modo aumentam fricção; manter modo rápido como default |
| U-03 | Teclado: `inputmode="decimal"`, font ≥16 px (sem zoom iOS), Enter/`enterkeyhint` para fechar | Inputs menores que 16 px reintroduzem zoom no iOS |
| U-04 | Slider fácil de arrastar (área ≥44 px) e presets 70/71 com 1 toque; feedback de valor | Custom slider da v2 pode piorar o alvo/teclado |
| U-05 | Erros claros por campo, sem "piscar" durante digitação ("5," é estado válido de digitação) | Validação agressiva no `input` gera UX ruim; validar em `blur` ou com debounce |
| U-06 | Persistência perceptível e reversível ("limpar dados") | Esconder o perfil/estado sem indicar o que foi salvo |
| U-07 | Preços plausíveis: aviso para valores fora de 2–20 R$/L e para consumo fora de 2–30 km/L | Bloqueio excessivo de valores legítimos (GNV, etanol, região) — avisar, não bloquear |
| U-08 | Números grandes não quebram o card (limitar/formatar/truncar com "—") | v2 exibe custo/100 km, economia e equilíbrio — mais números para vazar |
| U-09 | Modo claro/escuro e alto contraste; textos legíveis ao sol | Tema escuro fixo da v1 mantido por inércia |
| U-10 | Orientação livre (remover `orientation: portrait` ou justificar) | Prender retrato em tablets/landscape |
| U-11 | `100dvh`/`svh`, safe-area, barras do iOS | `100vh` com barras dinâmicas |
| U-12 | Link externo com aviso de saída? (não obrigatório) e `rel="noopener"` | — |
| U-13 | Estado de compartilhamento (share/copiar) com texto pt-BR correto e sem números inválidos | v2 já prevê `shareText`; testar F-18/F-19 |
| U-14 | Instalar app acessível (CTA opcional `beforeinstallprompt`, sem bloquear) | Instalar via `data:` manifest / sem ícones adequados |
| U-15 | Respeitar preferências: `prefers-reduced-motion`, `prefers-color-scheme` (opcional), `prefers-contrast` | Animações novas em gauge/cards |

**Riscos de regressão de a11y na v2 (específicos da reescrita):** mover conteúdo para novos cards/modos sem manter labels e ordem de tabulação; substituir `input` nativo por máscara custom (perde `inputmode`, seleção, autofill, leitor de tela); slider custom com `role=slider` incompleto (sem `aria-valuemin/max/now` e teclado); resultado em `<canvas>`/SVG sem alternativa textual; toast de erro sem `aria-live`; foco preso em modais/perfil; botões-ícone sem `aria-label`; estado ativo por cor de tab.

---

## 4. Riscos de service worker

### 4.1 Análise da v1 (evidência)

| # | Risco | Detalhe/reprodução | Sev. |
|---|---|---|---|
| SW-01 | **Cache velho após deploy** | `CACHE` fixo + cache-first; deploy só do `index.html` → app antigo eterno (BUG-01) | **P0** |
| SW-02 | Instalação abortada por 1 arquivo | `addAll` rejeita se qualquer URL falhar; SW nunca ativa; offline nunca funciona; erro engolido na página | P1 |
| SW-03 | Limpeza de cache destrutiva | `activate` apaga todos os caches da origem, não só do app (GitHub Pages compartilha origem) | P1 |
| SW-04 | Precache pode pegar HTML velho do cache HTTP | `addAll`/`add` sem `cache:"reload"`; hosts com `max-age` (GitHub Pages) | P1 |
| SW-05 | Sem UX de atualização | `skipWaiting` incondicional; usuário não é avisado; mistura de versões até reload | P2 |
| SW-06 | Offline parcial | Só `./` e `./index.html` precacheados; navegação com `?query`/sem barra não tem fallback; offline no 1º acesso falha (esperado) | P2 |
| SW-07 | Erros silenciosos no registro | `register(...).catch(() => {})`; usuário não sabe que está sem offline | P2 |
| SW-08 | `file://` | SW não registra (guard correto); não é PWA offline em file:// | ok/documentar |
| SW-09 | Escopo/subpasta | GitHub Pages em `/repo/`: `./sw.js` e escopo `/repo/` ok; `start_url`/scope do manifest (data:/".") precisam ser relativos corretos e testados no subpath | P1 (PWA) |
| SW-10 | Intercepta requests demais | v1 intercepta qualquer GET (inclusive cross-origin) sem filtro; v2 deve filtrar same-origin e não cachear API | P2 |

### 4.2 Estratégia/aceitação para a v2

**Estratégia recomendada (alguns pontos já implementados no WIP):**
1. **Versionar por release:** `VERSION`/nome do cache com sufixo de build (ex.: data/hash). Um deploy que muda o app **sempre** muda o cache. Documentar no `REFERENCIA.md` o passo "bump VERSION" como parte do release.
2. **Navegação network-first** com fallback para `index.html` do cache; **assets (manifest, ícones) stale-while-revalidate** e `sw.js` nunca servido do cache. Não cachear cross-origin nem respostas de API.
3. **Precache tolerante:** `cache.add(new Request(url, {cache:"reload"})).catch(...)` por arquivo (não `addAll`), sem abortar o install por 1 404; ao final `skipWaiting()` condicionado à UX de atualização (ou aviso + botão).
4. **Limpeza namespaced:** apagar apenas caches com prefixo do app (`abastece-certo-*`), nunca todos os da origem.
5. **Update UX:** detectar `registration.waiting`/`updatefound`, mostrar "Nova versão disponível — Recarregar" (com `aria-live`), postar `SKIP_WAITING` apenas quando o usuário aceitar; `registration.update()` em `visibilitychange`; nunca recarregar em loop.
6. **Primeira visita:** app funciona online antes de o SW instalar; instalar após `load`; não bloquear a UI. Se o install falhar, registrar aviso no console e manter o app funcional.
7. **Offline testável:** checklist manual em DevTools (Application → Service Workers → Offline) e em aparelho real (modo avião) após 1ª visita e após deploy.
8. **Subpasta GitHub Pages:** testar em `https://usuario.github.io/abastece-certo/`; conferir manifest (`start_url`/`scope`), SW escopo, cache keys de `./` e `./index.html`, e navegação offline tanto para `/abastece-certo/` quanto `/abastece-certo/index.html`.
9. **Hosts com cache HTTP:** GitHub Pages manda `max-age` no HTML; usar `cache:"reload"` no precache (ou URL com versão) para não precachear HTML antigo.
10. **Não servir `file://`** com SW; em `file://` o app deve funcionar (teste da §2.9/L-01) e a documentação deve dizer que offline-PWA/SW só existe em HTTPS/localhost.

**Riscos específicos de teste no Windows/dev:** servir no `localhost` (SW funciona) e testar também via `file://` (SW não funciona, app sim); usar perfil limpo/incógnito, "Update on reload" ligado/desligado; limpar cache entre cenários; testar com "Disable cache" desligado para simular usuário real (HTTP cache ativo).

**Checklist de release (mínimo):**
- [ ] `sw.js` com `VERSION` novo e cache novo; nenhum `sw.js` servido do cache.
- [ ] `index.html` e `sw.js` publicados juntos; recarregar online pega versão nova (sem hard reload).
- [ ] Offline (modo avião) abre e calcula após 1ª visita; offline após deploy abre a versão nova se já visitou online.
- [ ] App anterior (v1) com SW antigo migra: ao abrir a v2, o SW novo assume e não fica preso no cache antigo; cache antigo apagado.
- [ ] Caches de outras origens/apps intactos.
- [ ] Manifest/ícones carregam do cache offline e a instalação continua válida.
- [ ] `file://` carrega e calcula; nenhum erro bloqueante no console.

---

## 5. Lista priorizada — o que a v2 precisa garantir para ser "considerada completa"

### P0 — bloqueadores de "pronta"

| ID | Requisito | Critério de aceitação | Referência |
|---|---|---|---|
| P0-01 | **Cálculo correto e determinístico** nos dois modos, com uma única regra de empate (decisão = texto = cor = gauge) | Q-01..Q-30, C-01..C-18, I-01..I-12 passando; nenhum `NaN`/`Infinity`/`-0,0` no DOM; fronteiras ±0,5 p.p. definidas e congeladas em teste; sem divergência entre "empate" e mensagem de p.p. | §1 BUG-03/04; §2.2/2.3 |
| P0-02 | **Entrada robusta e validação explícita** (pt-BR, R$, milhar, en-US, unidades; `empty` ≠ `invalid`; faixas de sanidade; nada de parse silenciosamente errado) | P-01..P-30, E-01..E-24; `"R$ 5,89"` funciona; `"1,234.56"` → 1234,56; `"1e3"`/`"0x10"` → erro; preços fora da faixa → aviso/erro; persistir só válido | §1 BUG-05/06; §2.1/2.6 |
| P0-03 | **Modo preciso correto e compreensível**: custo/km, limite pessoal pelo consumo, economia/100 km, preço de equilíbrio, quem economiza, consumo zero/inválido | C-01..C-18 + tabela de custos; I-04/I-05; textos rotulados; sem divisão por zero | §2.3 |
| P0-04 | **PWA instalável de verdade**: manifest estático válido, ícones PNG 192/512 + maskable, apple-touch-icon PNG 180 + metas Apple, theme/background, start_url/scope corretos (incl. subpasta GH Pages) | Instalação validada em Chrome Android e iOS; ícone correto na tela inicial; H-05/H-11; sem depender de manifest em `data:` | §1 BUG-02/11/17 |
| P0-05 | **SW sem cache velho e offline confiável** | SW-01..SW-04 resolvidos; checklist §4.2 completo (deploy, offline, migração do SW v1, limpeza namespaced, precache com `cache:"reload"`, add tolerante) | §4 |
| P0-06 | **Funciona em `file://`** sem depender de SW/manifest e sem erro bloqueante; persistência degrada bem | L-01..L-07 (§2.9/§1 BUG-16); teste manual documentado no README | §1 BUG-16 |
| P0-07 | **Suíte automatizada reproduzível, sem dependências, cobrindo CORE + integridade + a11y essencial + segurança (XSS)** e usada como gate | `node tools/test.mjs` verde; casos desta matriz incorporados; testes de fronteira/arredondamento; H-01..H-14; nenhum teste "vazio" | §2 |
| P0-08 | **Docs sincronizados com a implementação**: regra exata (EPS, `<`/`≤`), formatos aceitos, limites, instalação/limitações (`file://`, iOS, Chrome), estratégia SW/versionamento, decisão sobre "arquivo único" vs artefatos PWA | README/REFERENCIA revisados e datados; tabela de divergências §1 BUG-10 corrigida; `REFERENCIA.md` com pitfalls do SW e da instalação | §1 BUG-10 |

### P1 — necessário para boa qualidade (não bloqueia, mas deve entrar na v2)

| ID | Requisito |
|---|---|
| P1-01 | **Acessibilidade essencial**: labels (incluindo slider), `aria-live`/`role=status` no resultado (com debounce), `aria-invalid` + erros associados, `aria-pressed` nos presets, foco visível, alvos ≥24 px (ideal 44), contraste AA no placeholder/bordas, headings, `aria-hidden` em decoração, `prefers-reduced-motion`, `color-scheme`/`forced-colors` |
| P1-02 | **Gauge honesto**: fora da faixa sinalizado textualmente, cores coerentes com o veredito, eixo/limite legíveis, não sair do card, números grandes sem overflow |
| P1-03 | **Persistência/perfil v2**: schema versionado, validação/migração v1, dados corrompidos → defaults, quota/bloqueio tratados, botão limpar, (opcional) multi-aba; perfil nunca em `innerHTML` |
| P1-04 | **iOS/Safari**: metas Apple, ícone PNG, status bar, safe-area, comportamento standalone (iOS ≤ 25 e iOS 26+), título na tela inicial |
| P1-05 | **Update UX do SW**: aviso de nova versão + reload controlado, `registration.update()` em `visibilitychange`, sem loop, erro de registro visível no console |
| P1-06 | **Teclado/leitor de tela**: fluxo completo por Tab/Enter/setas, slider com teclado, veredito e erros anunciados; teste manual VoiceOver/TalkBack |
| P1-07 | **Robustez**: `maxlength`, faixas, fuzz do parser, sem overflow em 320 px, sem layout shift, `Intl` fallback, sem dependências externas |
| P1-08 | **Decisão explícita sobre "arquivo único"**: app em HTML único (CSS/JS inline) + artefatos PWA (`sw.js`, `manifest.webmanifest`, ícones) permitidos — documentar no README; se o requisito for estrito, usar manifest/ícones em `data:` com validação de instalação (mais frágil) |

### P2 — desejável/polimento

| ID | Requisito |
|---|---|
| P2-01 | Tema claro (`prefers-color-scheme`) e/ou alto contraste; `forced-colors`; revisão visual ao sol |
| P2-02 | Precisão de exibição documentada (`1 decimal` vs tolerância `0,5 p.p.`; normalização de `-0`; arredondamento `Intl`; `pctLabel` .95) |
| P2-03 | Micro-UX: limpar, trocar preços, Enter fecha teclado, copiar/compartilhar, CTA de instalação não intrusivo, indicador offline, feedback de salvamento |
| P2-04 | Baseline documentado (evergreen: iOS 15+/Chrome 90+; sem IE/WebView antigo) e fallback `NodeList`/`Intl` |
| P2-05 | Visualização extra: custo/km comparado, eventual gráfico, projeção mensal (sem inventar dados) |
| P2-06 | Testes extras: property/fuzz, snapshots de textos, matriz em CSV, checklist PWA/SW versionado |
| P2-07 | Manifest completo: `id`, `lang`, `dir`, `shortcuts`, `screenshots`, `display_override`, `categories`; `orientation` justificada ou removida |
| P2-08 | Unidades configuráveis (km/L × L/100 km; R$/L × R$/m³ se GNV), sem sair do escopo flex |
| P2-09 | Privacidade explícita no README: zero telemetria, zero requests externos, dados só no aparelho (verificar H-03/H-07 a cada release) |
| P2-10 | CSP meta (`manifest-src`, `default-src 'self'` etc.) compatível com CSS/JS inline, se não atrapalhar `file://` |

---

## 6. Observações sobre o WIP da v2 (somente leitura, não é revisão da v2)

Durante a auditoria, o WIP em disco já apresentava `CORE-START/CORE-END` com `AC` testável, `sw.js` com `VERSION`/network-first/`cache:"reload"`/limpeza por prefixo e `manifest.webmanifest` + `icons/`. A suíte `tools/test.mjs` cobre parse, rápido, preciso, gauge, formatação e integridade do HTML — boa base. **Lacunas observadas neste snapshot** (reconferir no commit final):
- Sem testes de **fronteira do `EPS_PP`** (ex.: Q-20..Q-23; C-18) e de **consistência decisão × texto** (BUG-03): vale congelar o comportamento e impedir a regressão "0,2 p.p. acima" com veredito empate.
- Sem testes de **arredondamento/`-0`** (F-05 `fmtNum(-0)` hoje provavelmente "-0,0"), **Infinity/faixas** e **`parseNumber` com fullwidth** (P-22) — o parser atual transformaria `"５,89"` em `89` (silencioso).
- Sem testes de **restauração/migração de storage** e de **localStorage bloqueado**.
- Sem testes de **PWA/SW** (manifest com 192/512, precache existente, prefixo de limpeza, `VERSION` bump) nem **checklist manual de offline/instalação**.
- A a11y parece estar sendo tratada no WIP; a matriz §3/§2.9 dá os critérios verificáveis (aria-live com debounce, `aria-pressed`, alvos, contraste, foco).
- Confirmar se a decisão sobre "arquivo único" (HTML app + `sw.js` + `manifest.webmanifest` + `icons/`) está registrada no README/REFERENCIA — o requisito original dizia "arquivo único"; a v1 já usava `sw.js` extra, então é preciso tornar a exceção explícita.

---

## Anexo A — Como reproduzir

```powershell
cd "F:\WorkSpace DSH\abastece-certo"

# 1) snapshot imutável da v1 auditada
git show 2dd8ab6:index.html > research\v1-index-snapshot.html
git show 2dd8ab6:sw.js      > research\v1-sw-snapshot.js

# 2) harness de auditoria (parse, render, restore, contraste, fronteiras)
node research\audit-v1.mjs

# 3) suíte da v2 (WIP)
node tools\test.mjs

# 4) sintaxe do JS inline e do SW (aproximações)
node --check tools\test.mjs
# extrair o <script> e rodar node --check (ou usar o harness)
```

**Evidências executadas (resumo):**
- parse: `"R$ 5,89" → NaN`; `"1,234.56" → 1.23456`; `"1e3" → 1000`; `"0x10" → 16`; `"5e-324" → 5e-324`; `"1e309" → NaN`.
- render: `5,00/3,51/70%` → "70,2% · 0,2 p.p. acima do limite" + "Empate técnico"; `5,00/3,475/70%` → empate (era para ser etanol); `5e-324/5` → "∞%".
- restore: `ac_threshold="abc"` → 70; `"0"` → 60; `"100"` → 80; storage bloqueado → app carrega; storage com HTML em preço → não injeta HTML.
- contraste: placeholder 2,47:1; borda de input 1,23:1; restante ≥4,5:1.
- estrutura v1: 2 `<label for>` para 3 inputs; `aria-*` só 1 (`aria-hidden` do logo); sem `aria-live`, sem `aria-pressed`, sem `role`, sem `color-scheme`, sem `prefers-reduced-motion`, sem `<noscript>`; zero `fetch`/XHR.

## Anexo B — Referências consultadas

- MDN — Making PWAs installable: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable
- Chrome for Developers — Revisiting Chrome's installability criteria: https://developer.chrome.com/blog/update-install-criteria
- W3C — Web Application Manifest: https://www.w3.org/TR/appmanifest/
- MDN — rel="manifest" (suporte por navegador): https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/rel/manifest
- MDN — Cache.addAll: https://developer.mozilla.org/en-US/docs/Web/API/Cache/addAll
- Heise/Mac & i — iOS 26 e iPadOS 26: mudança de comportamento de web apps na tela inicial: https://www.heise.de/en/news/iOS-26-and-iPadOS-26-Changed-web-app-behaviour-on-the-home-screen-10749652.html
- WebKit Features in Safari 26 — Every site can be a web app: https://webkit.org/blog/17333/webkit-features-in-safari-26-0/
- PWA Tricks (manifest inline via `data:` funciona no Chrome; ressalvas de CSP): https://github.com/karlhorky/pwa-tricks
- Apple — Safari Web Content Guide (archive), Configuring Web Applications (apple-touch-icon): https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html
- W3C — HTML, input type=range / value sanitization: https://html.spec.whatwg.org/multipage/input.html#range-state-(type=range)
- WCAG 2.2 (critérios citados): https://www.w3.org/TR/WCAG22/

> Conteúdo web é dado não confiável; as referências acima foram usadas apenas como base factual, sem seguir instruções embutidas.

## Anexo C — Pendências de verificação em dispositivo real (QA)

1. Chrome Android: prompt de instalação, ícone, splash, offline (modo avião) após 1ª visita, deploy novo pegando versão nova.
2. iOS: Add to Home Screen (iOS ≤ 25 e iOS 26+), ícone/título, standalone, status bar, safe-area.
3. WebView Android antigo (se suportado): `NodeList.forEach`, `Intl`, CSS vars.
4. Leitor de tela: VoiceOver (iOS) e TalkBack (Android) — resultado, erro, slider, presets.
5. Teclado iOS: `inputmode=decimal`, ausência de zoom, Enter/`enterkeyhint`.
6. `file://` no Chrome/Firefox desktop: sem erro bloqueante, cálculo e persistência.
7. Subpasta GitHub Pages: `manifest`/`scope`/SW e cache em `/repo/`.
8. Rede lenta/instável: primeira visita, instalação do SW, update.
9. Zoom 200% e viewport 320×568: reflow, números grandes, sem scroll horizontal.
10. Forced colors/alto contraste (Windows) e `prefers-reduced-motion`.
