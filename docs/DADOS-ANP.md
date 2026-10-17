# Dados de preços da ANP (`precos.json`)

O `precos.json` da raiz é o único dado "de fora" do app: são as **médias semanais de
revenda** do *Levantamento de Preços de Combustíveis* (LPC) da ANP. Ele é gerado por
`tools/update-prices.mjs` — **zero dependências** (só módulos nativos do Node) — e
mantido atualizado por uma GitHub Action semanal. O app é estático e continua
funcionando offline; o JSON só entra como referência de preço e data.

Semana verificada na geração inicial: **04/10/2026 a 10/10/2026** (domingo a sábado):

| Produto | Média nacional | Mín.* | Máx.* | Postos |
|---|---|---|---|---|
| Gasolina comum | **R$ 6,54/L** | 5,39 | 8,99 | 4.474 |
| Gasolina aditivada | **R$ 6,72/L** | 5,59 | 8,99 | 3.443 |
| Etanol hidratado | **R$ 4,14/L** | 3,09 | 6,59 | 3.833 |

\* mín/máx das **médias municipais**, não dos preços praticados em cada posto (explicado abaixo).

## Como rodar

Pré-requisitos: **Node 20+** (testado com Node 24). Nada de `npm install`.

```sh
node tools/update-prices.mjs                    # baixa a semana mais recente e grava precos.json
node tools/update-prices.mjs --dry-run          # imprime o JSON e NÃO grava
node tools/update-prices.mjs --file resumo_semanal_lpc_2026-10-04_2026-10-10.xlsx
node tools/update-prices.mjs --semana 2026-10-04_2026-10-10
node tools/update-prices.mjs --out /tmp/precos.json
node tools/test-prices.mjs                      # suíte de testes (helpers + precos.json)
```

As mensagens de progresso vão para o **stderr**; no `--dry-run` o **stdout** é só o JSON
(útil para `> arquivo.json` ou `| jq`). Em qualquer erro o script sai com código **1** e
**não grava nada**.

| Opção | Efeito |
|---|---|
| `--file, -f <arquivo.xlsx>` | usa um XLSX já baixado em vez de acessar a rede |
| `--out, -o <arquivo.json>` | grava em outro caminho (padrão: `precos.json` na raiz) |
| `--semana <AAAA-MM-DD_AAAA-MM-DD>` | força uma semana (busca o link na página; se não estiver listada, tenta a URL canônica) |
| `--dry-run` | imprime e não grava |
| `--help, -h` | ajuda |

## O que o JSON contém

```json
{
  "fonte": "ANP — Levantamento de Preços de Combustíveis",
  "url": "https://www.gov.br/anp/.../resumo_semanal_lpc_2026-10-04_2026-10-10.xlsx",
  "semana": { "inicio": "2026-10-04", "fim": "2026-10-10" },
  "atualizadoEm": "2026-10-17T14:29:00.262Z",
  "brasil": {
    "gasolinaComum":   { "media": 6.54, "min": 5.39, "max": 8.99, "postos": 4474 },
    "gasolinaAditivada": { "media": 6.72, "min": 5.59, "max": 8.99, "postos": 3443 },
    "etanol":          { "media": 4.14, "min": 3.09, "max": 6.59, "postos": 3833 }
  },
  "estados": {
    "SP": { "gasolinaComum": 6.36, "etanol": 3.86 },
    "AP": { "gasolinaComum": 6.68 }
  }
}
```

| Campo | Significado |
|---|---|
| `fonte` | atribuição fixa usada na UI |
| `url` | URL exata do XLSX de origem (ou URL canônica gerada a partir do nome do arquivo quando se usa `--file`) |
| `semana.inicio` / `semana.fim` | período pesquisado; **domingo a sábado** nos arquivos da ANP — extraído das células `DATA INICIAL`/`DATA FINAL` e conferido contra o nome do arquivo |
| `atualizadoEm` | instante (ISO 8601, UTC) da última **mudança de dados**. Se uma execução encontra exatamente os mesmos números, o valor anterior é preservado para o arquivo não mudar |
| `brasil.*.media` | preço médio de revenda (R$/L) da semana, ponderado pelo levantamento da ANP |
| `brasil.*.min` / `.max` | **mínimo e máximo das médias municipais** daquela semana — não é o menor/maior preço de posto. Serve para dar noção de amplitude, não para prometer "preço mínimo" |
| `brasil.*.postos` | número de postos pesquisados naquele produto (amostra do levantamento) |
| `estados[UF].gasolinaComum` / `.etanol` | média de revenda da UF na semana. A aditivada fica só no bloco nacional |
| UF ausente de uma chave | quando a ANP não pesquisa o produto naquela UF na semana (ex.: Amapá sem etanol em 04–10/10/2026) — a chave simplesmente não aparece |

## De onde vêm os números (passo a passo)

1. O script baixa a página oficial
   [LPC — últimas semanas pesquisadas](https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/levantamento-de-precos-de-combustiveis-ultimas-semanas-pesquisadas).
2. Procura links que casem com `resumo_semanal_lpc_AAAA-MM-DD_AAAA-MM-DD.xlsx`
   (aceita variações reais como `resumo_semanal_lpc_2026-08-30-2026-09-5.xlsx`) e escolhe
   a **semana mais recente** (maior `fim`). Links de `revendas_lpc_*` são ignorados.
3. Baixa o XLSX (~300 KB) de `.../arquivos-lpc/{ano}/resumo_semanal_lpc_....xlsx`.
4. Descompacta o XLSX **em memória** com um leitor de ZIP mínimo (`node:zlib.inflateRawSync`):
   diretório central (EOCD), cabeçalhos locais, métodos *store* (0) e *deflate* (8).
5. Lê `xl/workbook.xml` + `xl/_rels/workbook.xml.rels` para achar as abas **BRASIL** e
   **ESTADOS** (sem depender do número da planilha) e `xl/sharedStrings.xml`.
6. Parseia o XML com regex (sem DOM): células `<c t="s">` (shared strings),
   `<c t="inlineStr">`, números e datas; decodifica entidades XML.
7. Localiza o cabeçalho (linha 10 nos arquivos atuais) e mapeia as colunas por nome
   normalizado (sem acento/caixa): `PRODUTO`, `PREÇO MÉDIO REVENDA`, `PREÇO MÍNIMO
   REVENDA`, `PREÇO MÁXIMO REVENDA`, `NÚMERO DE POSTOS PESQUISADOS`, `ESTADOS`.
8. Filtra os produtos de interesse — `GASOLINA COMUM`, `GASOLINA ADITIVADA`,
   `ETANOL HIDRATADO`; diesel/GLP/GNV são descartados. Números pt-BR (`6,54`, `4.474`)
   e o float do XLSX (`4.1399999999999997`) são aceitos e arredondados a 2 casas.
9. Monta o JSON, **valida antes de gravar** (schema, 3 produtos, semana com 7 dias,
   faixas plausíveis, ≥ 20 UFs) e grava de forma atômica (arquivo temporário + rename).

## Segurança: nunca grava JSON parcial

Antes de escrever, `validarPrecos()` exige, entre outras coisas:

- `fonte`, `url` (http/https), `semana` com **7 dias** e `atualizadoEm` ISO;
- exatamente `gasolinaComum`, `gasolinaAditivada` e `etanol` no bloco `brasil`;
- `min <= media <= max`, médias plausíveis (gasolina 2–12 R$/L; etanol 1–9 R$/L) e
  `postos` inteiro positivo;
- ≥ 20 UFs no bloco `estados`, cada uma com `gasolinaComum` e valores plausíveis.

Se algo não bater, o script mostra os erros no stderr, sai com código 1 e **deixa o
`precos.json` anterior intacto** (o app continua funcionando com o dado antigo).

Quando os dados são idênticos aos da versão anterior, o `atualizadoEm` é preservado e o
arquivo é regravado byte a byte igual — o `git diff` fica limpo e a Action não cria commit
vazio.

## Como a GitHub Action funciona

Arquivo: [`.github/workflows/atualizar-precos.yml`](../.github/workflows/atualizar-precos.yml).

- **Gatilhos:** agendada (`schedule`) para **segunda 06:00 UTC** (03:00 em Brasília) e
  **terça 13:00 UTC** (10:00 em Brasília — segunda chance se a ANP publicar atrasado),
  além de `workflow_dispatch` com a opção de forçar uma semana.
- **Ambiente:** `ubuntu-latest`, `actions/checkout@v4`, `actions/setup-node@v4` com
  **Node 24**. Nenhum `npm install`.
- **Passos:** roda `node tools/test-prices.mjs` → roda `node tools/update-prices.mjs` →
  `git diff --quiet -- precos.json`; **só commita se o arquivo mudou**, com a identidade do
  bot (`github-actions[bot]`), `permissions: contents: write` e `git add` apenas em
  `precos.json`.
- **Se a ANP mudar o layout** e a extração falhar, o passo do script falha (exit 1) e
  nada é commitado: a Action fica vermelha para alguém corrigir, mas o app continua com
  o último JSON válido. Não há fallback silencioso que possa publicar dado quebrado.
- Rodar manualmente: **Actions → "Atualizar preços da ANP" → Run workflow** (campo
  `semana` opcional, formato `AAAA-MM-DD_AAAA-MM-DD`).

O `precos.json` é servido **pela mesma origem** do app (ex.: GitHub Pages), então o
`fetch('precos.json')` não esbarra em CORS. Se o app for aberto direto do disco
(`file://`), o `fetch` falha — o app deve cair para as médias embutidas / preços do usuário.

## Limitações e decisões

- **CORS:** a ANP **não** envia `Access-Control-Allow-Origin` nos arquivos do LPC
  (XLSX/ZIP/PDF). Um site estático não consegue lê-los no navegador; por isso o JSON é
  gerado fora do app (script + Action) e servido na mesma origem. Ver
  [`research/FINDINGS.md` §2.2](../research/FINDINGS.md).
- **XLSX, não JSON/CSV:** o resumo semanal só existe em XLSX; o parser ZIP/XML é
  proposital e mínimo. É sensível a mudanças de layout da ANP — o cabeçalho é detectado
  por conteúdo e a suíte de testes cobre o formato atual.
- **min/max são de médias municipais:** a ANP agrega por município; o "mínimo" da tabela
  BRASIL é a menor das médias municipais, não o preço de um posto. A UI deve rotular
  como amplitude do levantamento.
- **Semanal, não ao vivo:** o dado tem até ~1 semana de defasagem e cobre a semana
  anterior. A data precisa aparecer junto do preço.
- **Semana domingo–sábado:** é o período observado nos arquivos oficiais (04/10/2026 é
  domingo, 10/10/2026 é sábado). Alguns nomes de arquivo antigos usam `-` como separador
  e dia sem zero (`2026-08-30-2026-09-5.xlsx`); o script normaliza.
- **Cobertura variável:** a ANP pode não pesquisar um produto em uma UF na semana
  (ex.: Amapá sem etanol em 04–10/10/2026). Nesse caso a chave é omitida, em vez de
  inventar número. O bloco nacional precisa dos 3 produtos, senão o script falha.
- **Licença:** a página de dados abertos da ANP **não declara explicitamente a licença**
  no HTML lido em 17/10/2026 (ver `research/FINDINGS.md` §2.1-D). O app credita a fonte
  ("Dados: ANP — Levantamento de Preços de Combustíveis"); antes de redistribuir em
  outro contexto, confira o conjunto no Portal Brasileiro de Dados Abertos
  (`dados.gov.br`) e os termos de uso do `gov.br`.
- **Sem dados por município/posto:** o `precos.json` é intencionalmente pequeno (~2,5 KB,
  carrega instantaneamente e funciona offline). Médias por município ou preço por posto
  exigiriam outro recorte (e um arquivo bem maior).

## Testes

```sh
node tools/test-prices.mjs
```

A suíte monta fixtures em memória (ZIP com *store* e *deflate*, XLSX sintético com
shared strings, inline strings, float com artefato e datas em série do Excel, HTML da
página da ANP) e cobre: leitor de ZIP, parse de XML/shared strings, normalização de
produto/UF, parse de número pt-BR, datas e semana, escolha do link mais recente,
montagem e validação do JSON, detecção de "sem mudança". No fim, valida o `precos.json`
real do repositório (schema, 3 produtos, semana de 7 dias domingo–sábado, faixas
plausíveis, ≥ 20 UFs) e, para a semana de referência 04–10/10/2026, confere os valores do
`research/FINDINGS.md` (6,54 / 6,72 / 4,14 e SP 6,36 / 3,86).

Saída esperada: uma linha `ok N — ...` por teste e, no estado inicial (semana de
referência 04–10/10/2026), `99 ok, 0 falhas`. Quando a semana publicada já não for mais
a de referência, os 2 testes que conferem os valores exatos do FINDINGS são pulados e a
saída fica `97 ok, 0 falhas`.
