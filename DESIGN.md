# DESIGN.md — Abastece Certo

> Contrato de design do app. Serve para qualquer pessoa (ou agente de design, ex.: OpenDesign) que for
> redesenhar a interface: leia isto antes de tocar em `index.html`. Se os tokens mudarem, atualize este
> arquivo na mesma mudança.

## 1. Produto e contexto de uso

- Decisão rápida **no posto de gasolina**: sol, celular em uma mão, pressa.
- 90% do uso: informar dois preços e ler o veredito em menos de 5 segundos.
- Público: motorista brasileiro, sem familiaridade técnica.
- Restrições **inegociáveis**: arquivo único (`index.html`), zero dependências, zero build, fontes do
  sistema (nenhuma webfont/CDN), funciona em `file://` e offline, instalável como PWA.

## 2. Direção visual (proposta v4)

**"Balcão de posto": editorial brasileiro, papel/recibo, tipografia firme, cor de sinalização.**

Sensação de referência: nota fiscal de posto, placa de preço, jornal de bairro, bilhete manuscrito —
não "dashboard de startup de tecnologia".

Princípios da direção:

1. **Papel, não vidro.** Fundo claro e quente, fios finos separando seções, quase nenhuma sombra.
2. **Tipografia faz o trabalho.** Serifada editorial nos títulos e no veredito; monoespaçada tabular nos
   números; sans do sistema no resto.
3. **Cor é sinalização.** Verde/azul-petróleo identificam os combustíveis; amarelo de placa marca o limite;
   vermelho só para erro. Nada de gradiente decorativo.
4. **O veredito é o herói.** É o maior elemento da tela e o único com peso visual forte.
5. **Densidade honesta.** Sem preencher espaço com cartões vazios; o app é curto porque a tarefa é curta.

## 3. Anti-metas (o que NÃO fazer)

O visual da v3 caiu no padrão "cara de IA". Não repetir:

- fundo navy escuro com gradiente radial e brilho no canto;
- todos os blocos como cartões idênticos de `border-radius: 18px` com sombra difusa;
- logo com gradiente azul→verde e *glow*;
- tudo em CAIXA ALTA com `letter-spacing` largo;
- emoji usado como ícone, ou ícones genéricos de biblioteca;
- verde/azul "tech" para combustível (ver §5);
- glassmorphism, neon, parallax, animação decorativa.

## 4. Tipografia

| Uso | Família | Peso | Tamanho |
|---|---|---|---|
| Título da tela / veredito | `Georgia, "Times New Roman", serif` | 700 | 28–44 px |
| Rótulos e textos | `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` | 400–600 | 12–15 px |
| Números e preços | `ui-monospace, "Cascadia Mono", Consolas, monospace` | 600–700 | 16–40 px |

- Números sempre com `font-variant-numeric: tabular-nums`.
- Moeda no formato `R$ 0,00` (pt-BR), unidade de consumo `12,4 km/L`.
- Escala: 11 · 12 · 13 · 15 · 18 · 24 · 32 · 44.
- Sem webfont: nada de `@import`, `@font-face` remoto ou `<link>` externo.

## 5. Cor (tokens)

```css
:root {
  --paper:    #f5f0e4;  /* fundo */
  --surface:  #fffdf7;  /* campos e cartões */
  --ink:      #16150f;  /* texto principal */
  --ink-2:    #55503f;  /* texto secundário */
  --rule:     #d9d1bd;  /* fios e bordas */
  --etanol:   #1f6b3a;  /* verde escuro — etanol */
  --gasolina: #0e5a6b;  /* azul petróleo — gasolina */
  --sinal:    #e8b200;  /* amarelo de placa — limite/atenção */
  --alerta:   #a23b12;  /* erro */
}
@media (prefers-color-scheme: dark) {
  :root { --paper: #12110d; --surface: #1b1913; --ink: #f2ede0; --ink-2: #b9b2a0; --rule: #3a362b; }
}
```

- Contraste mínimo: **4,5:1** para texto e **3:1** para bordas/indicadores (WCAG 2.2 AA).
- A cor nunca é o único sinal: veredito sempre tem texto e ícone.

## 6. Layout e espaçamento

- Base de 4 px; respiro entre seções de 16–24 px.
- Contentor de 440–480 px, centralizado; nada de layout largo.
- Seções separadas por **fio de 1 px**, `border-radius` máximo de 8 px.
- Sombra apenas em elementos flutuantes (toast, barra de "nova versão").
- Ordem de leitura: preços → veredito (herói) → comparação → histórico → educação/fontes.

## 7. Componentes

- **Campo de preço:** etiqueta pequena, prefixo `R$` discreto, valor grande em mono; foco com contorno de
  2 px; erro em texto (não só cor) e `aria-invalid`.
- **Seletor de UF:** rótulo visível "Média oficial por estado", `select` + botão "Preencher preços" e os
  valores médios exibidos logo abaixo (a média muda ao trocar a UF).
- **Gauge:** régua graduada com marca de limite e ponto do índice; sem gradiente arco-íris.
- **Veredito:** faixa com ícone monocromático + frase completa ("Abasteça com etanol"); cor semântica com
  texto sempre presente.
- **Histórico:** linha fina no gráfico, lista com data e valores tabulares; nunca mais de 50 itens.
- **Botões:** primário sólido em `--ink` sobre `--paper`; secundário com fio; destrutivo em `--alerta`.

## 8. Movimento

- Transições de 120–200 ms, `ease-out`; nenhum *bounce*.
- Respeitar `prefers-reduced-motion: reduce` (desligar tudo).

## 9. Acessibilidade e conteúdo

- WCAG 2.2 AA; `aria-live` no resultado e nas mensagens de erro; abas com `role=tablist/tab` e setas.
- Alvos de toque ≥ 44 px; `inputmode="decimal"`; zoom do iOS não pode ser disparado (fonte ≥ 16 px).
- Voz: direta, brasileira, sem jargão. Veredito em frase completa.
- No modo rápido **nunca** prometer economia em reais; economia só no modo preciso, onde o consumo é real.

## 10. Contratos que o redesign não pode quebrar

- Ids e ganchos de teste: `#gas`, `#eta`, `#threshold`, `#resultOut`, `#priceRef`, `#histList`, `#live`,
  `#toast`, `#updateBar`, abas `#tab-fast`/`#tab-precise` e painéis `#panel-fast`/`#panel-precise`.
- Classes de veredito: `etanol`, `gasolina`, `empate` (usadas por testes e pelo CSV/ histórico).
- O portão de qualidade é `tools/test.mjs`, `tools/test-dom.mjs`, `tools/test-sw.mjs`,
  `tools/test-prices.mjs`, `tools/check.mjs` e `tools/visual-check.mjs`. Redesign que quebra esses testes
  não entra.
