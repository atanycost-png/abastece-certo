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
