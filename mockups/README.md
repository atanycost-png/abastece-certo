# Mockups — direções visuais para a v4

Três direções completas para a mesma tela (preços, referência ANP por estado, limite, resultado e
histórico). Todos são **arquivos HTML autocontidos** — abra com duplo clique, sem servidor.

| Arquivo | Direção | Ideia |
|---|---|---|
| `mockup-1-balcao.html` | **Balcão de posto** | papel/recibo, serifada no veredito, fios finos, verde/azul-petróleo, amarelo de placa |
| `mockup-2-editorial.html` | **Editorial quente** | revista: creme + terracota, títulos serifados grandes, muito respiro |
| `mockup-3-sinalizacao.html` | **Sinalização** | placa de rodovia: preto/amarelo/verde, caixa alta, blocos grossos, zero ornamento |

O contrato de design que qualquer uma delas deve respeitar está em [`../DESIGN.md`](../DESIGN.md).

## Campo de preço (igual nos três)

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
