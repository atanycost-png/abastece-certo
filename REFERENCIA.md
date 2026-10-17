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
5. **Ecossistema:** nenhuma dependência de runtime se paga. gzip medido: Alpine 15,8 KB, Preact+htm 5,4 KB, Lit ~5–7 KB, Chart.js 68,4 KB, uPlot 21,6 KB, workbox-window 1,3 KB, just-validate 6,9 KB — contra um app inteiro de ~49 KB sem nenhuma delas.
6. **Instalabilidade:** service worker **não** é requisito no Chrome/Edge (manifest + ícones 192/512 + HTTPS bastam); `maskable` e `screenshots` são recomendados. O SW existe por offline, não por instalação.

### O que mudou no código
- **Dois modos** (`Rápido` e `Preciso`) com abas ARIA completas (roving tabindex, setas, Home/End).
- **Modo preciso** completo: custo por km, custo por 100 km, economia por 100 km, limite pessoal, preço de equilíbrio do etanol e da gasolina, consumos em L/100 km.
- **Perfil de veículo** em `localStorage`: nome + consumos, múltiplos veículos, salvar/excluir, limite pessoal vira preset do modo rápido.
- **PWA de verdade**: `manifest.webmanifest` estático, PNGs 192/512 + maskable + apple-touch-icon (gerados por `tools/make-icons.py`), favicon SVG.
- **Service worker v2**: cache versionado por prefixo, `network-first` na navegação, `stale-while-revalidate` nos estáticos, precache tolerante a 404, limpeza só dos caches do próprio app, `sw.js` nunca cacheado, atualização **sob confirmação** (barra "Nova versão disponível" → `SKIP_WAITING` → `controllerchange` → reload).
- **Acessibilidade**: `aria-live` persistente com `role="status"` e debounce, labels em todos os campos, `aria-invalid` + dica textual, foco visível, alvos ≥ 44 px, `prefers-reduced-motion`, contraste corrigido (placeholder de 2,47:1 → ~5:1; bordas de controle ~3:1).
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
| localStorage sem validação/migração | `loadState` valida veículos, clampa limite e migra chaves da v1 |
| contraste insuficiente | cores de placeholder e borda de controle ajustadas |

### Arquitetura de testes (gate de qualidade)
- `tools/test.mjs` — **122 testes** extraindo o bloco `CORE-START/CORE-END` do `index.html` e rodando em `node:vm` (sem duplicar código): parser, formatação, cálculo dos dois modos, fronteiras de empate, invariante veredito×texto, avisos, gauge, integridade do HTML.
- `tools/check.mjs` — **41 checagens** de pacote: arquivos, JSON do manifest × dimensões reais dos PNG, precache do SW × arquivos existentes, sintaxe do JS embutido, ARIA/ids/labels, ausência de dependências externas, orçamento de tamanho.
- `tools/visual-check.mjs` — Edge headless via DevTools Protocol (WebSocket nativo do Node, sem puppeteer): preenche campos, testa validação, empate técnico, modo preciso, persistência após reload, viewport de 360 px, alvos de toque e coleta erros de console. Gera `screenshots/*.png`.
- `tools/serve.mjs` — servidor estático local sem dependências (para testar SW/PWA).
- `tools/make-icons.py` — gera os ícones PNG (Pillow/numpy), com gota construída por tangência exata.

### Verificação realizada em 17/10/2026
- `node tools/test.mjs` → **122/122**.
- `node tools/check.mjs` → **41/41** (2 avisos não bloqueantes: manifest sem screenshots e sem LICENSE — LICENSE adicionado como MIT).
- `node tools/visual-check.mjs` → 9 etapas, **0 erros de console**, sem overflow horizontal em 360 px, veredito/texto/cor consistentes no empate.
- Peso: `index.html` ~49 KB, `sw.js` ~3 KB, ícones ~103 KB no total.

### Pitfalls (novos)
- **Edge headless não roda sob o sandbox de arquivos do harness** (Mojo/`platform_channel` falha com "Acesso negado" ao abrir pipes nomeados). Rodar `tools/visual-check.mjs` com o ambiente liberado; é ferramenta de dev, não requisito.
- **`manifest` em `data:` URI** continua quebrando instalação (iOS/Safari e Chrome tratam mal). Sempre arquivo real, mesmo que ≥ 2 requisições.
- **`skipWaiting()` automático** + `clients.claim()` pode servir HTML novo com CSS/JS em cache antigo. Em app pequeno o risco é baixo, mas o padrão correto é atualizar sob confirmação — foi o que a v2 faz.
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
