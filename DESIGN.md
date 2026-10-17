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

- **Três estados**: escuro (padrão), automático (segue o sistema) e claro. A ordem do botão é
  escuro → automático → claro.
- Persistido em `localStorage["ac.theme"]`; aplicado antes do primeiro paint por um script no `<head>`
  (`data-theme` no `<html>`) para não haver flash.
- Botão no cabeçalho (44×44 px) alterna os estados, com ícone e `aria-label` do estado atual.
- `meta[name=theme-color]` acompanha o tema (`#0b0e14` / `#f1f4f9`).
- Fundo/cartão escuros: `#0b0e14` / `#141926`; texto `#e8edf5`; verde `#3ddc84`.

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
  --bg: #f1f4f9;  --bg-soft: #e6eaf1;  --card: #ffffff;  --card-2: #f9fafb;
  --ink: #111827; --muted: #5b6472;    --faint: #8b93a3;
  --line: #dde2ea; --line-ctrl: #cbd2dd;
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

- **Campo de preço:** deriva o valor dos dígitos do próprio campo (sem estado paralelo), então digitação,
  cola, desfazer e autofill se auto-corrigem. Enquanto digita, `6` → `6`, `65` → `65`, `654` → `6,54`,
  `456` → `4,56`, `1050` → `10,50`; ao sair, os centavos completam (`6` → `6,00`); máximo de 4 dígitos
  (R$ 99,99) e o 5º é ignorado. Rótulo à esquerda, prefixo `R$` discreto e número grande à direita.
  Foco visível de 2 px; erro em texto e `aria-invalid`.
- **Custo mensal:** campo opcional de km/mês no cartão do veículo; o resultado preciso acrescenta
  "Rodando N km/mês: cerca de R$ X/mês com <vencedor>".
- **Sobre e dados:** bottom sheet (overlay escuro) com versão, semana da ANP, fonte, atualizar preços e
  apagar dados do aparelho (confirmação em dois toques).
- **Instalar:** link no rodapé, visível só quando o navegador permite instalar; sem evento, o toque mostra
  as instruções do iPhone/Android.
- **Compartilhar imagem:** cartão PNG 900×1200 desenhado em `<canvas>`, compartilhado como arquivo quando
  possível e baixado como fallback; nunca depende de serviço externo.
- **Segmentado (abas):** trilho cinza com pílula branca/elevada no item ativo; `role=tablist` e setas.
- **Limite:** valor grande, trilha com preenchimento verde até o limite, chips E32/E30/E25 + "seu carro".
- **Seletor de UF:** rótulo visível "Média oficial por estado", `select` + botão "Preencher preços" e
  médias (com faixa min–máx do Brasil) exibidas logo abaixo; a UF escolhida é lembrada.
- **Seletor de cidade:** aparece quando a UF tem dados municipais; "Média do estado (todas as cidades)"
  é o padrão. A cidade escolhida é lembrada junto com a UF e o botão preenche com a média municipal.
- **Consumo cidade/estrada:** dois campos por combustível (cidade e estrada) + slider "Uso na cidade";
  a média é **harmônica** (`1 / (w/consumo_cidade + (1-w)/consumo_estrada)`), com fallback para o único
  valor informado (compatível com veículos salvos antes da v4.5). Abaixo do slider aparece o consumo
  efetivo considerado.
- **Diário de abastecimentos:** seção recolhível com combustível, litros e km rodados; lista com km/L de
  cada registro, resumo por combustível (litros e km somados) e botão "Usar consumo real no modo preciso"
  que preenche cidade/estrada com a média. Até 80 registros, só no aparelho.
- **Status de instalação:** linha no "Sobre e dados" com modo (instalado/navegador) e service worker
  (ativo/inativo) — serve para o teste de instalação no celular.
- **Postos perto de mim:** botão dentro de "Meus postos" (só aparece com geolocalização); pede a posição
  **apenas no toque**, consulta o OpenStreetMap/Overpass e lista nome, distância e marca com atalhos
  "Mapa" (Google Maps) e "Usar nome". Em falha de rede/serviço, mostra o link do Google Maps como
  fallback. Atribuição © OpenStreetMap (ODbL) visível e localização nunca persistida.
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
