# Mockups — direções visuais para a v4

## Rodada 2 — baseada em referências reais (atual)

| Arquivo | Direção | Referência |
|---|---|---|
| `mockup-a-nativo.html` | **A · App nativo limpo** | Energy Plus (GS Caltex): branco/cinza, verde, cartões 16 px, CTA escuro |
| `mockup-b-formulario.html` | **B · Formulário brasileiro** | Drivvo: faixa laranja, campos sublinhados com ícone, preços em 2 colunas |
| `mockup-c-comparador.html` | **C · Comparador de decisão** | GasBuddy: veredito primeiro, chips, tabela e barras escaneáveis |

## Rodada 1 — descartada

`mockup-1-balcao.html` (papel/recibo), `mockup-2-editorial.html` (revista) e
`mockup-3-sinalizacao.html` (placa). Ficaram como histórico; o feedback foi que não agradaram.

O contrato de design que qualquer direção deve respeitar está em [`../DESIGN.md`](../DESIGN.md).

## Campo de preço (igual em todos)

Só dígitos, formatado enquanto digita:

| Você digita | Resultado |
|---|---|
| `6` | R$ 6,00 |
| `65` | R$ 65,00 (transitório) |
| `654` | R$ 6,54 |
| `456` | R$ 4,56 |
| `1050` | R$ 10,50 |
| 5º dígito | ignorado (teto R$ 99,99) |

Regra: até 2 dígitos = reais inteiros; 3–4 dígitos = reais + centavos (últimos dois dígitos).
Vírgula e ponto são ignorados na digitação; backspace apaga um dígito. Colar texto reaplica a máscara.

