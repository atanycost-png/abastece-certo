#!/usr/bin/env node
/**
 * Testes de `tools/update-prices.mjs` e do `precos.json` gerado.
 *
 * Roda com zero dependências: `node tools/test-prices.mjs`.
 * Cobre os helpers puros (ZIP, XML/shared strings, normalizações, parse pt-BR,
 * datas, escolha do link, montagem/validação do JSON) com fixtures pequenas
 * construídas em memória e, no fim, valida o `precos.json` real do repositório.
 *
 * Saída: uma linha `ok <n> — <nome>` por teste; `FAIL <n> — <nome>` com o
 * detalhe em seguida. Exit code 0 se tudo passar, 1 se algo falhar.
 */

import { existsSync, readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FAIXAS,
  PAGINA_LPC,
  PRODUTOS,
  abrirZip,
  arredondar2,
  dataValidaISO,
  diaDaSemana,
  escolherLinkDaSemana,
  escolherLinkMaisRecente,
  estadoParaUF,
  executadoDiretamente,
  extrairPrecosDoArquivo,
  extrairSemanaDoNome,
  listarLinksResumoSemanal,
  mesmosDados,
  montarPrecos,
  normalizarProduto,
  normalizarSemana,
  normalizarTexto,
  parseNumeroPtBr,
  parsearArgumentos,
  parsearLinhasPlanilha,
  parsearSharedStrings,
  parseDataCelula,
  resolverAbas,
  resumirDiferenca,
  serialExcelParaISOData,
  urlCanonicaDaSemana,
  validarPrecos,
} from './update-prices.mjs';

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)));
const CAMINHO_PRECOS = join(RAIZ, 'precos.json');

// ---------------------------------------------------------------------------
// Harness mínimo
// ---------------------------------------------------------------------------

let total = 0;
let falhas = 0;

function ok(nome, condicao, detalhe = '') {
  total += 1;
  if (condicao) {
    console.log(`ok ${total} — ${nome}`);
  } else {
    falhas += 1;
    console.log(`FAIL ${total} — ${nome}${detalhe ? `\n       ${detalhe}` : ''}`);
  }
}

function igual(nome, atual, esperado) {
  const mesmo = JSON.stringify(atual) === JSON.stringify(esperado);
  ok(nome, mesmo, `esperado: ${JSON.stringify(esperado)}\n       recebido: ${JSON.stringify(atual)}`);
}

function lanca(nome, funcao, trechoEsperado) {
  try {
    funcao();
    ok(nome, false, 'esperava uma exceção, mas nada foi lançado');
  } catch (erro) {
    const mensagem = String(erro?.message ?? erro);
    const contem = trechoEsperado ? mensagem.includes(trechoEsperado) : true;
    ok(nome, contem, `mensagem inesperada: ${mensagem}`);
  }
}

function clone(valor) {
  return JSON.parse(JSON.stringify(valor));
}

// ---------------------------------------------------------------------------
// Fixtures: ZIP em memória (store + deflate)
// ---------------------------------------------------------------------------

const TABELA_CRC32 = (() => {
  const tabela = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabela[n] = c >>> 0;
  }
  return tabela;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = TABELA_CRC32[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Monta um ZIP válido em memória: `[{ nome, conteudo, comprimir }]`. */
function montarZip(entradas) {
  const partesLocais = [];
  const centrais = [];
  let deslocamento = 0;
  for (const entrada of entradas) {
    const dados = Buffer.isBuffer(entrada.conteudo) ? entrada.conteudo : Buffer.from(String(entrada.conteudo), 'utf8');
    const comprimido = entrada.comprimir ? deflateRawSync(dados) : dados;
    const metodo = entrada.comprimir ? 8 : 0;
    const nome = Buffer.from(entrada.nome, 'utf8');
    const crc = crc32(dados);

    const local = Buffer.alloc(30 + nome.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(metodo, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(dados.length, 22);
    local.writeUInt16LE(nome.length, 26);
    local.writeUInt16LE(0, 28);
    nome.copy(local, 30);

    const central = Buffer.alloc(46 + nome.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(metodo, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comprimido.length, 20);
    central.writeUInt32LE(dados.length, 24);
    central.writeUInt16LE(nome.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(deslocamento, 42);
    nome.copy(central, 46);

    partesLocais.push(local, comprimido);
    centrais.push(central);
    deslocamento += local.length + comprimido.length;
  }
  const diretorio = Buffer.concat(centrais);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt32LE(diretorio.length, 12);
  eocd.writeUInt32LE(deslocamento, 16);
  eocd.writeUInt16LE(entradas.length, 8);
  eocd.writeUInt16LE(entradas.length, 10);
  return Buffer.concat([...partesLocais, diretorio, eocd]);
}

// ---------------------------------------------------------------------------
// Fixtures: XLSX sintético (mesmo formato do arquivo da ANP)
// ---------------------------------------------------------------------------

const TEXTOS = [
  'DATA INICIAL', // 0
  'DATA FINAL', // 1
  'REGIAO', // 2
  'ESTADOS', // 3
  'PRODUTO', // 4
  'NÚMERO DE POSTOS PESQUISADOS', // 5
  'UNIDADE DE MEDIDA', // 6
  'PREÇO MÉDIO REVENDA', // 7
  'PREÇO MÍNIMO REVENDA', // 8
  'PREÇO MÁXIMO REVENDA', // 9
  'DESVIO PADRÃO REVENDA', // 10
  'COEF DE VARIAÇÃO REVENDA', // 11
  'GASOLINA COMUM', // 12
  'GASOLINA ADITIVADA', // 13
  'ETANOL HIDRATADO', // 14
  'SÃO PAULO', // 15
  'RIO GRANDE DO NORTE', // 16
  'SUDESTE', // 17
  'NORDESTE', // 18
  'OLEO DIESEL', // 19
  'BRASIL', // 20
];

function escaparXml(texto) {
  return String(texto).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function xmlSharedStrings() {
  const itens = TEXTOS.map((texto) => `<si><t>${escaparXml(texto)}</t></si>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${itens}</sst>`;
}

function celulaS(coluna, linha, indice) {
  return `<c r="${coluna}${linha}" t="s"><v>${indice}</v></c>`;
}

function celulaN(coluna, linha, valor) {
  return `<c r="${coluna}${linha}"><v>${valor}</v></c>`;
}

function celulaInline(coluna, linha, texto) {
  return `<c r="${coluna}${linha}" t="inlineStr"><is><t>${escaparXml(texto)}</t></is></c>`;
}

function linhaXml(numero, celulas) {
  return `<row r="${numero}">${celulas.join('')}</row>`;
}

function xmlPlanilha(linhas) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${linhas.join('')}</sheetData></worksheet>`;
}

function xmlAbaEstados() {
  const cabecalho = linhaXml(10, [
    celulaS('A', 10, 0),
    celulaS('B', 10, 1),
    celulaS('C', 10, 2),
    celulaS('D', 10, 3),
    celulaS('E', 10, 4),
    celulaS('F', 10, 5),
    celulaS('G', 10, 6),
    celulaS('H', 10, 7),
    celulaS('I', 10, 10),
    celulaS('J', 10, 8),
    celulaS('K', 10, 9),
    celulaS('L', 10, 11),
  ]);
  const linhas = [
    cabecalho,
    // SP: etanol antes da comum, de propósito — a saída deve ser canônica
    linhaXml(11, [celulaN('A', 11, 46299), celulaN('B', 11, 46305), celulaS('C', 11, 17), celulaS('D', 11, 15), celulaS('E', 11, 14), celulaN('F', 11, 1247), celulaS('G', 11, 6), celulaN('H', 11, 3.86)]),
    linhaXml(12, [celulaN('A', 12, 46299), celulaN('B', 12, 46305), celulaS('C', 12, 17), celulaS('D', 12, 15), celulaS('E', 12, 13), celulaN('F', 12, 950), celulaS('G', 12, 6), celulaN('H', 12, 6.67)]),
    linhaXml(13, [celulaN('A', 13, 46299), celulaN('B', 13, 46305), celulaS('C', 13, 17), celulaS('D', 13, 15), celulaS('E', 13, 12), celulaN('F', 13, 1253), celulaS('G', 13, 6), celulaN('H', 13, 6.36)]),
    // RN: comum antes do etanol
    linhaXml(14, [celulaN('A', 14, 46299), celulaN('B', 14, 46305), celulaS('C', 14, 18), celulaS('D', 14, 16), celulaS('E', 14, 12), celulaN('F', 14, 210), celulaS('G', 14, 6), celulaN('H', 14, 6.6)]),
    linhaXml(15, [celulaN('A', 15, 46299), celulaN('B', 15, 46305), celulaS('C', 15, 18), celulaS('D', 15, 16), celulaS('E', 15, 14), celulaN('F', 15, 180), celulaS('G', 15, 6), celulaN('H', 15, 5.03)]),
    // linha 16: auto-fechada (linha vazia) — não pode engolir as seguintes
    '<row r="16"/>',
    // linha 17: produto fora do interesse (diesel) — ignorada
    linhaXml(17, [celulaN('A', 17, 46299), celulaN('B', 17, 46305), celulaS('C', 17, 17), celulaS('D', 17, 15), celulaS('E', 17, 19), celulaN('F', 17, 300), celulaS('G', 17, 6), celulaN('H', 17, 6.98)]),
  ];
  return xmlPlanilha(linhas);
}

function xmlAbaBrasil() {
  const cabecalho = linhaXml(10, [
    celulaS('A', 10, 0),
    celulaS('B', 10, 1),
    celulaS('C', 10, 20),
    celulaS('D', 10, 4),
    celulaS('E', 10, 5),
    celulaS('F', 10, 6),
    celulaS('G', 10, 7),
    celulaS('H', 10, 10),
    celulaS('I', 10, 8),
    celulaS('J', 10, 9),
    celulaS('K', 10, 11),
  ]);
  const linhas = [
    cabecalho,
    // etanol: valor com artefato de ponto flutuante, como no arquivo real
    linhaXml(11, [celulaN('A', 11, 46299), celulaN('B', 11, 46305), celulaS('C', 11, 20), celulaS('D', 11, 14), celulaN('E', 11, 3833), celulaS('F', 11, 6), celulaN('G', 11, '4.1399999999999997'), celulaN('H', 11, 0.556), celulaN('I', 11, 3.09), celulaN('J', 11, 6.59), celulaN('K', 11, 0.134)]),
    // aditivada: string inline com vírgula decimal pt-BR (caminho alternativo)
    linhaXml(12, [celulaN('A', 12, 46299), celulaN('B', 12, 46305), celulaS('C', 12, 20), celulaS('D', 12, 13), celulaN('E', 12, 3443), celulaS('F', 12, 6), celulaInline('G', 12, '6,72'), celulaN('I', 12, 5.59), celulaN('J', 12, 8.99)]),
    // comum
    linhaXml(13, [celulaN('A', 13, 46299), celulaN('B', 13, 46305), celulaS('C', 13, 20), celulaS('D', 13, 12), celulaN('E', 13, 4474), celulaS('F', 13, 6), celulaN('G', 13, 6.54), celulaN('I', 13, 5.39), celulaN('J', 13, 8.99)]),
    // diesel: não pode entrar no JSON
    linhaXml(14, [celulaN('A', 14, 46299), celulaN('B', 14, 46305), celulaS('C', 14, 20), celulaS('D', 14, 19), celulaN('E', 14, 1234), celulaS('F', 14, 6), celulaN('G', 14, 6.98), celulaN('I', 14, 5), celulaN('J', 14, 9.9)]),
  ];
  return xmlPlanilha(linhas);
}

function montarXlsxSintetico({ comWorkbook = true } = {}) {
  const entradas = [
    { nome: 'xl/sharedStrings.xml', conteudo: xmlSharedStrings(), comprimir: true },
    { nome: 'xl/worksheets/sheet1.xml', conteudo: xmlAbaEstados(), comprimir: true },
    { nome: 'xl/worksheets/sheet2.xml', conteudo: xmlAbaBrasil(), comprimir: false },
  ];
  if (comWorkbook) {
    entradas.push({
      nome: 'xl/workbook.xml',
      conteudo:
        '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="ESTADOS" sheetId="1" r:id="rId1"/><sheet name="BRASIL" sheetId="2" r:id="rId2"/></sheets></workbook>',
      comprimir: true,
    });
    entradas.push({
      nome: 'xl/_rels/workbook.xml.rels',
      conteudo:
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
      comprimir: true,
    });
  }
  return montarZip(entradas);
}

const BRASIL_ESPERADO = {
  gasolinaComum: { media: 6.54, min: 5.39, max: 8.99, postos: 4474 },
  gasolinaAditivada: { media: 6.72, min: 5.59, max: 8.99, postos: 3443 },
  etanol: { media: 4.14, min: 3.09, max: 6.59, postos: 3833 },
};

const ESTADOS_ESPERADOS = {
  RN: { gasolinaComum: 6.6, etanol: 5.03 },
  SP: { gasolinaComum: 6.36, etanol: 3.86 },
};

// ---------------------------------------------------------------------------
// Fixtures: página HTML e precos.json sintético
// ---------------------------------------------------------------------------

const HTML_PAGINA = `
<html><body>
  <a href="https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/arquivos-lpc/2024/resumo_semanal_lpc_2024-12-29_2025-01-04.xlsx">2024</a>
  <a href="https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/arquivos-lpc/2026/resumo_semanal_lpc_2026-09-27_2026-10-03.xlsx">03/10</a>
  <a href="/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/arquivos-lpc/2026/resumo_semanal_lpc_2026-10-04_2026-10-10.xlsx">10/10</a>
  <a href="resumo_semanal_lpc_2026-08-30-2026-09-5.xlsx">30/08 (nome antigo, dia sem zero)</a>
  <a href="https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/arquivos-lpc/2026/revendas_lpc_2026-10-04_2026-10-10.xlsx">postos</a>
  <a href="https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/arquivos-lpc/2026/resumo_semanal_lpc_2026-10-04_2026-10-10.xlsx">duplicado</a>
</body></html>`;

function precosDemo(sobrescrever = {}) {
  const estados = {};
  for (const uf of [
    'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA',
    'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO',
  ]) {
    estados[uf] = { gasolinaComum: 6.5, etanol: 4.1 };
  }
  return {
    fonte: 'ANP — Levantamento de Preços de Combustíveis',
    url: 'https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/arquivos-lpc/2026/resumo_semanal_lpc_2026-10-04_2026-10-10.xlsx',
    semana: { inicio: '2026-10-04', fim: '2026-10-10' },
    atualizadoEm: '2026-10-17T14:00:00.000Z',
    brasil: clone(BRASIL_ESPERADO),
    estados,
    ...sobrescrever,
  };
}

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

// 1-3: ZIP
{
  const zip = montarZip([
    { nome: 'a.txt', conteudo: 'olá, mundo' },
    { nome: 'pasta/b.xml', conteudo: '<x>1</x>', comprimir: true },
  ]);
  const aberto = abrirZip(zip);
  igual('ZIP: nomes das entradas', aberto.nomes, ['a.txt', 'pasta/b.xml']);
  ok('ZIP: método store (0)', aberto.ler('a.txt')?.toString('utf8') === 'olá, mundo');
  ok('ZIP: método deflate (8)', aberto.ler('pasta/b.xml')?.toString('utf8') === '<x>1</x>');
  ok('ZIP: entrada inexistente devolve null', aberto.ler('nao-existe') === null);
}
lanca('ZIP: buffer curto é rejeitado', () => abrirZip(Buffer.from('PK')), 'menor que o mínimo');
lanca('ZIP: assinatura inválida é rejeitada', () => abrirZip(Buffer.alloc(64)), 'EOCD');

// 4-5: shared strings e células
igual(
  'XML: sharedStrings com texto rico e entidades',
  parsearSharedStrings(
    '<sst><si><t>PREÇO MÉDIO REVENDA</t></si><si><r><t>RIO GRANDE </t></r><r><t>DO NORTE</t></r></si><si><t xml:space="preserve"> A &amp; B </t></si><si/></sst>',
  ),
  ['PREÇO MÉDIO REVENDA', 'RIO GRANDE DO NORTE', ' A & B ', ''],
);
{
  const linhas = parsearLinhasPlanilha(
    xmlPlanilha([
      linhaXml(1, [
        celulaS('A', 1, 0),
        celulaInline('B', 1, 'texto inline'),
        celulaN('C', 1, 6.54),
        '<c r="D1" s="2"/>',
      ]),
      '<row r="2"/>',
    ]),
    ['GASOLINA COMUM'],
  );
  igual('XML: linhas/células (shared, inline, número, vazia, auto-fechada)', linhas.length, 2);
  igual('XML: célula shared string resolvida', linhas[0].celulas.get('A').valor, 'GASOLINA COMUM');
  igual('XML: célula inlineStr', linhas[0].celulas.get('B').valor, 'texto inline');
  igual('XML: célula numérica fica como texto', linhas[0].celulas.get('C').valor, '6.54');
  ok('XML: célula auto-fechada existe sem valor', linhas[0].celulas.has('D') && linhas[0].celulas.get('D').valor === null);
  igual('XML: linha auto-fechada não engole as seguintes', linhas[1].numero, 2);
}

// 6-8: normalizações e números
igual('normalizarTexto tira acento/caixa/espaço', normalizarTexto('  Preço   MÉDIO  Revenda '), 'PRECO MEDIO REVENDA');
igual('normalizarProduto: gasolina comum', normalizarProduto('Gasolina  Comum'), 'gasolinaComum');
igual('normalizarProduto: aditivada tem prioridade', normalizarProduto('GASOLINA ADITIVADA'), 'gasolinaAditivada');
igual('normalizarProduto: etanol hidratado', normalizarProduto('Etanol Hidratado'), 'etanol');
igual('normalizarProduto: diesel é ignorado', normalizarProduto('ÓLEO DIESEL S10'), null);
igual('normalizarProduto: GNV é ignorado', normalizarProduto('GNV'), null);
igual('parseNumeroPtBr: vírgula decimal', parseNumeroPtBr('6,54'), 6.54);
igual('parseNumeroPtBr: milhar com ponto', parseNumeroPtBr('4.474'), 4474);
igual('parseNumeroPtBr: milhar + decimal', parseNumeroPtBr('1.234,56'), 1234.56);
igual('parseNumeroPtBr: ponto decimal do XLSX', parseNumeroPtBr('4.1399999999999997'), 4.1399999999999997);
igual('parseNumeroPtBr: com R$', parseNumeroPtBr('R$ 6,54'), 6.54);
igual('parseNumeroPtBr: inteiro', parseNumeroPtBr('46299'), 46299);
igual('parseNumeroPtBr: notação científica', parseNumeroPtBr('6.2E-2'), 0.062);
igual('parseNumeroPtBr: texto inválido', parseNumeroPtBr('abc'), null);
igual('parseNumeroPtBr: vazio', parseNumeroPtBr(''), null);
igual('arredondar2 corrige artefato de float', arredondar2(4.1399999999999997), 4.14);

// 9-11: estados e datas
igual('estadoParaUF: nome completo', estadoParaUF('São Paulo'), 'SP');
igual('estadoParaUF: sigla', estadoParaUF('sp'), 'SP');
igual('estadoParaUF: desconhecido', estadoParaUF('Atlântida'), null);
igual('serialExcelParaISOData: 46299', serialExcelParaISOData(46299), '2026-10-04');
igual('serialExcelParaISOData: 46305', serialExcelParaISOData(46305), '2026-10-10');
igual('parseDataCelula: dd/mm/aaaa', parseDataCelula('04/10/2026'), '2026-10-04');
igual('parseDataCelula: ISO com tempo', parseDataCelula('2026-10-04T00:00:00Z'), '2026-10-04');
igual('parseDataCelula: inválida', parseDataCelula('31/02/2026'), null);
igual('extrairSemanaDoNome: nome normal', extrairSemanaDoNome('resumo_semanal_lpc_2026-10-04_2026-10-10.xlsx'), {
  inicio: '2026-10-04',
  fim: '2026-10-10',
});
igual('extrairSemanaDoNome: dia sem zero e separador "-"', extrairSemanaDoNome('resumo_semanal_lpc_2026-08-30-2026-09-5.xlsx'), {
  inicio: '2026-08-30',
  fim: '2026-09-05',
});
igual('extrairSemanaDoNome: nome fora do padrão', extrairSemanaDoNome('revendas_lpc_2026-10-04_2026-10-10.xlsx'), null);
igual('normalizarSemana: 7 dias', normalizarSemana('2026-10-04_2026-10-10').chave, '2026-10-04_2026-10-10');
igual('urlCanonicaDaSemana', urlCanonicaDaSemana('2026-10-04_2026-10-10'), 'https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/arquivos-lpc/2026/resumo_semanal_lpc_2026-10-04_2026-10-10.xlsx');
lanca('normalizarSemana: 6 dias é rejeitado', () => normalizarSemana('2026-10-04_2026-10-09'), '7 dias');
lanca('normalizarSemana: data inexistente', () => normalizarSemana('2026-02-30_2026-03-07'), 'datas reais');
lanca('normalizarSemana: formato errado', () => normalizarSemana('04/10/2026'), 'semana inválida');

// 12-14: página da ANP
{
  const links = listarLinksResumoSemanal(HTML_PAGINA);
  ok('página: só links de resumo semanal (ignora revendas)', links.every((l) => l.arquivo.includes('resumo_semanal_lpc')));
  ok('página: link duplicado é deduplicado por URL', links.length === 4, `links: ${links.length}`);
  const maisRecente = escolherLinkMaisRecente(HTML_PAGINA);
  igual('página: escolhe a semana mais recente', maisRecente.semana, { inicio: '2026-10-04', fim: '2026-10-10' });
  ok('página: resolve href relativo/absoluto para URL', maisRecente.url.startsWith(PAGINA_LPC.replace(/[^/]+$/, '')) || maisRecente.url.startsWith('https://www.gov.br/'));
  igual(
    'página: filtra por semana pedida',
    escolherLinkDaSemana(HTML_PAGINA, '2026-09-27_2026-10-03')?.semana,
    { inicio: '2026-09-27', fim: '2026-10-03' },
  );
  igual('página: semana ausente devolve null', escolherLinkDaSemana(HTML_PAGINA, '2020-01-05_2020-01-11'), null);
}
lanca('página: HTML vazio é rejeitado', () => listarLinksResumoSemanal(''), 'vazio');

// 15-18: leitura do XLSX (integração sem rede)
{
  const xlsx = montarXlsxSintetico();
  const zip = abrirZip(xlsx);
  const abas = resolverAbas(zip);
  ok('XLSX: abas resolvidas por workbook.xml/rels', abas?.get('BRASIL') === 'xl/worksheets/sheet2.xml' && abas?.get('ESTADOS') === 'xl/worksheets/sheet1.xml');

  const extraido = extrairPrecosDoArquivo(xlsx);
  igual('XLSX: bloco brasil com 3 produtos e valores', extraido.brasil, BRASIL_ESPERADO);
  igual('XLSX: bloco estados (só comum e etanol)', extraido.estados, ESTADOS_ESPERADOS);
  igual('XLSX: semana obtida das células de data', extraido.semana.chave, '2026-10-04_2026-10-10');
  ok('XLSX: nenhum aviso na fixture limpa', extraido.avisos.length === 0, JSON.stringify(extraido.avisos));

  const semWorkbook = extrairPrecosDoArquivo(montarXlsxSintetico({ comWorkbook: false }));
  igual('XLSX: fallback sem workbook.xml acha as abas pelo cabeçalho', semWorkbook.brasil, BRASIL_ESPERADO);
}
lanca('XLSX: buffer não-ZIP é rejeitado', () => extrairPrecosDoArquivo(Buffer.from('não é xlsx')), 'ZIP');

// 19-24: montagem e validação
{
  const extraido = extrairPrecosDoArquivo(montarXlsxSintetico());
  const montado = montarPrecos({
    url: 'https://exemplo/anp/resumo_semanal_lpc_2026-10-04_2026-10-10.xlsx',
    semana: extraido.semana,
    brasil: extraido.brasil,
    estados: extraido.estados,
    atualizadoEm: '2026-10-17T14:00:00.000Z',
  });
  igual('montarPrecos: ordem dos produtos no JSON', Object.keys(montado.brasil), ['gasolinaComum', 'gasolinaAditivada', 'etanol']);
  igual('montarPrecos: semana como objeto início/fim', montado.semana, { inicio: '2026-10-04', fim: '2026-10-10' });
  igual('montarPrecos: atualizadoEm normalizado em ISO', montado.atualizadoEm, '2026-10-17T14:00:00.000Z');
  igual('montarPrecos: estados ordenados por UF', Object.keys(montado.estados), ['RN', 'SP']);
  ok('montarPrecos: estados com chaves canônicas', JSON.stringify(montado.estados.SP) === JSON.stringify({ gasolinaComum: 6.36, etanol: 3.86 }));

  const invalidoPorPoucasUfs = validarPrecos(montado);
  ok(
    'validarPrecos: rejeita extração parcial (poucas UFs)',
    !invalidoPorPoucasUfs.ok && invalidoPorPoucasUfs.erros.some((erro) => erro.includes('extração parcial')),
    JSON.stringify(invalidoPorPoucasUfs.erros),
  );

  const valido = validarPrecos(precosDemo());
  ok('validarPrecos: aceita o objeto completo', valido.ok, JSON.stringify(valido.erros));

  const casosInvalidos = [
    ['produto ausente', { brasil: { gasolinaComum: BRASIL_ESPERADO.gasolinaComum, gasolinaAditivada: BRASIL_ESPERADO.gasolinaAditivada } }, 'etanol'],
    ['média fora da faixa', { brasil: { ...clone(BRASIL_ESPERADO), etanol: { media: 15, min: 3, max: 9, postos: 10 } } }, 'faixa plausível'],
    ['min > média', { brasil: { ...clone(BRASIL_ESPERADO), gasolinaComum: { media: 6.54, min: 8, max: 8.99, postos: 10 } } }, 'min <= media'],
    ['postos inválido', { brasil: { ...clone(BRASIL_ESPERADO), gasolinaComum: { media: 6.54, min: 5.39, max: 8.99, postos: 0 } } }, 'postos'],
    ['semana de 6 dias', { semana: { inicio: '2026-10-04', fim: '2026-10-09' } }, '7 dias'],
    ['estados vazios', { estados: {} }, 'vazio'],
    ['estado inválido', { estados: { ...precosDemo().estados, XP: { gasolinaComum: 6.5 } } }, 'XP'],
    ['url não http', { url: 'ftp://exemplo/arq.xlsx' }, 'http'],
    ['atualizadoEm inválido', { atualizadoEm: 'ontem' }, 'atualizadoEm'],
  ];
  for (const [rotulo, sobrescrever, trecho] of casosInvalidos) {
    const resultado = validarPrecos(precosDemo(sobrescrever));
    ok(
      `validarPrecos: rejeita ${rotulo}`,
      !resultado.ok && resultado.erros.some((erro) => erro.includes(trecho)),
      JSON.stringify(resultado.erros),
    );
  }
}

// 25-27: diferença resumida e argumentos
{
  const antes = precosDemo({ brasil: { ...clone(BRASIL_ESPERADO), gasolinaComum: { media: 6.52, min: 5.37, max: 8.99, postos: 4470 } } });
  const linhas = resumirDiferenca(antes, precosDemo());
  ok('resumirDiferenca: mostra gasolina 6,52 → 6,54 (+0,02)', linhas.includes('Gasolina comum: 6,52 → 6,54 (+0,02)'), linhas.join(' | '));
  ok('resumirDiferenca: destaca valores iguais', resumirDiferenca(precosDemo(), precosDemo()).some((linha) => linha.includes('(igual)')));
  ok('resumirDiferenca: sem JSON anterior', resumirDiferenca(null, precosDemo())[0].includes('não havia'));
  ok(
    'mesmosDados: ignora apenas atualizadoEm',
    mesmosDados(precosDemo(), precosDemo({ atualizadoEm: '2030-01-01T00:00:00.000Z' })),
  );
  ok(
    'mesmosDados: detecta mudança de preço',
    !mesmosDados(precosDemo(), precosDemo({ brasil: { ...clone(BRASIL_ESPERADO), etanol: { media: 4.15, min: 3.09, max: 6.59, postos: 3833 } } })),
  );
  ok(
    'mesmosDados: detecta semana diferente',
    !mesmosDados(precosDemo(), precosDemo({ semana: { inicio: '2026-10-11', fim: '2026-10-17' } })),
  );
}
{
  const opcoes = parsearArgumentos(['--file=a.xlsx', '--out', 'b.json', '--semana', '2026-10-04_2026-10-10', '--dry-run']);
  igual('argumentos: --file= e --out/--semana com valor', opcoes, {
    arquivo: 'a.xlsx',
    saida: 'b.json',
    semana: '2026-10-04_2026-10-10',
    dryRun: true,
    ajuda: false,
  });
  lanca('argumentos: flag desconhecida', () => parsearArgumentos(['--turbo']), 'desconhecido');
  lanca('argumentos: faltou valor', () => parsearArgumentos(['--file']), 'faltou valor');
  lanca('argumentos: semana inválida', () => parsearArgumentos(['--semana', '2026-10-04']), 'semana inválida');
}
ok('importar o módulo não executa a CLI', executadoDiretamente() === false);

// 28+: precos.json real do repositório
{
  ok('precos.json existe na raiz do projeto', existsSync(CAMINHO_PRECOS), CAMINHO_PRECOS);
  if (existsSync(CAMINHO_PRECOS)) {
    const bruto = readFileSync(CAMINHO_PRECOS, 'utf8');
    let precos;
    try {
      precos = JSON.parse(bruto);
    } catch (erro) {
      ok('precos.json é JSON válido', false, erro.message);
    }
    if (precos) {
      ok('precos.json: é JSON válido', true);
      const validacao = validarPrecos(precos);
      ok('precos.json: passa no schema/validação', validacao.ok, JSON.stringify(validacao.erros));
      igual('precos.json: exatamente os 3 produtos', Object.keys(precos.brasil ?? {}).sort(), ['etanol', 'gasolinaAditivada', 'gasolinaComum']);
      ok('precos.json: tem pelo menos 20 UFs', Object.keys(precos.estados ?? {}).length >= 20, String(Object.keys(precos.estados ?? {}).length));
      ok(
        'precos.json: semana com 7 dias (domingo a sábado nos arquivos da ANP)',
        dataValidaISO(precos.semana?.inicio) &&
          dataValidaISO(precos.semana?.fim) &&
          diaDaSemana(precos.semana.inicio) === 'domingo' &&
          diaDaSemana(precos.semana.fim) === 'sábado',
        `${precos.semana?.inicio} (${diaDaSemana(precos.semana?.inicio)}) a ${precos.semana?.fim} (${diaDaSemana(precos.semana?.fim)})`,
      );
      ok(
        'precos.json: url aponta para resumo_semanal_lpc_*.xlsx',
        /^https:\/\/.+resumo_semanal_lpc_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.xlsx$/.test(precos.url ?? ''),
        String(precos.url),
      );
      for (const chave of PRODUTOS) {
        const item = precos.brasil?.[chave];
        const faixa = FAIXAS[chave];
        ok(
          `precos.json: ${chave} dentro de R$ ${faixa.min}–${faixa.max}`,
          typeof item?.media === 'number' && item.media >= faixa.min && item.media <= faixa.max,
          JSON.stringify(item),
        );
      }
      ok(
        'precos.json: todas as UFs têm gasolina comum',
        Object.values(precos.estados ?? {}).every((item) => typeof item.gasolinaComum === 'number'),
      );
      // Semana de referência do FINDINGS §2.4: valores verificados em 17/10/2026.
      if (precos.semana?.inicio === '2026-10-04' && precos.semana?.fim === '2026-10-10') {
        igual('precos.json: semana de referência tem os valores do FINDINGS', {
          gasolinaComum: precos.brasil.gasolinaComum.media,
          gasolinaAditivada: precos.brasil.gasolinaAditivada.media,
          etanol: precos.brasil.etanol.media,
          postos: {
            comum: precos.brasil.gasolinaComum.postos,
            aditivada: precos.brasil.gasolinaAditivada.postos,
            etanol: precos.brasil.etanol.postos,
          },
        }, {
          gasolinaComum: 6.54,
          gasolinaAditivada: 6.72,
          etanol: 4.14,
          postos: { comum: 4474, aditivada: 3443, etanol: 3833 },
        });
        igual('precos.json: SP 6,36 e etanol 3,86 (como no FINDINGS)', precos.estados.SP, { gasolinaComum: 6.36, etanol: 3.86 });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Fim
// ---------------------------------------------------------------------------

console.log('');
if (falhas === 0) {
  console.log(`${total} ok, 0 falhas — preços da ANP e precos.json validados.`);
  process.exitCode = 0;
} else {
  console.log(`${total - falhas} ok, ${falhas} ${falhas === 1 ? 'falha' : 'falhas'} — corrija antes de commitar.`);
  process.exitCode = 1;
}
