# Abastece Certo — Etanol ou Gasolina

Calculadora offline para decidir na hora se compensa abastecer com **etanol** ou **gasolina**, pela regra do 70/71%.

## Arquivos

| Arquivo | Papel |
|---|---|
| `index.html` | O app completo (HTML+CSS+JS embutidos). Autocontido, sem dependências, sem build. |
| `sw.js` | Service worker (opcional): habilita instalação PWA + uso offline via cache. |
| `REFERENCIA.md` | Referência técnica, histórico datado, decisões e pitfalls. |

## Como usar

- **Rápido (sem servidor):** dê dois cliques em `index.html`. Funciona 100% offline, sem instalar nada.
- **Instalar no celular (PWA):** sirva a pasta por HTTPS (GitHub Pages, Netlify Drop, Vercel) e use "Adicionar à tela inicial".

```sh
# testar localmente com HTTPS-ish (só para ver o service worker):
npx serve .            # http://localhost:3000 (SW funciona em localhost)
```

## O que ele faz

1. Você informa o **preço da gasolina** e o **preço do etanol** (aceita vírgula ou ponto).
2. O app calcula `índice = etanol ÷ gasolina` e compara com o **limite** (padrão 70%; botão rápido para 71% = gasolina E30).
3. Veredito: **ETANOL** (índice ≤ limite), **GASOLINA** (índice > limite) ou **empate técnico**.
4. Gauge visual mostra onde o índice cai em relação ao limite.
5. Seção "Por que essa regra existe?" explica a física (poder calorífico, E30) e por que a conta real depende do consumo do seu carro.

## Fórmula

```
etanol compensa  ⇔  P_etanol / P_gasolina  <  C_etanol / C_gasolina
```

A "regra dos 70%" é o caso particular onde `C_etanol / C_gasolina = 0,70`. Com gasolina E30 (desde ago/2025), a referência sobe para ~71%.

## Fonte

[Fecombustíveis — "regra dos 70%" pode fazer você perder dinheiro](https://www.fecombustiveis.org.br/noticia/etanol-ou-gasolina-entenda-como-a-regra-dos-70-pode-fazer-voce-perder-dinheiro/263643)
