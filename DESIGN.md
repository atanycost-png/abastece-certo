# DESIGN.md — Abastece Certo

> Contrato de design do app. Serve para qualquer pessoa (ou agente de design, ex.: OpenDesign) que for
> mexer na interface: leia isto antes de tocar em `index.html`. Se os tokens mudarem, atualize este
> arquivo na mesma mudança.

## 1. Produto e contexto de uso

- Decisão rápida **no posto de gasolina**: sol, celular em uma mão, pressa.
- 90% do uso: informar dois preços e ler o veredito em menos de 5 segundos.
- Público: motorista brasileiro, sem familiaridade técnica.
- Restrições **inegociáveis**: arquivo único (`index.html`), zero dependências, zero build, fontes do
  sistema (nenhuma webfont/CDN), funciona em `file://` e offline, instalável como PWA.

## 2. Direção visual (v4, escolhida)

**"App nativo limpo"** — base: Energy Plus (GS Caltex).

Sensação de referência: app de banco/pagamento bem-feito — claro, calmo, com um acento de cor e números
grandes. Nada de papel, revista ou placa; nada de "dashboard de startup".

Princípios:

1. **Fundo neutro, cartões brancos.** Fundo cinza-claro, cartões com raio de 16 px e sombra quase invisível.
2. **Um acento.** Verde é a cor de ação e do etanol; azul identifica a gasolina; âmbar só para atenção.
3. **Números são o conteúdo.** Valores grandes, tabulares, alinhados à direita; rótulos pequenos e cinzas.
4. **Uma decisão por tela.** Preços → veredito → comparação → histórico → educação.
5. **Escuro de verdade.** O tema escuro tem tokens próprios (não é inversão), com contraste AA nos dois.

## 3. Modo escuro

- **Três estados**: automático (segue o sistema), claro e escuro. Padrão: automático.
- Persistido em `localStorage["ac.theme"]`; aplicado antes do primeiro paint por um script no `<head>`
  (`data-theme` no `<html>`) para não haver flash.
- Botão no cabeçalho (44×44 px) alterna automático → claro → escuro, com ícone e `aria-label` do estado.
- `meta[name=theme-color]` acompanha o tema (`#f6f7f9` / `#0b0e14`).
- Tokens escuros: fundo `#0b0e14`, cartão `#141926`, texto `#e8edf5`, verde `#3ddc84`.

## 4. Anti-metas (o que NÃO fazer)

A v1–v3 passaram por "cara de IA" e por direções que não agradaram (papel/recibo, revista, placa). Não repetir:

- fundo navy com gradiente radial e brilho no canto;
- todos os blocos com `border-radius: 18px` e sombra difusa forte;
- logo com gradiente azul→verde e *glow*;
- tudo em CAIXA ALTA com `letter-spacing` largo;
- serifada editorial, papel texturizado ou amarelo de placa como base;
- emoji como ícone;
- glassmorphism, neon, parallax, animação decorativa.

## 5. Tipografia

| Uso | Família | Peso | Tamanho |
|---|---|---|---|
| Título da tela | `-apple-system, "SF Pro Text", "Segoe UI", Roboto, sans-serif` | 700 | 19 px |
| Rótulos e textos | a mesma sans | 400–600 | 11–14 px |
| Números e preços | a mesma sans, `font-variant-numeric: tabular-nums` | 700 | 30–46 px |

- Moeda no formato `R$ 0,00` (pt-BR), consumo `12,4 km/L`.
- Escala: 10,5 · 11,5 · 12,5 · 13,5 · 15 · 19 · 30 · 46.
- Sem webfont: nada de `@import`, `@font-face` remoto ou `<link>` externo.

## 6. Cor (tokens)

```css
:root {
  --bg: #f6f7f9;  --bg-soft: #eceff4;  --card: #ffffff;  --card-2: #f9fafb;
  --ink: #111827; --muted: #6b7280;    --faint: #98a2b3;
  --line: #e5e7eb; --line-ctrl: #d0d5dd;
  --green: #0b8f52; --blue: #1d4ed8;   --amber: #b45309; --danger: #b42318;
  --btn-bg: #111827; --btn-ink: #ffffff;
}
:root[data-theme="dark"] {
  --bg: #0b0e14;  --bg-soft: #121826;  --card: #141926;  --card-2: #0f1420;
  --ink: #e8edf5; --muted: #98a2b3;    --faint: #7c8698;
  --line: #232a38; --line-ctrl: #39445a;
  --green: #3ddc84; --blue: #60a5fa;   --amber: #fbbf24; --danger: #f87171;
  --btn-bg: #e8edf5; --btn-ink: #0b0e14;
}
```

- Contraste mínimo: **4,5:1** para texto e **3:1** para bordas/indicadores (WCAG 2.2 AA).
- A cor nunca é o único sinal: veredito sempre tem texto e ícone.

## 7. Layout e espaçamento

- Base de 4 px; respiro entre seções de 12–16 px.
- Contentor de 460 px, centralizado; nada de layout largo.
- Cartões com raio de 16 px, borda transparente e sombra suave (`--shadow`).
- Ordem de leitura: preços → veredito (herói) → comparação → histórico → educação/fontes.

## 8. Componentes

- **Campo de preço:** só aceita dígitos e mostra o valor formatado — `6` → R$ 6,00, `654` → R$ 6,54,
  `1050` → R$ 10,50; máximo de 4 dígitos (R$ 99,99); vírgula e ponto não são digitáveis; backspace apaga
  um dígito e focar seleciona tudo. Rótulo à esquerda, prefixo `R$` discreto e número grande à direita.
  Foco visível de 2 px; erro em texto e `aria-invalid`.
- **Segmentado (abas):** trilho cinza com pílula branca/elevada no item ativo; `role=tablist` e setas.
- **Limite:** valor grande, trilha com preenchimento verde até o limite, chips E32/E30/E25 + "seu carro".
- **Seletor de UF:** rótulo visível "Média oficial por estado", `select` + botão "Preencher preços" e
  médias (com faixa min–máx do Brasil) exibidas logo abaixo; a UF escolhida é lembrada.
- **Veredito:** faixa com tint da cor semântica, ícone e frase completa ("Abasteça com etanol").
- **Gauge:** trilha fina com marca de limite e ponto do índice; sem gradiente arco-íris.
- **Histórico:** gráfico de linha fino, lista com data e valores tabulares; nunca mais de 50 itens.
- **Botão de tema:** 44×44 px, circular, no cabeçalho; alterna automático/claro/escuro.

## 9. Movimento

- Transições de 120–200 ms, `ease-out`; nenhum *bounce*.
- Respeitar `prefers-reduced-motion: reduce` (desligar tudo).

## 10. Acessibilidade e conteúdo

- WCAG 2.2 AA nos dois temas; `aria-live` no resultado e nas mensagens de erro; abas com setas.
- Alvos de toque ≥ 44 px; `inputmode="numeric"` nos preços; zoom do iOS não pode ser disparado.
- Voz: direta, brasileira, sem jargão. Veredito em frase completa.
- No modo rápido **nunca** prometer economia em reais; economia só no modo preciso, onde o consumo é real.

## 11. Contratos que o redesign não pode quebrar

- Ids e ganchos de teste: `#gas`, `#eta`, `#threshold`, `#resultOut`, `#priceRef`, `#histList`, `#live`,
  `#toast`, `#updateBar`, `#themeBtn`, abas `#tab-fast`/`#tab-precise` e painéis `#panel-fast`/`#panel-precise`.
- Classes de veredito: `etanol`, `gasolina`, `empate` (usadas por testes e pelo CSV/histórico).
- Contratos de tema: `data-theme` (`light`/`dark`) e `data-theme-mode` (`auto`/`light`/`dark`) no `<html>`.
- O portão de qualidade é `tools/test.mjs`, `tools/test-dom.mjs`, `tools/test-sw.mjs`,
  `tools/test-prices.mjs`, `tools/check.mjs` e `tools/visual-check.mjs`. Redesign que quebra esses testes
  não entra.
