# FINDINGS — pesquisa para a v2 do Abastece Certo

**Autor:** pesquisador (subagente de pesquisa) · **Data da pesquisa:** 17/10/2026 · **Escopo:** `research/` (nenhum arquivo de produção foi editado)
**Método:** `web_search`/`web_fetch` para páginas e documentos; `node` (Node 24) para checar cabeçalhos HTTP/CORS, baixar e medir arquivos; Python 3.11 + openpyxl para ler os XLSX oficiais da ANP. Todas as URLs abaixo foram abertas nesta sessão em 17/10/2026, salvo indicação.

**Legenda de confiança**
- **[FATO]** — verificado nesta sessão, com URL e data; trecho entre aspas quando a fonte é citada literalmente.
- **[ESTIMATIVA]** — conta/faixa derivada de dados verificados, sem fonte direta que publique exatamente esse número.
- **[NÃO VERIFICADO]** — não consegui confirmar; não trate como base de implementação.

---

## 0. Resumo executivo — o que muda decisões de implementação

1. **A mistura vigente em outubro/2026 não é mais E30: é E32 (32% de etanol anidro) na gasolina comum e na aditivada.** Entrou em vigor em 01/08/2026 (Resolução CNPE nº 9/2026), é **temporária** (180 dias, prorrogável uma vez) e **não vale para a premium**, que continua E25. Portanto o par "70% / 71% (E30)" da v1 está desatualizado.
2. **Limite recomendado para a E32: ~72% (faixa defensável 71–73%)**, com ressalva de que o número é heurístico e varia por motor. Para gasolina premium (E25), o limite volta a ~70%. O modo preciso (consumo real) é a única resposta exata.
3. **A "regra dos 70%" nasceu como heurística de *consumo* (2003, lançamento do flex), não como igualdade de poder calorífico.** Energia por litro do etanol hidratado / gasolina C ≈ 0,73–0,74; o consumo real fica em ~0,70–0,75 porque motores flex aproveitam melhor a octanagem do etanol. **Não escrever "o etanol tem 70% da energia da gasolina"**: em relação à gasolina pura é ~66%; em relação à gasolina C atual é ~73%.
4. **Preços ao vivo da ANP não são viáveis em site estático sem backend:** os arquivos oficiais (XLSX/ZIP/PDF) são servidos **sem `Access-Control-Allow-Origin`** (verificado nos cabeçalhos), não há endpoint JSON documentado, e o arquivo semanal é XLSX (~300 KB) — o browser não o lê sem biblioteca. Alternativas realistas: preços médios embutidos, importação de arquivo local, ou GitHub Action semanal que gera um JSON no próprio repositório (dados de médias semanais, não "ao vivo").
5. **GitHub/ecossistema: nada justifica adotar dependência de runtime.** Biblioteca nenhuma paga o custo neste app; o que vale copiar dos projetos similares são ideias de UX (comparação por 100 km, histórico de postos, perfis de veículo). Tabela com tamanhos gzip medidos na seção 3.
6. **PWA:** service worker **não é requisito de instalabilidade** no Chrome/Edge (manifest + ícones 192/512 + HTTPS bastam); `maskable` e `screenshots` são recomendados, não exigidos. O `sw.js` já em edição no repo está na estratégia recomendada (network-first para navegação + stale-while-revalidate para estáticos), mas tem uma armadilha de versão mista (`skipWaiting()` automático + `clients.claim()`).
7. **Acessibilidade:** `aria-live="polite"` (ou `role="status"`) no resultado, abas com `role=tablist/tab`, `aria-selected`, `aria-controls` e navegação por setas, foco visível, contraste ≥ 4,5:1 e respeito a `prefers-reduced-motion`.
8. **Teste sem dependências confirmado:** bloco de lógica marcado no HTML, extraído por regex e rodado em `node:vm` — 6/6 casos passaram. Requisito: o bloco não pode tocar DOM `localStorage`/`window` no carregamento.
9. **Números para a UI:** gasolina comum R$ 6,54 (média nacional, 04–10/10/2026), etanol R$ 4,14; faixas P1–P99 do 1º semestre/2026: gasolina 5,69–7,74 e etanol 3,49–5,99. Consumo típico flex (PBEV/Inmetro): gasolina 10–15 km/L cidade, 13–18 estrada; etanol ≈ 0,70–0,74 disso.

---

## 1. Fundamentos e correção da física

### 1.1 Poder calorífico (energia por litro)

**[FATO]** Valores de referência do Engineering ToolBox (tabela de Higher/Lower Calorific Values, acesso 17/10/2026 — <https://www.engineeringtoolbox.com/fuels-higher-calorific-values-d_169.html>):

| Combustível | Densidade (kg/L, 15 °C) | PCI — LHV (MJ/kg) | PCI — LHV (MJ/L) | PCS — HHV (MJ/L) |
|---|---|---|---|---|
| Gasolina (petrol)† | 0,737 | 43,4 | **32,0** | 34,2 |
| Etanol 100% (anidro) | 0,789 | 26,7 | **21,1** | 23,4 |

† A tabela ressalva que misturas de hidrocarbonetos variam 5–10% entre lotes/mercados; a densidade influencia diretamente o MJ/L.

**Cálculo meu a partir da tabela (ESTIMATIVA):** gasolina pura 43,4 × 0,737 = **32,0 MJ/L**; etanol anidro 26,7 × 0,789 = **21,1 MJ/L**. Razão etanol anidro / gasolina pura = **0,659** (≈ 2/3, não 70%).

**[ESTIMATIVA] Etanol hidratado (o da bomba):** tem água (ordem de 4–7% v/v), densidade um pouco maior e PCI/L um pouco menor que o anidro. Faixa de trabalho: **20,3–21,1 MJ/L**. Não encontrei nesta sessão uma tabela oficial legível com o valor exato: a referência oficial é o Anuário Estatístico da ANP — "Convention Factors, Densities and Lower Calorific Values" (PDF, <https://www.gov.br/anp/pt-br/centrais-de-conteudo/publicacoes/anuario-estatistico/arquivos-yearbook-2026/others-documentary-parts/convertion-factors-2026.pdf>); o `web_fetch` não extrai PDF e não havia biblioteca de PDF disponível — **[NÃO VERIFICADO] valor oficial exato do PCI/L do etanol hidratado**.

**[FATO] Gasolina C (mistura brasileira):** a energia por litro cai conforme sobe o teor de anidro. Composição aproximada, ignorando contração de volume na mistura:
`PCI_C(m) = (1 − m) × 32,0 + m × 21,1` (m = fração de etanol anidro), em MJ/L.

| Mistura | Onde é usada (out/2026) | PCI/L calculado | Razão energia etanol hidratado† / gasolina C |
|---|---|---|---|
| E25 | gasolina premium | 29,27 MJ/L | 71,7% |
| E27 | histórico (até jul/2025) | 29,06 MJ/L | 72,3% |
| E30 | ago/2025 – jul/2026 | 28,73 MJ/L | 73,1% |
| E32 | **comum e aditivada, desde 01/08/2026** | 28,51 MJ/L | 73,7% |
| E35 | em teste, sem data de vigência | 28,19 MJ/L | 74,5% |

† assumindo etanol hidratado = 21,0 MJ/L (ponto médio da faixa estimada). Todos os números da coluna PCI e razão são **[ESTIMATIVA]** calculada a partir do PCI/kg e densidades **[FATO]** do Engineering ToolBox.

**Armadilha central:** energia por litro **não é** consumo por litro. O motor flex não converte gasolina e etanol com a mesma eficiência térmica — o etanol tem maior octanagem e permite avanço de ignição/compressão mais agressivo, o que **reduz** a desvantagem de consumo em relação ao que a energia por litro sugere. Por isso o limiar real (consumo) fica **abaixo** da razão energética: ~70–75% contra ~72–75% de energia. Qualquer texto no app deve dizer que é **aproximação**.

### 1.2 De onde vem a "regra dos 70%"

- **[FATO]** "Os 70% na variação do valor de um combustível para o outro é falado desde 2003, quando o flex surgiu." — Boris Feldman, AutoPapo, 12/08/2020: <https://autopapo.com.br/blog-do-boris/nova-gasolina-cauculo-70/>. O mesmo texto diz que o número "pode ser de 70%, 72% ou até 75%; depende do motor e do combustível".
- **[FATO]** AEA (Rogério Gonçalves, diretor de combustíveis) explica que a relação é "baseada no poder calorífico" e que "essa densidade energética do etanol hidratado era aproximadamente 70% da gasolina C"; com a E30, "podemos considerar algo próximo de 71%". Fonte: O Estado de S. Paulo / Jornal do Carro, reproduzido em <https://minaspetro.com.br/etanol-ou-gasolina-entenda-como-a-regra-dos-70-pode-fazer-voce-perder-dinheiro/> (24/02/2026) e na Fecombustíveis (link original do projeto: <https://www.fecombustiveis.org.br/noticia/etanol-ou-gasolina-entenda-como-a-regra-dos-70-pode-fazer-voce-perder-dinheiro/263643>).
- **[FATO]** A reportagem também registra que a regra "nunca foi uma ciência exata", que Vitor Sabag (especialista em combustíveis/Gasola) a chama de "direcionamento" e que o certo é medir o consumo real do veículo.

**Conclusão [ESTIMATIVA]:** a formulação fisicamente correta é `custo/km = P/C`. A regra dos 70% é o caso particular `P_etanol/P_gasolina < 0,70`, **calibrado empiricamente** para a frota flex da época do E25/E27; não é uma lei física e não deve ser apresentada como "o etanol tem 70% da energia".

### 1.3 Calendário oficial da mistura e o que está vigente em outubro/2026

| Período | Mistura obrigatória (gasolina C comum/aditivada) | Base legal/fonte |
|---|---|---|
| 2015–jul/2025 | E27 (antes E25 até 2015) | histórico citado em AutoPapo/2026 e ANP |
| ago/2025 – jul/2026 | **E30** | Lei nº 14.993/2024 (Combustível do Futuro); notícias ANP/MME |
| **01/08/2026 – em vigor em 17/10/2026** | **E32**, por 180 dias, prorrogável uma única vez por igual período | **Resolução CNPE nº 9/2026**, publicada em edição extra do DOU de 30/07/2026 |
| premium (Podium/V-Power etc.) | **E25** (não mudou) | resolução do E32 não alterou a premium; guia Combustíveis ANP (01/10/2026) |

**[FATO]** ANP, notícia de 31/07/2026 (<https://www.gov.br/anp/pt-br/canais_atendimento/imprensa/noticias-comunicados/e32-gasolina-com-32-de-etanol-passa-a-valer-temporariamente-a-partir-de-amanha-1-8>): *"Foi publicada ontem (30/7), em edição extra do Diário Oficial da União, a Resolução CNPE nº 9/2026, que estabelece, em caráter excepcional e temporário, a mistura obrigatória de 32% de etanol anidro na gasolina C comum e na gasolina C comum aditivada (...) A medida entra em vigor amanhã, em 1º de agosto de 2026, e terá duração de 180 dias, podendo ser prorrogada uma única vez por igual período. A medida substitui temporariamente o percentual anteriormente vigente de 30% (E30)."* A mesma notícia diz que o RON permanece 94,0 (Resolução ANP nº 807/2020) e que a premium não foi alterada.
**[FATO]** MME/CNPE, 24/07/2026 (<https://www.gov.br/mme/pt-br/assuntos/conselhos-e-comites/cnpe/comunicacoes/cnpe-aprova-elevacao-do-teor-de-etanol-anidro-na-gasolina-para-32>): aprovação em 14/07/2026, vigência de 180 dias prorrogável uma vez; decisão condicionada aos testes do E35.
**[FATO]** Agência Gov, 31/07/2026 (<https://agenciagov.ebc.com.br/noticias/202607/resolucao-que-institui-o-e32-e-publicada-e-nova-mistura-passa-a-valer-neste-sabado>): E32 por 180 dias, base na Lei 14.993/2024; ensaios do Instituto Mauá; adoção definitiva do E32 ou de misturas maiores condicionada aos testes do E35.
**[FATO]** E35: portaria do MME publicada em 18/09/2026 inicia os ensaios, com previsão de conclusão em 2027; a adoção **não é automática**, depende de decisão do CNPE. Fonte: AutoPapo, 21/09/2026 (<https://autopapo.com.br/curta/gasolina-com-35-de-etanol-entra-em-testes-entenda-o-que-muda-no-seu-carro/>).
**[FATO]** Premium segue com 25% de etanol; comum e aditivada com 32% desde 01/08/2026. Fonte: guia do site Combustíveis ANP, atualizado em 01/10/2026 (<https://www.combustiveis-anp.com.br/guia/gasolina-premium-fora-da-regra-dos-32-de-etanol>). O mesmo guia informa que, na semana de 20–26/09/2026, a média nacional do site foi R$ 6,59 (comum) e R$ 6,77 (aditivada).
**[NÃO VERIFICADO]** Não localizei, até 17/10/2026, notícia de revogação, suspensão judicial ou prorrogação do E32. Existe ao menos um projeto de decreto legislativo para suspender a mistura (notícia Poder360/Notícias Agrícolas), mas **sem aprovação confirmada**. Ou seja: **E32 é a mistura vigente em outubro/2026**, com prazo legal até ~28/01/2027 e possibilidade de mudar de novo.

### 1.4 Dá para calcular o limite a partir da mistura? Sim, com ressalvas

**Fórmula de referência (custo por km):**
```
etanol compensa  ⇔  P_etanol / P_gasolina  <  C_etanol / C_gasolina
```
onde `C` é o consumo (km/L) de cada combustível no veículo. A "regra dos 70%" é `C_etanol/C_gasolina = 0,70`.

**Estimativa do limite em função da mistura (ESTIMATIVA calibrada):**
```
PCI_C(m) = (1 − m) × 32,0 + m × 21,1          [MJ/L; m = fração de anidro]
limite(m) ≈ 0,70 × PCI_C(0,27) / PCI_C(m)      [ancorado no 70% clássico do E27]
          = 0,70 × 29,06 / PCI_C(m)
```
Resultados (arredondados a 0,1 p.p.):

| Mistura | Limite estimado por essa fórmula |
|---|---|
| E25 (premium) | 69,5% (≈ 70%) |
| E27 | 70,0% |
| E30 | 70,8% (≈ 71%; **coincide com o número da AEA**) |
| **E32 (vigente)** | **71,3% (≈ 71–72%)** |
| E35 (se aprovado) | 72,2% (≈ 72%) |

**Mas há divergência entre fontes sobre o número da E32:**
- **[FATO]** AutoPapo/AUTOTEMPO (via Minaspetro, 04/08/2026 — <https://minaspetro.com.br/gasolina-e32-aprenda-a-calcular-se-o-etanol-vale-mais-a-pena/>): "A regra original (...) foi criada quando a gasolina tinha 25% de etanol (...). Com as mudanças seguintes para E27 e E30, esse limite subiu gradualmente para a faixa dos **72% a 74%**. Agora, com a gasolina E32, o ponto teórico de virada em motores flex modernos fica entre **73% e 75%**." A mesma matéria diz que a redução de autonomia da E30 para a E32 é de ~1% a 1,5%.
- **[ESTIMATIVA]** A conta de energia acima dá 71,3% para E32, não 73–75%. A diferença é o ganho de eficiência do motor com etanol, que as fontes incorporam empiricamente (motores modernos) e a conta de energia não captura. **As duas visões são heurísticas**: a de energia é conservadora; a de "motores modernos" é otimista e depende do carro.
- **[FATO]** Dados do Inmetro/PBEV de carros flex 2026 mostram razões de consumo etanol/gasolina de **0,70 a 0,74** em modelos eficientes (ver 1.5), o que puxa o limite real para cima do 70% clássico.

**Recomendação para o app (decisão de produto):**
- **Modo rápido:** default **72%** para "gasolina comum/aditivada (E32, desde ago/2026)", com texto "faixa 71–73%; motores modernos podem chegar a ~75%". Manter 70% como opção "regra clássica/conservadora" e 71% como "E30 (até jul/2026)".
- **Gasolina premium (E25):** 70%.
- **Melhor ainda:** um seletor de mistura (E25 premium / E27 / E30 / E32 / E35) que calcula o limite pela fórmula acima e mostra "valor estimado", + slider manual 60–80%, + o modo preciso como caminho exato. Não esconder que o número é aproximado.
- **Nunca** apresentar o limite como "o número correto": a documentação pública não define um limiar oficial; é heurística de mercado.

### 1.5 Margem real: o que a literatura/imprensa técnica diz

- **[FATO]** AEA/O Estado: relação típica varia com "taxa de compressão, mapeamento da injeção e ignição, pressão de injeção, ângulo de injeção e formato da câmara de combustão"; um motor pode ser otimizado para gasolina e outro para etanol; com gasolina mais octanada (94 RON), "alguns motores podem ser ainda mais eficientes com gasolina". (Minaspetro/Estadão, 24/02/2026.)
- **[FATO]** Guia "regra dos 70%" do site Combustíveis ANP (atualizado 03/09/2026 — <https://www.combustiveis-anp.com.br/guia/regra-dos-70>): carros novos/eficientes com etanol "podem chegar a 75%"; carros antigos, "65%"; carro turbo flex, "73–75%"; viagem longa em estrada pode cair para "68%".
- **[FATO + cálculo meu]** Amostra de consumo PBEV/Inmetro 2026 publicada pela Vrum em 24/07/2026 (<https://www.vrum.com.br/bom-negocio/2026/07/7467386-os-5-carros-flex-mais-economicos-do-brasil-em-2026.html>):
  - Onix 1.0T MT: gasolina 13,7 (cidade) / 17,7 (estrada); etanol 9,9 / 12,9 km/L → razão **0,723 / 0,729**;
  - Onix Plus 1.0T MT: 13,9 / 17,1 e 10,1 / 12,5 → **0,727 / 0,731**;
  - Renault Kwid 1.0: 14,6 / 15,5 e 10,8 / 10,9 → **0,740 / 0,703**.
  - **[ESTIMATIVA]** faixa realista para carros flex populares: **0,70–0,75**; para frota antiga, ~0,65–0,70; para turbo/otimizados a etanol, até ~0,75–0,78. A faixa "0,70–0,78" citada na REFERENCIA.md da v1 é plausível como limite superior, mas **não encontrei fonte primária** que a publique como faixa única — tratar como estimativa.
- **[FATO]** A própria imprensa diz que a regra "pode fazer perder dinheiro" e que a decisão correta é medir o consumo real (Fecombustíveis/Estadão; AutoPapo; guia ANP). Nenhuma fonte séria defende um número único.

### 1.6 Armadilhas a deixar explícitas no app

1. **Energia ≠ consumo.** O motor flex muda de eficiência entre combustíveis; o "70%" é calibração empírica, não física de combustão.
2. **Mistura muda o limite.** E25→E30→E32 (e E35 no futuro) deslocam o limiar ~+0,5 a +1 p.p. por passo. Um app que mostra 71% fixo já está defasado em out/2026.
3. **Premium é E25**, não E32. Quem abastece premium deve usar limite ~70%, não 72%. Muita gente não sabe que a premium ficou fora da regra dos 32%.
4. **Gasolina "batizada"** com mais etanol que o legal (relatos de 40–70% em fiscalizações citados pelo ICL na reportagem do Estadão) piora a autonomia; o cálculo não detecta isso.
5. **Condições de uso** (temperatura, vento, pneus, trânsito, estilo de condução) alteram mais o consumo do que o combustível em muitos casos.
6. **Uso do número no app:** se o usuário vê "72%" e o carro dele rende 0,68, ele perde dinheiro. O app deve empurrar o modo preciso e tratar o rápido como estimativa.

---

## 2. Dados e APIs de preço da ANP

### 2.1 Canais oficiais (verificados, com status HTTP e CORS)

Todas as checagens foram feitas por `fetch` do Node 24 em 17/10/2026; "CORS" = presença de `Access-Control-Allow-Origin` na resposta.

**A) Levantamento semanal (LPC) — página de listagem**
<https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/levantamento-de-precos-de-combustiveis-ultimas-semanas-pesquisadas>
- **[FATO]** HTTP 200, `text/html`. **CORS: ausente.** A página lista, por semana, dois XLSX:
  - `.../arquivos-lpc/{ANO}/resumo_semanal_lpc_{AAAA-MM-DD}_{AAAA-MM-DD}.xlsx` — médias por Brasil/região/UF/município/capital;
  - `.../arquivos-lpc/{ANO}/revendas_lpc_{AAAA-MM-DD}_{AAAA-MM-DD}.xlsx` — posto a posto (CNPJ, endereço, bandeira, preço).
- **[FATO]** Exemplo real da semana **04–10/10/2026**: `https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/arquivos-lpc/2026/resumo_semanal_lpc_2026-10-04_2026-10-10.xlsx` → HTTP 200, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, **297.219 bytes**, `cache-control: public, max-age=604800`, **CORS ausente**.
- **[FATO]** Conteúdo do `resumo_semanal`: abas `CAPITAIS`, `MUNICIPIOS`, `ESTADOS`, `REGIOES`, `BRASIL`; cabeçalho na linha 10 (1-based); colunas: `DATA INICIAL`, `DATA FINAL`, `ESTADO`/`MUNICÍPIO` ou `REGIÃO`/`BRASIL`, `PRODUTO`, `NÚMERO DE POSTOS PESQUISADOS`, `UNIDADE DE MEDIDA`, `PREÇO MÉDIO REVENDA`, `DESVIO PADRÃO REVENDA`, `PREÇO MÍNIMO REVENDA`, `PREÇO MÁXIMO REVENDA`, `COEF DE VARIAÇÃO REVENDA`. Produtos: ETANOL HIDRATADO, GASOLINA COMUM, GASOLINA ADITIVADA, OLEO DIESEL, OLEO DIESEL S10, GNV, GLP.
- **[FATO]** Periodicidade semanal (semana domingo–sábado nos arquivos observados). O `revendas_lpc` da mesma semana está linkado na página; **não baixei** (o repositório abastevo documenta ~1,5–2,5 MB/semana e ~20 mil linhas — <https://raw.githubusercontent.com/wiki/AlexandreZanata/abastevo/docs-data-sources.md>).

**B) Série histórica semestral (dados abertos)**
<https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/serie-historica-de-precos-de-combustiveis>
- **[FATO]** HTTP 200. Arquivos por semestre: `.../shpc/dsas/ca/ca-{ANO}-{01|02}.zip` (automotivos) e `.../shpc/dsas/glp/glp-{ANO}-{01}.csv` (GLP), além de `precos-semestrais-ca.zip` e metadados em PDF.
- **[FATO]** `ca-2026-01.zip` (1º semestre/2026): HTTP 200, `application/zip`, **8.488.624 bytes**, contém **1 CSV de 72.117.162 bytes** ("Preços semestrais - AUTOMOTIVOS_2026.01.csv"), separador `;`, **UTF-8 com BOM**, decimal com vírgula. Colunas: `Regiao - Sigla`; `Estado - Sigla`; `Municipio`; `Revenda`; `CNPJ da Revenda`; `Nome da Rua`; `Numero Rua`; `Complemento`; `Bairro`; `Cep`; `Produto`; `Data da Coleta`; `Valor de Venda`; `Valor de Compra`; `Unidade de Medida`; `Bandeira`.
- **[FATO]** Arquivo do 2º semestre/2026 (`ca-2026-02.*`) **não estava listado** na página em 17/10/2026 (o semestre ainda não fechou); o dado mais recente disponível ali é o 1º semestre. Para a semana corrente, use o LPC (item A).
- **[FATO]** Metadados: `.../shpc/metadados-serie-historica-precos-combustiveis-1.pdf` (HTTP 200, `application/pdf`, 191.035 bytes; **CORS ausente**).

**C) Síntese semanal / painéis**
- **[FATO]** Existe a página <https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/sintese-semanal-do-comportamento-dos-precos-dos-combustiveis> (linkada na página de Preços; HTTP 200 na página-mãe) e painéis dinâmicos da ANP. **Não localizei endpoint JSON público documentado** para consumo por site de terceiros — **[NÃO VERIFICADO]** se os painéis usam alguma API interna com CORS.

**D) Licença**
- **[NÃO VERIFICADO]** A página da série histórica não declara explicitamente a licença no HTML que consegui ler. A ANP declara dados públicos e o Portal Brasileiro de Dados Abertos usa licença aberta, mas **não confirmei o termo exato** (ODbL/CC) nesta sessão. Antes de redistribuir os dados no app, conferir o conjunto de dados no `dados.gov.br` e citar a fonte ("Dados: ANP — Levantamento de Preços de Combustíveis"). Crédito à ANP é obrigatório por boa prática e pela origem governamental.

### 2.2 CORS: teste real e conclusão

| Recurso | HTTP | Content-Type | `Access-Control-Allow-Origin` |
|---|---|---|---|
| Página LPC (HTML) | 200 | text/html | **ausente** |
| `resumo_semanal_lpc_2026-10-04_2026-10-10.xlsx` | 200 | application/vnd...sheet | **ausente** |
| `ca-2026-01.zip` | 200 | application/zip | **ausente** |
| `metadados...pdf` | 200 | application/pdf | **ausente** |

**[FATO] Conclusão:** um site estático **não consegue** `fetch()` nesses arquivos de outra origem — o navegador bloqueia a leitura por CORS. Mesmo que o CORS existisse, o resumo é **XLSX** (o browser não o decodifica sem biblioteca, e trazer uma lib de XLSX pesada quebraria "arquivo único, zero build") e a série histórica é um **CSV de 72 MB** (inviável para celular).

**Portanto: "preços ao vivo da ANP" no sentido de buscar o dado oficial no navegador, direto do site estático, não é viável.** Isso confirma a suspeita já registrada na REFERENCIA.md da v1.

### 2.3 Alternativas viáveis (ordenadas por pragmatismo)

1. **Preços médios embutidos + data visível (recomendado para a v2).** Embarcar no HTML/JSON um pequeno conjunto de médias nacionais/UF (ex.: gasolina comum 6,54; etanol 4,14; semana 04–10/10/2026) com selo "dados de ...". Custo zero, offline, sem CORS. O usuário ajusta o preço real do posto de qualquer forma — o preço médio é só placeholder/contexto. (Usar como fonte: o XLSX semanal da ANP.)
2. **Importar arquivo local.** `<input type="file">` + `FileReader` no CSV/XLSX baixado pelo próprio usuário **não passa por CORS** (é arquivo local). Funciona para usuários avançados; exige parser simples de CSV (histórico) — XLSX exigiria lib. Bom "power feature" opcional, fora do caminho principal.
3. **GitHub Action semanal → JSON no próprio repositório.** Um workflow (ou script manual) roda 1×/semana, baixa o `resumo_semanal_lpc_*.xlsx`, extrai as médias de interesse e commita `precos.json`; o app busca esse JSON **na mesma origem** do site (GitHub Pages) — sem CORS. Não é "ao vivo", é "semanal com data". É a única forma de manter os números atualizados sem backend em runtime. Custo: 10–20 linhas de Action + um script; quebra o "zero build" apenas se o JSON for gerado no build (pode ser commitado por um Action separado, mantendo o app estático).
4. **API de terceiro.** **[FATO]** O repositório `VictorrCabral/precos-combustivel-api` (<https://github.com/VictorrCabral/precos-combustivel-api>) implementa uma API pública (Spring Boot + PostgreSQL) sobre o LPC, **mas o README diz "funcionando localmente. Deploy público em andamento"** — **não há endpoint público utilizável** em 17/10/2026. O `abastevo` (<https://github.com/AlexandreZanata/abastevo>) é app Android, não API. Não encontrei nenhum endpoint comunitário público, estável e com CORS liberado — **não inventar/citar endpoint não verificado**.
5. **Proxy CORS público (ex.: allorigins) ou função serverless.** Resolveria o CORS, mas adiciona dependência de terceiro/backend — contraria o escopo ("não tem backend"). Não recomendar.

### 2.4 Preços mais recentes (verificados nos arquivos oficiais)

**[FATO] Semana 04–10/10/2026 — médias nacionais de revenda (aba `BRASIL` do resumo semanal da ANP):**
| Produto | Preço médio | Mínimo* | Máximo* | Postos |
|---|---|---|---|---|
| Gasolina comum | **R$ 6,54/L** | 5,39 | 8,99 | 4.474 |
| Gasolina aditivada | **R$ 6,72/L** | 5,59 | 8,99 | 3.443 |
| Etanol hidratado | **R$ 4,14/L** | 3,09 | 6,59 | 3.833 |

\* mín/máx das **médias municipais**, não dos preços de posto. Média nacional simples etanol/gasolina = **0,633** na semana (etanol favorável no país, mas isso não vale para todo mundo).
**[FATO] Variação por UF na mesma semana** (médias da aba `ESTADOS`, cálculo meu): razão etanol/gasolina comum de **0,607 (SP)** a **0,762 (RN)**. Extremos: SP 0,607 (3,86/6,36), MT 0,610, MS 0,621, PR 0,637, GO 0,653; RN 0,762 (5,03/6,60), SE 0,758, MA 0,746, AL 0,742, RS 0,730. **Isso mostra por que um limite único não serve**: em SP o etanol compensa com folga; em RN está perto do limiar mesmo com 70%.

---

## 3. Ecossistema GitHub

### 3.1 Projetos similares (todos com URL aberta em 17/10/2026)

| Projeto | Stack | O que faz melhor que a v1 | Observações |
|---|---|---|---|
| [TallesDiniz/Calculadora-Gasolina-x-Etanol](https://github.com/TallesDiniz/Calculadora-Gasolina-x-Etanol) | React + Vite + TS, deploy Vercel | Simplicidade e deploy estático; UI limpa | Só regra 70%, sem modo preciso, sem offline; precisa de build |
| [carvalhoFilip/alcool-gasolina](https://github.com/carvalhoFilip/alcool-gasolina) | Flutter | **Modo preciso**: pede preço e consumo (km/L) de cada combustível e compara custo/km | Nativo (não web); ideia de UX reaproveitável |
| [Rudyzinho/alcool-ou-gasolina-estendido](https://github.com/Rudyzinho/alcool-ou-gasolina-estendido) | Kotlin + Jetpack Compose + OSMDroid | **Histórico de postos** com preços, mapa, e escolha de critério **70% ou 75%**; guarda o critério usado no registro | Mostra que oferecer 70/75 é comum; persistência local |
| [AlexandreZanata/brazil-fuel-prices-app](https://github.com/AlexandreZanata/brazil-fuel-prices-app) / [abastevo](https://github.com/AlexandreZanata/abastevo) | Kotlin/Compose + Room + WorkManager; XLSX da ANP | **Dados da ANP offline**: sync semanal do XLSX, busca de ~5.570 municípios, detalhe por posto, perfis de veículo, alertas locais; MIT | Referência de dados: docs/wiki documentam **exatamente** os padrões de URL e colunas do LPC (usei para conferir os meus) |
| [VictorrCabral/precos-combustivel-api](https://github.com/VictorrCabral/precos-combustivel-api) | Spring Boot + PostgreSQL + Python ETL | Prova que "preço por município" pede **backend** (ETL + agregação + cache) | **Não está deployado** (README: "deploy público em andamento"); não usar como API |

**Conclusões para o Abastece Certo:** (a) ninguém no ecossistema resolve "preço ao vivo de site estático" sem backend; (b) os diferenciais que valem copiar são **modo preciso** (carvalhoFilip), **histórico/perfis** (Rudyzinho/abastevo) e **comparação por 100 km**; (c) nenhum usa a mistura E32 no limiar — há espaço para o app ser mais correto que os concorrentes.

### 3.2 Bibliotecas candidatas — tamanhos medidos nesta sessão

Medição por download do arquivo servido + `gzip -9` local (Node 24), 17/10/2026. "gzip" é o que o navegador baixa com `Content-Encoding: gzip` (aproximado; CDNs podem servir brotli, ~10–15% menor).

| Biblioteca | Arquivo medido | Bruto | **gzip** | Prós para este projeto | Contras |
|---|---|---|---|---|---|
| Alpine.js 3.14.9 | `dist/cdn.min.js` | 43,7 KiB | **15,8 KiB** | Zero build; reatividade declarativa (`x-data`), reduz JS manual de UI | Mais peso que todo o app atual (~17 KB); exige atributos `x-*`; CDN externo quebra offline/arquivo único (teria de inline); superfície extra |
| Preact 10.26.4 + htm 3.1.1 | `preact.min.js` + `htm.umd.js` | 10,9 + 1,3 KiB | **5,4 KiB** | Componentização com 5 KB; sem build com `htm` | VDOM/JSX mental model para 2 inputs e 1 resultado; ainda é dependência de runtime; nada que CSS/JS atual não faça |
| Lit 3.3.1 | entrypoints medidos (`index.js` 0,2; `lit-html.js` 7,1; `lit-element.js` 1,1 KiB — implementação em chunks) | — | **~5–7 KiB (ESTIMATIVA; não medi o bundle completo)** | Web Components nativos, `html` template | Curva de aprendizado; módulos ES; build/CDN; overkill |
| Chart.js 4.4.9 | `dist/chart.umd.js` | 201,8 KiB | **68,4 KiB** | Gráficos ricos (histórico de preços) | 4× o tamanho do app inteiro; canvas; desnecessário para um gauge de 1 marcador |
| uPlot 1.6.32 | `dist/uPlot.iife.min.js` | 49,9 KiB | **21,6 KiB** | Gráfico leve/rápido | Ainda pesado; o gauge atual em CSS/SVG é melhor e zero-dep |
| workbox-window 7.3.0 | `build/workbox-window.prod.mjs` | 3,3 KiB | **1,3 KiB** | Ajuda no UX de atualização do SW | 1,3 KB por ~20 linhas que se escrevem à mão; não traz precaching sozinho |
| just-validate 4.3.0 | `dist/just-validate.production.min.js` | 29,1 KiB | **6,9 KiB** | Validação pronta | Validação aqui são ~10 linhas (dois números > 0, faixas); não compensa |
| idb-keyval | — | — | não medido (404 no caminho testado) | IndexedDB simples | `localStorage` já resolve preços/limite/perfil; sem necessidade |

### 3.3 Recomendação explícita: o que adotar e o que NÃO adotar

**Adotar: nada como dependência de runtime.** Manter `index.html` único, zero build, zero CDN externo. Justificativa: o app inteiro tem ~17 KB (v1); a menor lib útil (Preact+htm, 5,4 KB gzip) não resolve nenhum problema que o código atual já não resolva, e qualquer CDN quebra o requisito "funciona com duplo clique/offline". As ideias dos projetos similares entram como **código próprio** (~30–80 linhas cada):
- modo preciso (custo por km com consumo real) — já previsto no backlog;
- comparação "por 100 km" (litros e R$ para cada combustível);
- perfil do veículo em `localStorage` (nome, consumo cidade/estrada, combustível habitual);
- histórico local de preços/abastecimentos (opcional, `localStorage`, sem servidor).

**Não adotar:** Alpine, Preact, Lit, Chart.js, uPlot, just-validate, Workbox, qualquer bundler (Vite etc.). Para o gauge, manter CSS/SVG; para atualização do SW, escrever ~20 linhas no próprio app (evento `controllerchange`/`updatefound` + botão "atualizar").

**Exceção possível (não recomendada agora):** se um dia houver gráfico de histórico de preços, `uPlot` (21,6 KB gzip) é a opção mais leve — ainda assim, avaliar um `<canvas>`/SVG próprio antes.

---

## 4. PWA e qualidade

### 4.1 Requisitos atuais de instalabilidade (2025/2026)

**[FATO] MDN — Making PWAs installable** (<https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable>, acesso 17/10/2026):
- Navegadores Chromium (Chrome, Edge, Samsung Internet) exigem no manifest: `name` **ou** `short_name`; `icons` com **192 px e 512 px**; `start_url`; `display` **e/ou** `display_override`; `prefer_related_applications` ausente ou `false`.
- É preciso servir por **HTTPS**, `localhost` ou `127.0.0.1` (o `file://` é contexto seguro, mas **não** é instalável).
- "**Note:** While not a requirement for a PWA to be installable, many PWAs use service workers (...)" — ou seja, **service worker não é requisito de instalabilidade** no Chrome/Edge.
- Desktop: Chromium instala com manifest; Safari (macOS Sonoma+) faz "Add to Dock" com ou sem manifest; **Firefox desktop não instala PWA** por manifest.
- Android: só Chrome (com Google Mobile Services) e Samsung Internet instalam como WebAPK; outros navegadores criam atalho. **iOS 16.4+**: instalação pelo menu Compartilhar do Safari, Chrome, Edge, Firefox e Orion (nas versões antigas, só Safari).
- Chrome/Edge desktop e Android também instalam **qualquer site** como app, mesmo sem manifest — o manifest serve para o navegador **promover** a instalação. Para o app, isso significa: sem manifest/ícones, o usuário ainda consegue "instalar", mas sem o fluxo bonito nem o ícone certo.

**[FATO] Lighthouse/Chrome** (<https://developer.chrome.com/docs/lighthouse/pwa/installable-manifest>): o audit falha se faltar `short_name`/`name`, ícone 192 e 512, `start_url` e `display`. E ressalva: "A web app manifest is necessary (...) but it isn't sufficient."

**[FATO] Ícones `maskable`** (MDN icons — <https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/icons>): `purpose` é opcional; `maskable` permite o recorte do sistema Android (círculo/squircle) sem cortar o desenho. Recomendado: um PNG 512×512 `maskable` (desenho dentro da "safe zone" de ~80% do centro) além dos 192/512 `any`. Existe ferramenta Maskable.app para testar (citada no artigo do web.dev sobre maskable icons).

**[FATO] `screenshots`** (MDN — <https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/screenshots>): o membro é **opcional** ("app stores may not display these images"); serve para a UI de instalação mais rica e para lojas. Recomendação: incluir 1–2 screenshots 1280×720 (form_factor wide) + mobile, se quiser o "richer install UI" no Chrome; **não é requisito**.

**Resumo prático:** para instalar bonito e ser promovido no Chrome/Edge/Android: manifest com `name/short_name`, `start_url`, `display: standalone`, ícones PNG **192, 512 e um 512 maskable**, `theme_color`/`background_color`, HTTPS, e (recomendado) `id`, `scope`, `orientation`, `lang`, `description`, screenshots. Service worker entra por **offline**, não por instalação.

### 4.2 Service worker: estratégias e armadilhas de versionamento

**[FATO] Ciclo de vida** (web.dev — <https://web.dev/articles/service-worker-lifecycle>):
- O SW novo só assume depois que o antigo deixa de controlar clientes; `skipWaiting()` faz o novo ativar imediatamente, mas pode fazer uma página carregada com a versão antiga passar a buscar recursos na nova ("mixed versions") — "If this might break things, don't use `skipWaiting()`".
- `clients.claim()` pode controlar páginas abertas sem SW, mas também é arriscado se o SW serve conteúdo diferente da rede.
- O navegador ignora cache HTTP ao checar atualização do próprio `sw.js`; para os recursos usa cache. `updateViaCache` controla isso.
- Cache Storage é por origem: **prefixar** os nomes (`abastece-certo-...`) para não apagar caches de outros projetos no mesmo `github.io`.
- Para garantir atualização: mudar o nome do cache a cada versão (o `activate` apaga os antigos) **ou** usar `skipWaiting` só sob confirmação do usuário.

**[FATO] Estratégias** (web.dev Offline Cookbook — <https://web.dev/articles/offline-cookbook>): cache-first (bom para estáticos versionados), network-first (bom para conteúdo que muda), stale-while-revalidate (resposta rápida + atualização em background).

**Recomendação para este app (arquivo único):**
1. **Navegação (`request.mode === "navigate"`)**: **network-first** com fallback para o `index.html` em cache. Assim o usuário pega a versão nova quando online e ainda abre offline. (O `sw.js` atual, observado em 17/10/2026, já faz exatamente isso.)
2. **Estáticos** (ícones, manifest): **stale-while-revalidate**.
3. **Versionamento**: `CACHE = "abastece-certo-<versão>"` e apagar versões antigas no `activate` (já feito). **Armadilha atual no `sw.js` observado:** o `install` chama `self.skipWaiting()` **automaticamente** e o `activate` chama `clients.claim()`. Isso ativa a versão nova no meio de uma sessão antiga (mistura de versões). Para um app deste tamanho o risco é baixo, mas o padrão mais seguro é: **não** dar `skipWaiting()` automático; expor um botão "Nova versão disponível — atualizar" que envia `SKIP_WAITING` ao SW em espera (o `message` handler já existe) e recarrega no `controllerchange`.
4. **Nunca** cachear o próprio `sw.js` (já tratado: `if (url.pathname.indexOf("/sw.js") !== -1) return`).
5. **Pitfall clássico:** já houve deploy e o usuário está com `index.html` antigo em cache → o app mostra o limite velho (70/71) e não avisa. Com network-first, o HTML atualiza a cada abertura online; ainda assim, mostrar a versão/data do app na tela de "sobre/por que" ajuda o suporte.
6. **`file://`:** SW não registra; manter o guard `location.protocol !== "file:"`.

### 4.3 Acessibilidade prática para calculadora

**[FATO] `aria-live`** (MDN — <https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-live>): `polite` avisa sem interromper; `assertive` interrompe e pode limpar a fila de fala. Para o resultado que muda a cada tecla, usar `aria-live="polite"` (ou `role="status"`, que já implica polite) em um nó **que existe desde o carregamento** e cujo conteúdo é atualizado — não recriar o nó a cada render (senão o leitor de tela pode não anunciar). Se o texto todo for reescrito, usar `aria-atomic="true"` para ler o conjunto.
**[FATO] Abas** (MDN tab role — <https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/tab_role>): `tab` deve ser filho de `tablist`; `aria-selected="true"` na aba ativa; `aria-controls` apontando para o `tabpanel`; o painel com `role="tabpanel"` e `aria-labelledby` da aba. **[ESTIMATIVA/complemento]** o padrão APG (WAI-ARIA Authoring Practices) pede navegação por setas ←/→ e **um único** `tabindex="0"` no grupo (roving tabindex), com `Home`/`End`; painéis escondidos com `hidden` e sem foco quando inativos. O `index.html` em edição (observado em 17/10/2026) já usa `role=tablist/tab/tabpanel`, `aria-selected`, `aria-controls` e `aria-labelledby` — falta confirmar o teclado por setas e o foco.
**Demais itens práticos:**
- **Foco visível**: não remover `:focus`/`:focus-visible`; usar contorno de 2–3 px com contraste (o CSS atual usa `box-shadow` azul — verificar contraste no tema escuro).
- **Contraste**: WCAG 2.2 AA exige 4,5:1 para texto normal e 3:1 para texto grande/ícones. Verificar `--muted` (#8a97b0) sobre `--card` (#121a2e) — **[ESTIMATIVA]** provavelmente passa para texto normal, mas medir com ferramenta (ex.: axe DevTools/Edge).
- **`prefers-reduced-motion`** (MDN — <https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion>): desligar a transição do marcador do gauge e qualquer animação de "toast" quando o usuário pede menos movimento.
- **Inputs**: `inputmode="decimal"` (já usado), `autocomplete="off"`, `<label for>` (já usado), mensagem de erro em texto (não só cor), e não depender de placeholder como rótulo.
- **Resultado dinâmico**: além do `aria-live`, usar cor + texto + ícone (o veredito já tem texto; bom).
- **Alvos de toque** ≥ 44×44 px (botões de preset e abas no mobile).

### 4.4 Teste sem dependências com `node:vm` — confirmado

**[FATO]** Técnica validada nesta sessão: marcar o bloco puro no `index.html` com comentários (`// #region LOGICA` ... `// #endregion`), extrair por regex no Node e rodar em `node:vm` com um sandbox vazio. Resultado: **6/6 casos passaram** (vírgula/ponto decimal, milhar, médias ANP, índice 78%, empate em 70% e campo vazio).

Esqueleto que funcionou:
```js
// pesquisa.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html = readFileSync('index.html', 'utf8');
const m = html.match(/\/\/ #region LOGICA([\s\S]*?)\/\/ #endregion/);
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(m[1] + '\nthis.calc = calcDecision;', sandbox);
console.log(sandbox.calc('5,89', '3,99', 0.72));
```
**Condições para funcionar** (verificadas na prática): (1) o bloco não pode referenciar `document`, `window`, `localStorage`, `navigator` em tempo de carga; (2) tudo que o bloco usa (ex.: `Intl`, `Number`) deve existir no Node (existe); (3) se o app crescer, expor as funções do bloco como `var`/`function` no escopo do script (não dentro de IIFE que não exporta nada) ou publicar em um objeto (`window.AC`/`var AC`) — no `index.html` em edição há um módulo `var AC = (function(){...})()` que parece ser o alvo natural, mas ele ainda precisa estar livre de DOM para ser testável assim. **Não usei o `index.html` atual como prova** porque ele estava sendo editado por outro agente nesta sessão; a prova foi feita com um bloco autocontido equivalente.

---

## 5. Números para a UI

### 5.1 Preços (placeholders, validação e faixas)

**[FATO] Semana 04–10/10/2026 (ANP, médias nacionais):** gasolina comum **R$ 6,54**; aditivada **R$ 6,72**; etanol **R$ 4,14**.

**[FATO] Nível de posto, 1º semestre/2026 (CSV histórico da ANP; ~93–111 mil preços por produto):**

| Produto | mín | P1 | P5 | mediana | P95 | P99 | máx | média |
|---|---|---|---|---|---|---|---|---|
| Gasolina | 5,09 | 5,69 | 5,94 | 6,54 | 7,29 | 7,74 | 9,79 | 6,56 |
| Gasolina aditivada | 5,36 | 5,89 | 6,09 | 6,75 | 7,49 | 7,96 | 9,89 | 6,76 |
| Etanol | 2,89 | 3,49 | 3,79 | 4,69 | 5,59 | 5,99 | 6,99 | 4,71 |

(percentis por posto de rankeamento mais próximo; **[ESTIMATIVA]** para estimar a distribuição.)

**Sugestão para o app:**
- **Placeholders:** gasolina `6,54`, etanol `4,14` (com nota "médias ANP 04–10/10/2026") ou os preços que o usuário usou por último (o app já persiste).
- **Validação de sanidade:** aceitar `0,50–20,00`; **avisar** (não bloquear) fora de `4,50–9,50` para gasolina e `2,50–7,50` para etanol. Isso pega vírgula errada/valores absurdos sem impedir preço de rodovia/Amazônia.
- **Aviso de índice improvável:** se `etanol/gasolina < 0,50` ou `> 1,00`, mostrar "confira os preços" — fora das faixas observadas (mín. histórico ~0,55; estados 0,607–0,762 em out/2026).
- **Data dos dados** sempre visível quando preço vier de média embutida.

### 5.2 Consumo típico de carro flex (para pré-preencher o modo preciso)

**[FATO] PBEV/Inmetro 2026** (amostra publicada pela Vrum, 24/07/2026): os flex mais econômicos do país fazem, **com gasolina**, 13,7–14,6 km/L na cidade e 15,1–17,7 na estrada; **com etanol**, 9,9–10,8 na cidade e 10,9–12,9 na estrada. Modelos populares medianos ficam abaixo disso.

**Sugestões (ESTIMATIVA, para defaults e validação):**
| Perfil | Gasolina cidade | Gasolina estrada | Etanol cidade | Etanol estrada |
|---|---|---|---|---|
| Hatch 1.0 moderno (default) | 12,0 km/L | 15,0 km/L | 8,6 km/L | 10,9 km/L |
| Sedan/SUV 2.0 | 9,5 | 12,5 | 6,8 | 9,1 |
| Carro antigo (pré-2010) | 9,0 | 12,0 | 6,2 | 8,4 |
- Pré-preencher com o perfil "hatch 1.0" e deixar o usuário editar; validar `2–30 km/L`.
- Checar coerência: razão etanol/gasolina fora de `0,55–0,85` → avisar "consumos parecem inconsistentes".
- Lembrar no texto: a autonomia com gasolina E32 é ~1–1,5% menor que com E30 (AutoPapo/AUTOTEMPO), e os números do Inmetro foram medidos em condições de laboratório.

---

## 6. Riscos, divergências e o que não foi verificado

1. **[NÃO VERIFICADO]** Licença exata dos dados abertos da ANP (termo no `dados.gov.br`).
2. **[NÃO VERIFICADO]** PCI/L oficial do etanol hidratado (tabela do Anuário ANP em PDF não extraível nesta sessão); valores usados são faixa técnica.
3. **[NÃO VERIFICADO]** Existência de API JSON interna dos painéis da ANP com CORS.
4. **[DIVERGÊNCIA]** Limite da E32: 71,3% (conta de energia), "71%" (AEA para E30) e "73–75%" (AUTOTEMPO para E32 em motores modernos). Não há número oficial. Adotar 72% como default e explicar a faixa é a postura defensável.
5. **[RISCO]** O E32 é temporário (180 dias, prorrogável) e há pressão política contra. O app deve exibir a data de referência do limite e permitir ajuste; não "cravar" 72% para sempre.
6. **[RISCO]** Preço médio embutido fica velho. Se adotar a opção de GitHub Action, mostrar a data da última atualização e falhar de forma silenciosa (manter o valor antigo) se a Action quebrar.
7. **[RISCO]** O `sw.js` com `skipWaiting()` automático pode servir HTML novo com CSS/JS em cache antigo (ou vice-versa) durante a transição; para este app o impacto é baixo, mas o padrão recomendado é atualização sob confirmação.
8. **[OBSERVAÇÃO]** Durante esta pesquisa, `index.html`/`sw.js` estavam sendo modificados por outro agente (v2 em andamento). Este documento descreve fatos de fontes externas e não foi escrito para o estado momentâneo do código; não editei nenhum arquivo de produção.

---

## 7. Fontes (todas acessadas em 17/10/2026)

**Mistura, legislação e regra dos 70%**
- ANP — "E32: gasolina com 32% de etanol passa a valer ... a partir de amanhã (1/8)": <https://www.gov.br/anp/pt-br/canais_atendimento/imprensa/noticias-comunicados/e32-gasolina-com-32-de-etanol-passa-a-valer-temporariamente-a-partir-de-amanha-1-8> (HTTP 200; cita Resolução CNPE nº 9/2026)
- MME/CNPE — "CNPE aprova elevação do teor de etanol anidro na gasolina para 32%": <https://www.gov.br/mme/pt-br/assuntos/conselhos-e-comites/cnpe/comunicacoes/cnpe-aprova-elevacao-do-teor-de-etanol-anidro-na-gasolina-para-32> (HTTP 200)
- Agência Gov — "Gasolina com 32% de etanol vale desde sábado (1º)": <https://agenciagov.ebc.com.br/noticias/202607/resolucao-que-institui-o-e32-e-publicada-e-nova-mistura-passa-a-valer-neste-sabado> (HTTP 200)
- AutoPapo — "Gasolina com 35% de etanol entra em testes" (21/09/2026): <https://autopapo.com.br/curta/gasolina-com-35-de-etanol-entra-em-testes-entenda-o-que-muda-no-seu-carro/> (HTTP 200)
- Minaspetro/Estadão — "Etanol ou gasolina? ... regra dos 70% pode fazer você perder dinheiro" (24/02/2026): <https://minaspetro.com.br/etanol-ou-gasolina-entenda-como-a-regra-dos-70-pode-fazer-voce-perder-dinheiro/> (HTTP 200)
- Minaspetro/AUTOTEMPO — "Gasolina E32: aprenda a calcular se o etanol vale mais a pena" (04/08/2026): <https://minaspetro.com.br/gasolina-e32-aprenda-a-calcular-se-o-etanol-vale-mais-a-pena/> (HTTP 200)
- Combustíveis ANP (site de terceiro) — "A regra dos 70% explicada" (atualizado 03/09/2026): <https://www.combustiveis-anp.com.br/guia/regra-dos-70> (HTTP 200)
- Combustíveis ANP — "Por que a gasolina premium ficou fora da regra dos 32%" (atualizado 01/10/2026): <https://www.combustiveis-anp.com.br/guia/gasolina-premium-fora-da-regra-dos-32-de-etanol> (HTTP 200)
- AutoPapo/Boris Feldman — "A nova gasolina alterou a conta dos 70%?" (12/08/2020): <https://autopapo.com.br/blog-do-boris/nova-gasolina-cauculo-70/> (HTTP 200)

**Física / energia**
- Engineering ToolBox — Higher Calorific Values of Common Fuels: <https://www.engineeringtoolbox.com/fuels-higher-calorific-values-d_169.html> (HTTP 200)
- ANP — Anuário Estatístico 2026, "Convention Factors, Densities and Lower Calorific Values" (PDF; não extraído): <https://www.gov.br/anp/pt-br/centrais-de-conteudo/publicacoes/anuario-estatistico/arquivos-yearbook-2026/others-documentary-parts/convertion-factors-2026.pdf>
- Vrum — "Os 5 carros flex mais econômicos do Brasil em 2026" (PBEV/Inmetro, 24/07/2026): <https://www.vrum.com.br/bom-negocio/2026/07/7467386-os-5-carros-flex-mais-economicos-do-brasil-em-2026.html> (HTTP 200)

**Dados abertos ANP**
- LPC — últimas semanas pesquisadas: <https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/levantamento-de-precos-de-combustiveis-ultimas-semanas-pesquisadas> (HTTP 200; CORS ausente)
- Exemplo `resumo_semanal_lpc_2026-10-04_2026-10-10.xlsx` (297.219 bytes; CORS ausente): <https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/arquivos-lpc/2026/resumo_semanal_lpc_2026-10-04_2026-10-10.xlsx>
- Série Histórica de Preços: <https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/serie-historica-de-precos-de-combustiveis> (HTTP 200)
- `ca-2026-01.zip` (8.488.624 bytes; CSV interno de 72,1 MB; CORS ausente): <https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/arquivos/shpc/dsas/ca/ca-2026-01.zip>
- Metadados (PDF, 191.035 bytes; CORS ausente): <https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/arquivos/shpc/metadados-serie-historica-precos-combustiveis-1.pdf>

**GitHub**
- <https://github.com/TallesDiniz/Calculadora-Gasolina-x-Etanol>
- <https://github.com/carvalhoFilip/alcool-gasolina>
- <https://github.com/Rudyzinho/alcool-ou-gasolina-estendido>
- <https://github.com/AlexandreZanata/brazil-fuel-prices-app> e <https://github.com/AlexandreZanata/abastevo> (wiki de fontes de dados: <https://raw.githubusercontent.com/wiki/AlexandreZanata/abastevo/docs-data-sources.md>)
- <https://github.com/VictorrCabral/precos-combustivel-api> (API **não publicada**)

**PWA / acessibilidade**
- MDN — Making PWAs installable: <https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable>
- MDN — Manifest `icons`: <https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/icons>
- MDN — Manifest `screenshots`: <https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/screenshots>
- MDN — `aria-live`: <https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-live>
- MDN — `tab` role: <https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/tab_role>
- MDN — `prefers-reduced-motion`: <https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion>
- web.dev — What does it take to be installable: <https://web.dev/articles/install-criteria>
- web.dev — The service worker lifecycle: <https://web.dev/articles/service-worker-lifecycle>
- web.dev — Offline cookbook: <https://web.dev/articles/offline-cookbook>
- Chrome for Developers — Installable manifest audit: <https://developer.chrome.com/docs/lighthouse/pwa/installable-manifest>
- web.dev — Maskable icons: <https://web.dev/articles/maskable-icon>

**Bibliotecas (medição de tamanho)**
- unpkg/jsDelivr: `alpinejs@3.14.9`, `preact@10.26.4`, `htm@3.1.1`, `lit@3.3.1`, `chart.js@4.4.9`, `uplot@1.6.32`, `workbox-window@7.3.0`, `just-validate@4.3.0` — tamanhos brutos/gzip medidos localmente em 17/10/2026.

---

## 2.4 APIs candidatas para a próxima etapa (atualização 17/10/2026)

Complemento ao §2.1–2.2, depois da v4.2. Status: **não integradas** — só candidatas, verificadas por
pesquisa rápida; os termos e limites de uso precisam ser confirmados antes de produção.

| API | O que dá | Custo | Observação |
|---|---|---|---|
| [IBGE — Localidades](https://servicodados.ibge.gov.br/api/v1/localidades/estados/SP/municipios) | lista oficial de municípios por UF (JSON) | grátis | ótima para o seletor de **cidade**; pode ser consumida em runtime ou no build |
| [Overpass API](https://overpass-api.de/) (OpenStreetMap) | postos `amenity=fuel` perto de lat/lon | grátis | exige geolocalização, respeitar rate limit; bom para "postos próximos" sem Google |
| [Apify — ANP Preços Combustíveis](https://apify.com/latinamericadata/anp-precos-combustiveis-brasil/api) | preços/scraping da ANP | pago | chave, custo e dependência de terceiro; **não recomendado** para app estático sem backend |

**Conclusão:** continua valendo o §2.2 — para *preços*, o caminho sem backend é o XLSX semanal → `precos.json`
na mesma origem (já implementado). Para *cidades*, a API do IBGE resolve. Para *preços por posto em tempo
real / mapa / sincronização*, só com backend ou dados comunitários.

### 2.5 Atualização v4.3: dados municipais (implementado)

- A aba `MUNICIPIOS` do `resumo_semanal_lpc_*.xlsx` foi integrada ao `precos.json` (gasolina comum e
  etanol por cidade). A amostra semanal tem **394 municípios** (387 com os dois produtos) em 27 UFs;
  o JSON ficou com **~25 KB** (antes ~2,5 KB) — continua tranquilo para precache do PWA.
- A ANP escreve os nomes em CAIXA ALTA e sem acento; o script consulta a API de Localidades do IBGE
  para recuperar a grafia correta (`SAO PAULO` → `São Paulo`). **Pitfall:** o IBGE responde **HTTP 400**
  para User-Agent de script; é preciso enviar um UA de navegador.
- Limitação honesta: a amostra municipal semanal **não cobre todas as cidades** do país (só as
  pesquisadas naquela semana). O seletor mostra apenas as cidades presentes no JSON; senão, vale a média
  do estado.


