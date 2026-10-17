#!/usr/bin/env node
/**
 * Atualiza `precos.json` com as médias semanais do Levantamento de Preços de
 * Combustíveis (LPC) da ANP — **sem nenhuma dependência externa**.
 *
 * O script:
 *   1. baixa a página "últimas semanas pesquisadas" da ANP;
 *   2. encontra o link mais recente de `resumo_semanal_lpc_AAAA-MM-DD_AAAA-MM-DD.xlsx`;
 *   3. baixa o XLSX e o descompacta com um leitor de ZIP mínimo (node:zlib);
 *   4. lê o XML das abas `BRASIL` e `ESTADOS` com regex (sem DOM/parser externo);
 *   5. monta e valida `precos.json` antes de gravar (nunca grava JSON parcial).
 *
 * Uso:
 *   node tools/update-prices.mjs                     # baixa a semana mais recente
 *   node tools/update-prices.mjs --dry-run           # imprime o JSON, não grava
 *   node tools/update-prices.mjs --file arquivo.xlsx # usa um XLSX local
 *   node tools/update-prices.mjs --out caminho.json  # grava em outro lugar
 *   node tools/update-prices.mjs --semana 2026-10-04_2026-10-10
 *
 * Só usa módulos nativos: node:fs, node:path, node:url, node:zlib e fetch.
 * Requer Node >= 20.
 *
 * As funções puras são exportadas para `tools/test-prices.mjs`. Importar este
 * arquivo **não** executa a CLI (o bloco final é guardado por
 * `executadoDiretamente`).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Página oficial que lista as últimas semanas pesquisadas. */
export const PAGINA_LPC =
  'https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/levantamento-de-precos-de-combustiveis-ultimas-semanas-pesquisadas';

/** Diretório base dos arquivos semanais (o ano é o da semana). */
export const BASE_ARQUIVOS_LPC =
  'https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/arquivos-lpc';

/** Texto de atribuição gravado em `fonte`. */
export const FONTE = 'ANP — Levantamento de Preços de Combustíveis';

/** Raiz do projeto (um nível acima de tools/). */
export const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)));

/** Caminho padrão do JSON gerado. */
export const CAMINHO_PADRAO = join(RAIZ, 'precos.json');

/** Chaves dos produtos usados no app, na ordem em que saem no JSON. */
export const PRODUTOS = ['gasolinaComum', 'gasolinaAditivada', 'etanol'];

/** Faixas de sanidade (R$/L) — iguais às do app, usadas na validação. */
export const FAIXAS = {
  gasolinaComum: { min: 2, max: 12 },
  gasolinaAditivada: { min: 2, max: 12 },
  etanol: { min: 1, max: 9 },
};

/** Rótulos em português para as mensagens. */
const ROTULOS = {
  gasolinaComum: 'Gasolina comum',
  gasolinaAditivada: 'Gasolina aditivada',
  etanol: 'Etanol hidratado',
};

const USO = `Uso: node tools/update-prices.mjs [opções]

Opções:
  --file, -f <arquivo.xlsx>   usa um XLSX local em vez de baixar
  --out, -o <arquivo.json>    grava em outro caminho (padrão: precos.json)
  --semana <AAAA-MM-DD_AAAA-MM-DD>  força uma semana específica
  --dry-run                   imprime o JSON no stdout e não grava nada
  --help, -h                  mostra esta ajuda

Exemplos:
  node tools/update-prices.mjs
  node tools/update-prices.mjs --dry-run
  node tools/update-prices.mjs --file resumo_semanal_lpc_2026-10-04_2026-10-10.xlsx
  node tools/update-prices.mjs --semana 2026-10-04_2026-10-10`;

// ---------------------------------------------------------------------------
// Log (sempre em stderr: o stdout fica reservado ao JSON do --dry-run)
// ---------------------------------------------------------------------------

function log(mensagem) {
  console.error(`precos: ${mensagem}`);
}

function aviso(mensagem) {
  console.error(`precos: aviso: ${mensagem}`);
}

// ---------------------------------------------------------------------------
// ZIP mínimo (diretório central + entradas "store" e "deflate")
// ---------------------------------------------------------------------------

const ZIP_EOCD = 0x06054b50; // End of central directory
const ZIP_CENTRAL = 0x02014b50; // Central directory file header
const ZIP_LOCAL = 0x04034b50; // Local file header

function encontrarEocd(buffer) {
  const menor = Math.max(0, buffer.length - 0xffff - 22);
  for (let i = buffer.length - 22; i >= menor; i--) {
    if (buffer.readUInt32LE(i) === ZIP_EOCD) return i;
  }
  return -1;
}

/**
 * Lê um ZIP em memória e devolve as entradas descomprimidas.
 * Suporta os métodos 0 (store) e 8 (deflate) — o que o XLSX usa.
 *
 * @param {Buffer} buffer
 * @returns {{ nomes: string[], tamanho: number, tem: (nome: string) => boolean, ler: (nome: string) => Buffer | null }}
 */
export function abrirZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error('arquivo ZIP inválido: conteúdo menor que o mínimo de 22 bytes');
  }
  const eocd = encontrarEocd(buffer);
  if (eocd < 0) {
    throw new Error('arquivo ZIP inválido: diretório central (EOCD) não encontrado');
  }
  const total = buffer.readUInt16LE(eocd + 10);
  const tamanhoDiretorio = buffer.readUInt32LE(eocd + 12);
  const inicioDiretorio = buffer.readUInt32LE(eocd + 16);
  if (
    total === 0xffff ||
    inicioDiretorio === 0xffffffff ||
    tamanhoDiretorio === 0xffffffff
  ) {
    throw new Error('ZIP64 não é suportado pelo leitor mínimo (o XLSX da ANP não usa ZIP64)');
  }
  if (total === 0) {
    throw new Error('arquivo ZIP vazio: nenhuma entrada');
  }
  if (inicioDiretorio + tamanhoDiretorio > buffer.length) {
    throw new Error('arquivo ZIP truncado: diretório central além do fim do arquivo');
  }

  const entradas = new Map();
  let posicao = inicioDiretorio;
  for (let i = 0; i < total; i++) {
    if (posicao + 46 > buffer.length || buffer.readUInt32LE(posicao) !== ZIP_CENTRAL) {
      throw new Error(`ZIP corrompido: cabeçalho do diretório central inválido na entrada ${i + 1}`);
    }
    const metodo = buffer.readUInt16LE(posicao + 10);
    const tamanhoComprimido = buffer.readUInt32LE(posicao + 20);
    const tamanhoOriginal = buffer.readUInt32LE(posicao + 24);
    const tamanhoNome = buffer.readUInt16LE(posicao + 28);
    const tamanhoExtra = buffer.readUInt16LE(posicao + 30);
    const tamanhoComentario = buffer.readUInt16LE(posicao + 32);
    const inicioLocal = buffer.readUInt32LE(posicao + 42);
    const nome = buffer.toString('utf8', posicao + 46, posicao + 46 + tamanhoNome);
    posicao += 46 + tamanhoNome + tamanhoExtra + tamanhoComentario;

    if (inicioLocal + 30 > buffer.length || buffer.readUInt32LE(inicioLocal) !== ZIP_LOCAL) {
      throw new Error(`ZIP corrompido: cabeçalho local inválido para "${nome}"`);
    }
    const tamanhoNomeLocal = buffer.readUInt16LE(inicioLocal + 26);
    const tamanhoExtraLocal = buffer.readUInt16LE(inicioLocal + 28);
    const inicioDados = inicioLocal + 30 + tamanhoNomeLocal + tamanhoExtraLocal;
    if (inicioDados + tamanhoComprimido > buffer.length) {
      throw new Error(`ZIP truncado: dados de "${nome}" passam do fim do arquivo`);
    }

    if (metodo !== 0 && metodo !== 8) {
      throw new Error(`método de compressão ${metodo} não suportado em "${nome}" (aceitos: 0=store, 8=deflate)`);
    }
    const bruto = buffer.subarray(inicioDados, inicioDados + tamanhoComprimido);
    let dados;
    if (metodo === 0) {
      dados = Buffer.from(bruto);
    } else {
      try {
        dados = inflateRawSync(bruto);
      } catch (erro) {
        throw new Error(`não foi possível descomprimir "${nome}": ${erro.message}`);
      }
    }
    if (tamanhoOriginal !== 0 && dados.length !== tamanhoOriginal) {
      throw new Error(
        `tamanho descomprimido inesperado em "${nome}": ${dados.length} bytes (esperado ${tamanhoOriginal})`,
      );
    }
    entradas.set(nome, dados);
  }

  return {
    nomes: [...entradas.keys()],
    tamanho: buffer.length,
    tem: (nome) => entradas.has(nome),
    ler: (nome) => entradas.get(nome) ?? null,
  };
}

/** Lê uma entrada do ZIP como texto UTF-8 (ou null se não existir). */
export function lerTextoZip(zip, nome) {
  const dados = zip.ler(nome);
  return dados ? dados.toString('utf8') : null;
}

// ---------------------------------------------------------------------------
// XML: entidades, shared strings e células
// ---------------------------------------------------------------------------

const ENTIDADES_XML = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decodifica as entidades XML usadas pelo XLSX. */
export function decodificarXml(texto = '') {
  return String(texto).replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (bruto, codigo) => {
    try {
      if (codigo[0] === '#') {
        const hexadecimal = codigo[1] === 'x' || codigo[1] === 'X';
        return String.fromCodePoint(parseInt(hexadecimal ? codigo.slice(2) : codigo.slice(1), hexadecimal ? 16 : 10));
      }
      return ENTIDADES_XML[codigo] ?? bruto;
    } catch {
      return bruto;
    }
  });
}

/**
 * Lista os textos de `xl/sharedStrings.xml`, na ordem dos índices.
 * Cada `<si>` pode ter vários `<t>` (texto rico) — todos são concatenados.
 */
export function parsearSharedStrings(xml) {
  if (!xml) return [];
  const textos = [];
  for (const item of String(xml).matchAll(/<si\b([^>]*?)(?:\/>|>([\s\S]*?)<\/si>)/g)) {
    if (item[2] === undefined) {
      textos.push('');
      continue;
    }
    const partes = [...item[2].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodificarXml(t[1]));
    textos.push(partes.join(''));
  }
  return textos;
}

/**
 * Converte uma lista de linhas `<row>` em `{ numero, celulas: Map<letra, {tipo, valor}> }`.
 * Valores numéricos ficam como texto e são convertidos por `parseNumeroPtBr`.
 */
export function parsearLinhasPlanilha(xml, sharedStrings = []) {
  if (!xml) return [];
  const linhas = [];
  for (const linha of String(xml).matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const atributos = linha[1];
    const numero = Number(/(?:^|\s)r="(\d+)"/.exec(atributos)?.[1] ?? linhas.length + 1);
    const celulas = new Map();
    if (linha[2] === undefined) {
      linhas.push({ numero, celulas });
      continue;
    }
    for (const celula of linha[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const atributosCelula = celula[1];
      const coluna = /(?:^|\s)r="([A-Z]+)\d*"/.exec(atributosCelula)?.[1];
      if (!coluna) continue;
      const tipo = /(?:^|\s)t="([^"]+)"/.exec(atributosCelula)?.[1] ?? 'n';
      const corpo = celula[2] ?? '';
      let valor = null;
      if (tipo === 'inlineStr') {
        const texto = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(corpo);
        valor = texto ? decodificarXml(texto[1]) : null;
      } else {
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(corpo);
        if (v) {
          const bruto = decodificarXml(v[1]);
          if (tipo === 's') {
            const indice = Number(bruto);
            valor = Number.isInteger(indice) ? sharedStrings[indice] ?? null : null;
          } else {
            valor = bruto;
          }
        }
      }
      celulas.set(coluna, { tipo, valor });
    }
    linhas.push({ numero, celulas });
  }
  return linhas;
}

/** Valor bruto de uma célula (por letra da coluna) ou null. */
function valorDaCelula(linha, letra) {
  if (!linha || !letra) return null;
  return linha.celulas.get(letra)?.valor ?? null;
}

// ---------------------------------------------------------------------------
// Normalizações e conversões pt-BR
// ---------------------------------------------------------------------------

/** Maiúsculas, sem acentos, espaços colapsados — para comparar cabeçalhos. */
export function normalizarTexto(texto) {
  if (texto === null || texto === undefined) return '';
  return String(texto)
    .replace(/\u00a0/g, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/**
 * Converte o texto de uma célula em número, aceitando:
 *   - decimal com ponto (formato interno do XLSX): `6.54`, `4.1399999999999997`;
 *   - decimal com vírgula (pt-BR): `6,54`, `R$ 6,54`;
 *   - milhar com ponto: `4.474` → 4474, `1.234,56` → 1234.56;
 *   - notação científica: `6.2E-2`.
 * Devolve `null` quando não é número.
 */
export function parseNumeroPtBr(bruto) {
  if (typeof bruto === 'number') return Number.isFinite(bruto) ? bruto : null;
  if (bruto === null || bruto === undefined) return null;
  let texto = String(bruto).replace(/\u00a0/g, ' ').trim();
  if (!texto) return null;
  texto = texto.replace(/R\$\s*/gi, '').replace(/\s+/g, '');
  if (!texto || texto === '-') return null;

  if (/^-?\d+(?:[.,]\d+)?[eE][+-]?\d+$/.test(texto)) {
    const numero = Number(texto.replace(',', '.'));
    return Number.isFinite(numero) ? numero : null;
  }
  // Milhar com ponto (e decimal opcional com vírgula): 4.474 / 1.234,56
  if (/^-?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(texto)) {
    const numero = Number(texto.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(numero) ? numero : null;
  }
  // Decimal com vírgula (pode ter pontos de milhar fora do padrão): 6,54
  if (texto.includes(',')) {
    const numero = Number(texto.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(numero) ? numero : null;
  }
  // Inteiro ou decimal com ponto: 46299 / 6.54
  if (/^-?\d+(?:\.\d+)?$/.test(texto)) {
    const numero = Number(texto);
    return Number.isFinite(numero) ? numero : null;
  }
  return null;
}

/** Arredonda para 2 casas (evita artefatos como 4.1399999999999997). */
export function arredondar2(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero)) return null;
  return Math.round((numero + Number.EPSILON) * 100) / 100;
}

/**
 * Normaliza o nome do produto para a chave usada no JSON.
 * `null` para produtos que não interessam (diesel, GLP, GNV...).
 */
export function normalizarProduto(texto) {
  const nome = normalizarTexto(texto);
  if (!nome) return null;
  if (/\bADITIVADA\b/.test(nome) && /\bGASOLINA\b/.test(nome)) return 'gasolinaAditivada';
  if (/\bGASOLINA\b/.test(nome)) return 'gasolinaComum';
  if (/\bETANOL\b/.test(nome)) return 'etanol';
  return null;
}

// Nome completo (como vem na aba ESTADOS) → sigla da UF.
const NOME_PARA_UF = {
  ACRE: 'AC',
  ALAGOAS: 'AL',
  AMAPA: 'AP',
  AMAZONAS: 'AM',
  BAHIA: 'BA',
  CEARA: 'CE',
  'DISTRITO FEDERAL': 'DF',
  'ESPIRITO SANTO': 'ES',
  GOIAS: 'GO',
  MARANHAO: 'MA',
  'MATO GROSSO': 'MT',
  'MATO GROSSO DO SUL': 'MS',
  'MINAS GERAIS': 'MG',
  PARA: 'PA',
  PARAIBA: 'PB',
  PARANA: 'PR',
  PERNAMBUCO: 'PE',
  PIAUI: 'PI',
  'RIO DE JANEIRO': 'RJ',
  'RIO GRANDE DO NORTE': 'RN',
  'RIO GRANDE DO SUL': 'RS',
  RONDONIA: 'RO',
  RORAIMA: 'RR',
  'SANTA CATARINA': 'SC',
  'SAO PAULO': 'SP',
  SERGIPE: 'SE',
  TOCANTINS: 'TO',
};

const UFS_VALIDAS = new Set(Object.values(NOME_PARA_UF));

/** Converte "SÃO PAULO"/"SP" na sigla `SP`; null se desconhecido. */
export function estadoParaUF(nome) {
  const texto = normalizarTexto(nome);
  if (!texto) return null;
  if (UFS_VALIDAS.has(texto)) return texto;
  return NOME_PARA_UF[texto] ?? null;
}

// ---------------------------------------------------------------------------
// Datas (séries do Excel e strings)
// ---------------------------------------------------------------------------

const DIA_EM_MS = 86_400_000;
const BASE_SERIAL_EXCEL = Date.UTC(1899, 11, 30); // dia 0 do calendário 1900 do Excel

/** Série numérica do Excel → `AAAA-MM-DD` (UTC). */
export function serialExcelParaISOData(serial) {
  const numero = Number(serial);
  if (!Number.isFinite(numero) || numero < 1 || numero > 2_958_465) return null;
  return new Date(BASE_SERIAL_EXCEL + Math.floor(numero) * DIA_EM_MS).toISOString().slice(0, 10);
}

/** `AAAA-MM-DD` é uma data real do calendário? */
export function dataValidaISO(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return false;
  const data = new Date(`${iso}T00:00:00.000Z`);
  return !Number.isNaN(data.getTime()) && data.toISOString().slice(0, 10) === iso;
}

/** Célula de data (série do Excel, `dd/mm/aaaa` ou ISO) → `AAAA-MM-DD`. */
export function parseDataCelula(valor) {
  if (valor === null || valor === undefined) return null;
  const texto = String(valor).trim();
  if (!texto) return null;
  if (/^\d+(?:\.\d+)?$/.test(texto)) {
    const data = serialExcelParaISOData(Number(texto));
    if (data) return data;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) return dataValidaISO(texto) ? texto : null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(texto)) {
    const iso = texto.slice(0, 10);
    return dataValidaISO(iso) ? iso : null;
  }
  const brasileira = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(texto);
  if (brasileira) {
    const [, dia, mes, ano] = brasileira;
    const iso = `${ano}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
    return dataValidaISO(iso) ? iso : null;
  }
  return null;
}

/** `AAAA-MM-DD` → `dd/mm/aaaa` (para mensagens). */
export function formatarDataBR(iso) {
  const partes = String(iso ?? '').split('-');
  if (partes.length !== 3) return String(iso ?? '');
  return `${partes[2]}/${partes[1]}/${partes[0]}`;
}

/** Dia da semana em português (UTC). */
export function diaDaSemana(iso) {
  const nomes = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  if (!dataValidaISO(iso)) return null;
  return nomes[new Date(`${iso}T00:00:00.000Z`).getUTCDay()];
}

function diferencaEmDias(inicio, fim) {
  return Math.round((Date.parse(`${fim}T00:00:00.000Z`) - Date.parse(`${inicio}T00:00:00.000Z`)) / DIA_EM_MS);
}

/**
 * Valida e normaliza `AAAA-MM-DD_AAAA-MM-DD` (aceita `-` no lugar do `_`).
 * A semana do LPC tem 7 dias (domingo a sábado nos arquivos da ANP).
 */
export function normalizarSemana(texto) {
  const casa = /^(\d{4})-(\d{1,2})-(\d{1,2})[_-](\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(texto ?? '').trim());
  if (!casa) {
    throw new Error(`semana inválida: "${texto}". Use AAAA-MM-DD_AAAA-MM-DD (ex.: 2026-10-04_2026-10-10)`);
  }
  const pad = (valor) => String(Number(valor)).padStart(2, '0');
  const inicio = `${casa[1]}-${pad(casa[2])}-${pad(casa[3])}`;
  const fim = `${casa[4]}-${pad(casa[5])}-${pad(casa[6])}`;
  if (!dataValidaISO(inicio) || !dataValidaISO(fim)) {
    throw new Error(`semana inválida: "${inicio}" a "${fim}" não são datas reais`);
  }
  const dias = diferencaEmDias(inicio, fim);
  if (dias !== 6) {
    throw new Error(`semana inválida: "${inicio}" a "${fim}" tem ${dias + 1} dias; o LPC usa 7 dias (domingo a sábado)`);
  }
  return { inicio, fim, chave: `${inicio}_${fim}` };
}

/** Extrai a semana do nome `resumo_semanal_lpc_AAAA-MM-DD_AAAA-MM-DD.xlsx`. */
export function extrairSemanaDoNome(nome) {
  const casa = /resumo_semanal_lpc_(\d{4})-(\d{1,2})-(\d{1,2})[_-](\d{4})-(\d{1,2})-(\d{1,2})\.xlsx/i.exec(
    String(nome ?? ''),
  );
  if (!casa) return null;
  const pad = (valor) => String(Number(valor)).padStart(2, '0');
  return {
    inicio: `${casa[1]}-${pad(casa[2])}-${pad(casa[3])}`,
    fim: `${casa[4]}-${pad(casa[5])}-${pad(casa[6])}`,
  };
}

/** URL canônica do XLSX de uma semana (chute; a página é a fonte de verdade). */
export function urlCanonicaDaSemana(semana) {
  const { inicio, fim } = normalizarSemana(typeof semana === 'string' ? semana : `${semana.inicio}_${semana.fim}`);
  return `${BASE_ARQUIVOS_LPC}/${inicio.slice(0, 4)}/resumo_semanal_lpc_${inicio}_${fim}.xlsx`;
}

// ---------------------------------------------------------------------------
// Página da ANP: escolha do link mais recente
// ---------------------------------------------------------------------------

function compararSemanas(a, b) {
  if (a.semana.fim !== b.semana.fim) return a.semana.fim < b.semana.fim ? 1 : -1;
  if (a.semana.inicio !== b.semana.inicio) return a.semana.inicio < b.semana.inicio ? 1 : -1;
  return a.url.localeCompare(b.url);
}

/** Lista (sem repetir) os links de resumo semanal presentes no HTML. */
export function listarLinksResumoSemanal(html, baseUrl = PAGINA_LPC) {
  if (typeof html !== 'string' || !html.trim()) {
    throw new Error('HTML da página da ANP vazio ou inválido');
  }
  const porUrl = new Map();
  const padrao = /(?:href\s*=\s*["']([^"']*resumo_semanal_lpc_[^"']+\.xlsx)["'])|((?:https?:)?\/\/[^\s"'<>]*resumo_semanal_lpc_[^\s"'<>]+\.xlsx)/gi;
  for (const casa of html.matchAll(padrao)) {
    const bruto = (casa[1] ?? casa[2] ?? '').replace(/&amp;/g, '&').trim();
    if (!bruto) continue;
    const arquivo = /resumo_semanal_lpc_[\d\-_]+\.xlsx/i.exec(bruto)?.[0];
    const semana = extrairSemanaDoNome(arquivo ?? bruto);
    if (!semana) continue;
    let url;
    try {
      url = new URL(bruto, baseUrl).href;
    } catch {
      continue;
    }
    if (porUrl.has(url)) continue;
    porUrl.set(url, { url, semana, arquivo: arquivo ?? basename(new URL(url).pathname) });
  }
  if (porUrl.size === 0) {
    throw new Error('nenhum link de resumo_semanal_lpc_*.xlsx encontrado na página da ANP');
  }
  return [...porUrl.values()].sort(compararSemanas);
}

/** Link mais recente de resumo semanal na página. */
export function escolherLinkMaisRecente(html, baseUrl = PAGINA_LPC) {
  return listarLinksResumoSemanal(html, baseUrl)[0];
}

/** Link da semana pedida (ou null se ela não estiver listada). */
export function escolherLinkDaSemana(html, semana, baseUrl = PAGINA_LPC) {
  const alvo = typeof semana === 'string' ? normalizarSemana(semana) : semana;
  return (
    listarLinksResumoSemanal(html, baseUrl).find(
      (link) => link.semana.inicio === alvo.inicio && link.semana.fim === alvo.fim,
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Planilha: cabeçalho, aba BRASIL e aba ESTADOS
// ---------------------------------------------------------------------------

/**
 * Mapeia o cabeçalho de uma linha para as letras de cada coluna.
 * Nomes variam em caixa/acento entre arquivos; comparamos normalizado.
 */
export function mapearCabecalho(celulas) {
  const colunas = {};
  for (const [letra, celula] of celulas) {
    const titulo = normalizarTexto(celula?.valor);
    if (!titulo) continue;
    if (/^DATA INICIAL$/.test(titulo)) colunas.dataInicial ??= letra;
    else if (/^DATA FINAL$/.test(titulo)) colunas.dataFinal ??= letra;
    else if (/^PRODUTO$/.test(titulo)) colunas.produto ??= letra;
    else if (/^PRECO MEDIO(?: REVENDA)?$/.test(titulo)) colunas.media ??= letra;
    else if (/^PRECO MINIMO(?: REVENDA)?$/.test(titulo)) colunas.minimo ??= letra;
    else if (/^PRECO MAXIMO(?: REVENDA)?$/.test(titulo)) colunas.maximo ??= letra;
    else if (/^NUMERO DE POSTOS PESQUISADOS$/.test(titulo)) colunas.postos ??= letra;
    else if (/^UNIDADE DE MEDIDA$/.test(titulo)) colunas.unidade ??= letra;
    else if (/^ESTADOS?$/.test(titulo) || titulo === 'UF') colunas.estado ??= letra;
    else if (/^MUNICIPIO$/.test(titulo)) colunas.municipio ??= letra;
    else if (/^BRASIL$/.test(titulo)) colunas.brasil ??= letra;
    else if (/^REGIAO$/.test(titulo)) colunas.regiao ??= letra;
  }
  return colunas;
}

/** Acha a linha de cabeçalho (na ANP é a linha 10) e o mapa de colunas. */
export function encontrarCabecalho(linhas) {
  for (let i = 0; i < linhas.length; i++) {
    const colunas = mapearCabecalho(linhas[i].celulas);
    if (colunas.produto && colunas.media) {
      return { indice: i, linha: linhas[i], colunas };
    }
  }
  throw new Error(
    'cabeçalho não encontrado: nenhuma linha tem as colunas PRODUTO e PREÇO MÉDIO REVENDA (esperado na linha 10)',
  );
}

function semanaDeLinhas(linhas, colunas) {
  const semanas = new Set();
  for (const linha of linhas) {
    const inicio = parseDataCelula(valorDaCelula(linha, colunas.dataInicial));
    const fim = parseDataCelula(valorDaCelula(linha, colunas.dataFinal));
    if (inicio && fim) semanas.add(`${inicio}_${fim}`);
  }
  const lista = [...semanas];
  if (lista.length === 0) return { semana: null, todosIguais: true };
  if (lista.length > 1) return { semana: normalizarSemana(lista[0]), todosIguais: false };
  return { semana: normalizarSemana(lista[0]), todosIguais: true };
}

/**
 * Extrai as médias nacionais da aba BRASIL.
 * @returns {{ brasil: Record<string, {media:number,min:number,max:number,postos:number}>, semana: object|null, avisos: string[] }}
 */
export function extrairBrasil(linhas) {
  const { indice, colunas } = encontrarCabecalho(linhas);
  const dados = linhas.slice(indice + 1);
  const { semana, todosIguais } = semanaDeLinhas(dados, colunas);
  const avisos = [];
  if (!todosIguais) aviso('a aba BRASIL tem mais de uma semana nas colunas DATA INICIAL/DATA FINAL; usando a primeira');
  const brasil = {};

  for (const linha of dados) {
    const chave = normalizarProduto(valorDaCelula(linha, colunas.produto));
    if (!chave) continue;
    if (brasil[chave]) {
      avisos.push(`produto "${chave}" aparece mais de uma vez na aba BRASIL; mantendo a primeira linha`);
      continue;
    }
    const media = parseNumeroPtBr(valorDaCelula(linha, colunas.media));
    const minimo = parseNumeroPtBr(valorDaCelula(linha, colunas.minimo));
    const maximo = parseNumeroPtBr(valorDaCelula(linha, colunas.maximo));
    const postos = parseNumeroPtBr(valorDaCelula(linha, colunas.postos));
    if (media === null || minimo === null || maximo === null || postos === null) {
      avisos.push(`linha ${linha.numero} da aba BRASIL (${chave}) com valores faltando/inválidos; ignorada`);
      continue;
    }
    brasil[chave] = {
      media: arredondar2(media),
      min: arredondar2(minimo),
      max: arredondar2(maximo),
      postos: Math.round(postos),
    };
  }

  for (const chave of PRODUTOS) {
    if (!brasil[chave]) {
      throw new Error(`aba BRASIL sem dados de "${ROTULOS[chave]}" (${chave}); arquivo inesperado, nada será gravado`);
    }
  }
  const ordenado = {};
  for (const chave of PRODUTOS) ordenado[chave] = brasil[chave];
  return { brasil: ordenado, semana, avisos };
}

/**
 * Extrai as médias por UF da aba ESTADOS (só gasolina comum e etanol,
 * que é o que o app usa; a aditivada já está na aba BRASIL).
 */
export function extrairEstados(linhas) {
  const { indice, colunas } = encontrarCabecalho(linhas);
  if (!colunas.estado) {
    throw new Error('aba ESTADOS sem coluna de estado (ESTADOS/UF)');
  }
  const dados = linhas.slice(indice + 1);
  const { semana } = semanaDeLinhas(dados, colunas);
  const avisos = [];
  const estados = new Map();
  const naoReconhecidos = new Set();

  for (const linha of dados) {
    const chave = normalizarProduto(valorDaCelula(linha, colunas.produto));
    if (!chave || chave === 'gasolinaAditivada') continue;
    const uf = estadoParaUF(valorDaCelula(linha, colunas.estado));
    if (!uf) {
      const bruto = valorDaCelula(linha, colunas.estado);
      if (bruto) naoReconhecidos.add(String(bruto));
      continue;
    }
    const media = parseNumeroPtBr(valorDaCelula(linha, colunas.media));
    if (media === null) {
      avisos.push(`linha ${linha.numero} da aba ESTADOS (${uf}/${chave}) sem preço médio; ignorada`);
      continue;
    }
    if (!estados.has(uf)) estados.set(uf, {});
    const item = estados.get(uf);
    if (item[chave] !== undefined) {
      avisos.push(`${uf}/${chave} aparece mais de uma vez na aba ESTADOS; mantendo o primeiro valor`);
      continue;
    }
    item[chave] = arredondar2(media);
  }

  if (naoReconhecidos.size) {
    avisos.push(`estados não reconhecidos na aba ESTADOS: ${[...naoReconhecidos].join(', ')}`);
  }
  if (estados.size === 0) {
    throw new Error('aba ESTADOS sem nenhuma UF reconhecida; arquivo inesperado, nada será gravado');
  }

  const ordenado = {};
  for (const uf of [...estados.keys()].sort()) {
    const item = estados.get(uf);
    const saida = {};
    if (item.gasolinaComum !== undefined) saida.gasolinaComum = item.gasolinaComum;
    if (item.etanol !== undefined) saida.etanol = item.etanol;
    if (Object.keys(saida).length) ordenado[uf] = saida;
  }
  return { estados: ordenado, semana, avisos };
}

// ---------------------------------------------------------------------------
// Resolução das abas pelo nome (xl/workbook.xml + rels)
// ---------------------------------------------------------------------------

function normalizarCaminhoAba(alvo) {
  const limpo = String(alvo).replace(/^\/+/, '');
  return posix.normalize(limpo.startsWith('xl/') ? limpo : `xl/${limpo}`);
}

/** Mapa nome da aba → caminho dentro do ZIP (ex.: BRASIL → xl/worksheets/sheet5.xml). */
export function resolverAbas(zip) {
  const workbook = lerTextoZip(zip, 'xl/workbook.xml');
  const rels = lerTextoZip(zip, 'xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) return null;

  const nomePorId = new Map();
  for (const tag of workbook.matchAll(/<sheet\b[^>]*?\/?>/g)) {
    const nome = /(?:^|\s)name="([^"]*)"/.exec(tag[0])?.[1];
    const id = /(?:^|\s)r:id="([^"]*)"/.exec(tag[0])?.[1];
    if (nome && id) nomePorId.set(id, decodificarXml(nome));
  }

  const caminhoPorId = new Map();
  for (const tag of rels.matchAll(/<Relationship\b[^>]*?\/?>/g)) {
    const id = /(?:^|\s)Id="([^"]*)"/.exec(tag[0])?.[1];
    const alvo = /(?:^|\s)Target="([^"]*)"/.exec(tag[0])?.[1];
    const tipo = /(?:^|\s)Type="([^"]*)"/.exec(tag[0])?.[1] ?? '';
    if (!id || !alvo) continue;
    if (!/worksheet/i.test(tipo) && !/worksheets\//i.test(alvo)) continue;
    caminhoPorId.set(id, normalizarCaminhoAba(decodificarXml(alvo)));
  }

  const abas = new Map();
  for (const [id, nome] of nomePorId) {
    const caminho = caminhoPorId.get(id);
    if (caminho && zip.ler(caminho)) abas.set(normalizarTexto(nome), caminho);
  }
  return abas.size ? abas : null;
}

/** Fallback: descobre a aba pelo conteúdo do cabeçalho. */
function detectarAba(zip, sharedStrings, tipo) {
  const planilhas = zip.nomes
    .filter((nome) => /^xl\/worksheets\/sheet\d+\.xml$/.test(nome))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const caminho of planilhas) {
    try {
      const linhas = parsearLinhasPlanilha(zip.ler(caminho).toString('utf8'), sharedStrings);
      const { colunas } = encontrarCabecalho(linhas);
      if (tipo === 'brasil' && colunas.brasil) return caminho;
      if (tipo === 'estados' && colunas.estado && !colunas.municipio) return caminho;
    } catch {
      // planilha sem cabeçalho reconhecível: segue para a próxima
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extração completa do XLSX
// ---------------------------------------------------------------------------

/**
 * Lê o XLSX (Buffer) e devolve as médias do Brasil e dos estados.
 * @returns {{ brasil: object, estados: object, semana: object|null, abas: string[], avisos: string[] }}
 */
export function extrairPrecosDoArquivo(buffer) {
  const zip = abrirZip(buffer);
  const shared = parsearSharedStrings(lerTextoZip(zip, 'xl/sharedStrings.xml') ?? '');
  const abas = resolverAbas(zip);

  const caminhoBrasil = abas?.get('BRASIL') ?? detectarAba(zip, shared, 'brasil');
  const caminhoEstados = abas?.get('ESTADOS') ?? detectarAba(zip, shared, 'estados');
  if (!caminhoBrasil) throw new Error('aba BRASIL não encontrada no XLSX');
  if (!caminhoEstados) throw new Error('aba ESTADOS não encontrada no XLSX');

  const linhasBrasil = parsearLinhasPlanilha(zip.ler(caminhoBrasil).toString('utf8'), shared);
  const linhasEstados = parsearLinhasPlanilha(zip.ler(caminhoEstados).toString('utf8'), shared);
  const brasil = extrairBrasil(linhasBrasil);
  const estados = extrairEstados(linhasEstados);

  const avisos = [...brasil.avisos, ...estados.avisos];
  if (brasil.semana && estados.semana && brasil.semana.chave !== estados.semana.chave) {
    avisos.push(
      `semana da aba BRASIL (${brasil.semana.chave}) difere da aba ESTADOS (${estados.semana.chave}); usando a do BRASIL`,
    );
  }

  return {
    brasil: brasil.brasil,
    estados: estados.estados,
    semana: brasil.semana ?? estados.semana ?? null,
    abas: zip.nomes.filter((nome) => /^xl\/worksheets\/sheet\d+\.xml$/.test(nome)),
    avisos,
  };
}

// ---------------------------------------------------------------------------
// Montagem e validação do JSON
// ---------------------------------------------------------------------------

/**
 * Monta o objeto final de `precos.json` (ordem fixa de chaves, números
 * arredondados, estados ordenados por UF). Não valida; use `validarPrecos`.
 */
export function montarPrecos({ url, semana, brasil, estados, atualizadoEm } = {}) {
  const semanaNormalizada = typeof semana === 'string' ? normalizarSemana(semana) : semana;
  if (!semanaNormalizada?.inicio || !semanaNormalizada?.fim) {
    throw new Error('montarPrecos: semana ausente ou inválida');
  }
  const dataAtualizacao = new Date(atualizadoEm ?? Date.now());
  if (Number.isNaN(dataAtualizacao.getTime())) {
    throw new Error(`montarPrecos: atualizadoEm inválido: ${atualizadoEm}`);
  }

  const brasilSaida = {};
  for (const chave of PRODUTOS) {
    const item = brasil?.[chave];
    if (!item) continue;
    brasilSaida[chave] = {
      media: arredondar2(item.media),
      min: arredondar2(item.min),
      max: arredondar2(item.max),
      postos: Math.round(Number(item.postos)),
    };
  }

  const estadosSaida = {};
  for (const uf of Object.keys(estados ?? {}).sort()) {
    const item = estados[uf] ?? {};
    const saida = {};
    if (item.gasolinaComum !== undefined) saida.gasolinaComum = arredondar2(item.gasolinaComum);
    if (item.etanol !== undefined) saida.etanol = arredondar2(item.etanol);
    if (Object.keys(saida).length) estadosSaida[uf] = saida;
  }

  return {
    fonte: FONTE,
    url,
    semana: { inicio: semanaNormalizada.inicio, fim: semanaNormalizada.fim },
    atualizadoEm: dataAtualizacao.toISOString(),
    brasil: brasilSaida,
    estados: estadosSaida,
  };
}

function numeroPlausivel(valor, faixa) {
  return typeof valor === 'number' && Number.isFinite(valor) && valor >= faixa.min && valor <= faixa.max;
}

/**
 * Valida o objeto que será gravado. Regras:
 *   - campos de topo presentes, `url` http(s)/file, `atualizadoEm` ISO;
 *   - semana com 7 dias (domingo a sábado nos arquivos da ANP);
 *   - exatamente os 3 produtos nacionais, com média/mín/máx/postos coerentes;
 *   - médias dentro de faixas plausíveis (gasolina 2–12; etanol 1–9 R$/L);
 *   - pelo menos 20 UFs, cada uma com gasolina comum.
 * @returns {{ ok: boolean, erros: string[] }}
 */
export function validarPrecos(precos) {
  const erros = [];
  if (!precos || typeof precos !== 'object' || Array.isArray(precos)) {
    return { ok: false, erros: ['o conteúdo não é um objeto JSON'] };
  }
  if (typeof precos.fonte !== 'string' || !precos.fonte.trim()) erros.push('campo "fonte" ausente ou vazio');
  if (typeof precos.url !== 'string' || !/^(https?:\/\/|file:\/\/)/.test(precos.url)) {
    erros.push('campo "url" ausente ou fora de http(s)/file');
  }

  if (!precos.semana || typeof precos.semana !== 'object') {
    erros.push('campo "semana" ausente');
  } else {
    const { inicio, fim } = precos.semana;
    if (!dataValidaISO(inicio) || !dataValidaISO(fim)) {
      erros.push('semana.inicio/semana.fim não são datas AAAA-MM-DD válidas');
    } else if (diferencaEmDias(inicio, fim) !== 6) {
      erros.push(`semana deveria ter 7 dias (domingo a sábado); "${inicio}" a "${fim}" não tem`);
    }
  }

  const atualizado = Date.parse(precos.atualizadoEm);
  if (Number.isNaN(atualizado)) erros.push('campo "atualizadoEm" ausente ou fora do padrão ISO 8601');

  if (!precos.brasil || typeof precos.brasil !== 'object') {
    erros.push('campo "brasil" ausente');
  } else {
    const chaves = Object.keys(precos.brasil);
    for (const chave of PRODUTOS) {
      if (!chaves.includes(chave)) erros.push(`produto "${chave}" ausente no bloco brasil`);
    }
    for (const chave of chaves) {
      if (!PRODUTOS.includes(chave)) erros.push(`produto inesperado "${chave}" no bloco brasil`);
    }
    for (const chave of PRODUTOS) {
      const item = precos.brasil[chave];
      if (!item) continue;
      const faixa = FAIXAS[chave];
      if (!numeroPlausivel(item.media, faixa)) {
        erros.push(`brasil.${chave}.media fora da faixa plausível (${faixa.min}–${faixa.max}): ${item.media}`);
      }
      const faixaAmpla = { min: 0.5, max: 20 };
      for (const campo of ['min', 'max']) {
        if (!numeroPlausivel(item[campo], faixaAmpla)) {
          erros.push(`brasil.${chave}.${campo} fora da faixa plausível (0,5–20): ${item[campo]}`);
        }
      }
      if (item.min > item.media || item.media > item.max) {
        erros.push(`brasil.${chave}: esperado min <= media <= max, veio ${item.min}/${item.media}/${item.max}`);
      }
      if (!(Number.isInteger(item.postos) && item.postos > 0 && item.postos <= 200_000)) {
        erros.push(`brasil.${chave}.postos deveria ser inteiro positivo: ${item.postos}`);
      }
    }
  }

  if (!precos.estados || typeof precos.estados !== 'object' || Array.isArray(precos.estados)) {
    erros.push('campo "estados" ausente ou não é objeto');
  } else {
    const ufs = Object.keys(precos.estados);
    if (ufs.length === 0) erros.push('bloco "estados" vazio');
    if (ufs.length < 20) erros.push(`bloco "estados" com apenas ${ufs.length} UFs (esperado >= 20); possível extração parcial`);
    for (const uf of ufs) {
      if (!/^[A-Z]{2}$/.test(uf)) erros.push(`chave de estado inválida: "${uf}"`);
      else if (!UFS_VALIDAS.has(uf)) erros.push(`UF desconhecida: "${uf}"`);
      const item = precos.estados[uf];
      if (!item || typeof item !== 'object') {
        erros.push(`estados.${uf} não é objeto`);
        continue;
      }
      if (item.gasolinaComum === undefined) erros.push(`estados.${uf} sem gasolinaComum`);
      for (const chave of ['gasolinaComum', 'etanol']) {
        if (item[chave] === undefined) continue;
        const faixa = FAIXAS[chave];
        if (!numeroPlausivel(item[chave], faixa)) {
          erros.push(`estados.${uf}.${chave} fora da faixa plausível (${faixa.min}–${faixa.max}): ${item[chave]}`);
        }
      }
      for (const chave of Object.keys(item)) {
        if (chave !== 'gasolinaComum' && chave !== 'etanol') erros.push(`estados.${uf}: chave inesperada "${chave}"`);
      }
    }
  }

  return { ok: erros.length === 0, erros };
}

// ---------------------------------------------------------------------------
// Apresentação: resumo e diferença
// ---------------------------------------------------------------------------

function formatarNumero(valor) {
  if (valor === null || valor === undefined || Number.isNaN(Number(valor))) return '—';
  return Number(valor).toFixed(2).replace('.', ',');
}

function formatarTamanho(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2).replace('.', ',')} MB`;
}

/**
 * `true` quando dois `precos.json` têm exatamente os mesmos dados
 * (URL, semana, preços do Brasil e dos estados). `atualizadoEm` é ignorado:
 * serve para a Action não commitar só porque o horário de geração mudou.
 */
export function mesmosDados(anterior, novo) {
  if (!anterior || !novo) return false;
  if (anterior.url !== novo.url) return false;
  if (anterior.semana?.inicio !== novo.semana?.inicio || anterior.semana?.fim !== novo.semana?.fim) return false;
  for (const chave of PRODUTOS) {
    const antes = anterior.brasil?.[chave];
    const depois = novo.brasil?.[chave];
    if (!antes || !depois) return false;
    for (const campo of ['media', 'min', 'max', 'postos']) {
      if (antes[campo] !== depois[campo]) return false;
    }
  }
  const ufsAntes = Object.keys(anterior.estados ?? {});
  const ufsDepois = Object.keys(novo.estados ?? {});
  if (ufsAntes.length !== ufsDepois.length) return false;
  for (const uf of ufsDepois) {
    const antes = anterior.estados?.[uf];
    const depois = novo.estados?.[uf];
    if (!antes || !depois) return false;
    if (antes.gasolinaComum !== depois.gasolinaComum || antes.etanol !== depois.etanol) return false;
  }
  return true;
}

/** Linhas de diferença resumida entre dois `precos.json`. */
export function resumirDiferenca(anterior, novo) {  if (!anterior) return ['(não havia precos.json anterior)'];
  const linhas = [];
  const semanaAnterior = anterior.semana?.inicio && anterior.semana?.fim
    ? `${anterior.semana.inicio}_${anterior.semana.fim}`
    : '(sem semana)';
  const semanaNova = novo?.semana ? `${novo.semana.inicio}_${novo.semana.fim}` : '(sem semana)';
  linhas.push(`Semana: ${semanaAnterior} → ${semanaNova}`);
  for (const chave of PRODUTOS) {
    const antes = anterior.brasil?.[chave]?.media;
    const depois = novo.brasil?.[chave]?.media;
    if (antes === undefined && depois === undefined) continue;
    if (antes === undefined || depois === undefined) {
      linhas.push(`${ROTULOS[chave]}: ${formatarNumero(antes)} → ${formatarNumero(depois)}`);
      continue;
    }
    const diferenca = depois - antes;
    const sinal = diferenca === 0 ? 'igual' : `${diferenca > 0 ? '+' : ''}${formatarNumero(diferenca)}`;
    linhas.push(`${ROTULOS[chave]}: ${formatarNumero(antes)} → ${formatarNumero(depois)} (${sinal})`);
  }
  const ufsAntes = Object.keys(anterior.estados ?? {});
  const ufsDepois = Object.keys(novo.estados ?? {});
  const alteradas = ufsDepois.filter(
    (uf) =>
      anterior.estados?.[uf]?.gasolinaComum !== novo.estados?.[uf]?.gasolinaComum ||
      anterior.estados?.[uf]?.etanol !== novo.estados?.[uf]?.etanol,
  );
  linhas.push(
    `Estados: ${ufsAntes.length} → ${ufsDepois.length} UFs (${alteradas.length} com preço alterado)`,
  );
  return linhas;
}

function imprimirResumo(precos) {
  log(`Semana: ${formatarDataBR(precos.semana.inicio)} (${diaDaSemana(precos.semana.inicio)}) a ${formatarDataBR(precos.semana.fim)} (${diaDaSemana(precos.semana.fim)})`);
  log('BRASIL (médias nacionais de revenda):');
  for (const chave of PRODUTOS) {
    const item = precos.brasil[chave];
    if (!item) continue;
    log(
      `  ${ROTULOS[chave]}: R$ ${formatarNumero(item.media)} (mín ${formatarNumero(item.min)} / máx ${formatarNumero(item.max)}; ${item.postos.toLocaleString('pt-BR')} postos)`,
    );
  }
  log(`Estados: ${Object.keys(precos.estados).length} UFs`);
}

// ---------------------------------------------------------------------------
// Rede e E/S
// ---------------------------------------------------------------------------

const AGENTE = 'AbasteceCerto/2.0 (script de atualização de preços; sem dependências)';

/** Baixa uma URL com timeout e até 3 tentativas. */
export async function baixar(url, { tentativas = 3, timeoutMs = 60_000 } = {}) {
  const erros = [];
  for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
    try {
      const resposta = await fetch(url, {
        headers: { 'user-agent': AGENTE, accept: '*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resposta.ok) {
        throw new Error(`HTTP ${resposta.status} ${resposta.statusText}`.trim());
      }
      const buffer = Buffer.from(await resposta.arrayBuffer());
      if (buffer.length === 0) throw new Error('resposta vazia');
      return { url: resposta.url || url, buffer, tipo: resposta.headers.get('content-type') ?? '' };
    } catch (erro) {
      erros.push(`tentativa ${tentativa}: ${erro.message}`);
      if (tentativa < tentativas) await new Promise((resolver) => setTimeout(resolver, 1500 * tentativa));
    }
  }
  throw new Error(`falha ao baixar ${url}\n  ${erros.join('\n  ')}`);
}

function gravarAtomico(caminho, conteudo) {
  const diretorio = dirname(caminho);
  if (!existsSync(diretorio)) mkdirSync(diretorio, { recursive: true });
  const temporario = `${caminho}.tmp-${process.pid}`;
  writeFileSync(temporario, conteudo, 'utf8');
  try {
    renameSync(temporario, caminho);
  } catch (erro) {
    throw new Error(`não foi possível gravar ${caminho}: ${erro.message}`);
  }
}

function lerJsonSeExistir(caminho) {
  if (!existsSync(caminho)) return null;
  try {
    return JSON.parse(readFileSync(caminho, 'utf8'));
  } catch {
    aviso(`o ${basename(caminho)} existente não é JSON válido; será substituído sem comparação`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Interpreta os argumentos da linha de comando. */
export function parsearArgumentos(argv = []) {
  const opcoes = { arquivo: null, saida: null, semana: null, dryRun: false, ajuda: false };
  for (let i = 0; i < argv.length; i++) {
    const argumento = String(argv[i]);
    const nome = argumento.startsWith('--') && argumento.includes('=') ? argumento.slice(0, argumento.indexOf('=')) : argumento;
    const valorInline = argumento.startsWith('--') && argumento.includes('=')
      ? argumento.slice(argumento.indexOf('=') + 1)
      : null;
    const lerValor = () => {
      if (valorInline !== null) return valorInline;
      const proximo = argv[++i];
      if (proximo === undefined || String(proximo).startsWith('--')) {
        throw new Error(`faltou valor para ${nome}`);
      }
      return String(proximo);
    };
    switch (nome) {
      case '--file':
      case '-f':
        opcoes.arquivo = lerValor();
        break;
      case '--out':
      case '-o':
        opcoes.saida = lerValor();
        break;
      case '--semana':
        opcoes.semana = lerValor();
        break;
      case '--dry-run':
        opcoes.dryRun = true;
        break;
      case '--help':
      case '-h':
        opcoes.ajuda = true;
        break;
      default:
        throw new Error(`argumento desconhecido: ${argumento}\n\n${USO}`);
    }
  }
  if (opcoes.semana) normalizarSemana(opcoes.semana); // falha cedo e com mensagem clara
  return opcoes;
}

/** `true` quando o módulo foi chamado como script (`node tools/update-prices.mjs`). */
export function executadoDiretamente(argv1 = process.argv[1], urlModulo = import.meta.url) {
  if (!argv1) return false;
  try {
    return pathToFileURL(resolve(argv1)).href === urlModulo;
  } catch {
    return false;
  }
}

function urlDoArquivoLocal(caminho) {
  const semana = extrairSemanaDoNome(basename(caminho));
  if (semana) {
    try {
      return urlCanonicaDaSemana(semana);
    } catch {
      // semana estranha no nome: cai para file://
    }
  }
  return pathToFileURL(resolve(caminho)).href;
}

async function executar() {
  const opcoes = parsearArgumentos(process.argv.slice(2));
  if (opcoes.ajuda) {
    console.log(USO);
    return;
  }

  let url;
  let buffer;
  let nomeArquivo;

  if (opcoes.arquivo) {
    const caminho = resolve(opcoes.arquivo);
    if (!existsSync(caminho)) throw new Error(`arquivo não encontrado: ${caminho}`);
    buffer = readFileSync(caminho);
    nomeArquivo = basename(caminho);
    url = urlDoArquivoLocal(caminho);
    log(`usando arquivo local: ${caminho} (${formatarTamanho(buffer.length)})`);
  } else {
    log('baixando a página da ANP...');
    const pagina = await baixar(PAGINA_LPC);
    log(`página baixada (${formatarTamanho(pagina.buffer.length)}); procurando o resumo semanal...`);
    const html = pagina.buffer.toString('utf8');

    let link;
    if (opcoes.semana) {
      const alvo = normalizarSemana(opcoes.semana);
      link = escolherLinkDaSemana(html, alvo);
      if (!link) {
        const canonica = urlCanonicaDaSemana(alvo);
        aviso(`a semana ${alvo.chave} não está listada na página; tentando a URL canônica ${canonica}`);
        link = { url: canonica, semana: alvo, arquivo: basename(canonica) };
      }
    } else {
      link = escolherLinkMaisRecente(html);
      log(`semana mais recente listada: ${link.semana.inicio} a ${link.semana.fim}`);
    }

    log(`baixando o XLSX: ${link.url}`);
    const xlsx = await baixar(link.url);
    buffer = xlsx.buffer;
    url = xlsx.url || link.url;
    nomeArquivo = link.arquivo ?? basename(new URL(url).pathname);
    log(`XLSX baixado (${formatarTamanho(buffer.length)})`);
  }

  log('descompactando o XLSX e lendo o XML...');
  const extraido = extrairPrecosDoArquivo(buffer);
  log(`abas de planilha encontradas: ${extraido.abas.join(', ')}`);
  for (const mensagem of extraido.avisos) aviso(mensagem);

  const semanaDoNome = extrairSemanaDoNome(nomeArquivo);
  let semana;
  if (opcoes.semana) {
    semana = normalizarSemana(opcoes.semana);
    if (extraido.semana && extraido.semana.chave !== semana.chave) {
      aviso(
        `--semana forçada (${semana.chave}) difere das datas dentro do arquivo (${extraido.semana.chave}); usando a semana forçada`,
      );
    }
  } else if (extraido.semana) {
    semana = extraido.semana;
    if (semanaDoNome && semanaDoNome.inicio !== semana.inicio) {
      aviso(
        `semana do nome do arquivo (${semanaDoNome.inicio}_${semanaDoNome.fim}) difere das datas dentro da planilha (${semana.chave}); usando as datas da planilha`,
      );
    }
  } else if (semanaDoNome) {
    semana = normalizarSemana(`${semanaDoNome.inicio}_${semanaDoNome.fim}`);
    log(`aviso: a planilha não traz datas nas células; usando a semana do nome do arquivo (${semana.chave})`);
  } else {
    throw new Error('não foi possível determinar a semana (nem pelas células, nem pelo nome do arquivo); use --semana');
  }

  const caminhoSaida = resolve(opcoes.saida ?? CAMINHO_PADRAO);
  const anterior = lerJsonSeExistir(caminhoSaida);

  const precos = montarPrecos({
    url,
    semana,
    brasil: extraido.brasil,
    estados: extraido.estados,
  });

  const validacao = validarPrecos(precos);
  if (!validacao.ok) {
    throw new Error(`precos.json inválido, nada foi gravado:\n - ${validacao.erros.join('\n - ')}`);
  }

  // Dados idênticos aos da versão anterior: mantém o "atualizadoEm" antigo para
  // o arquivo sair byte a byte igual (a Action usa `git diff` para decidir se commita).
  if (anterior && mesmosDados(anterior, precos)) {
    const anteriorValido = Date.parse(anterior.atualizadoEm);
    if (!Number.isNaN(anteriorValido)) {
      precos.atualizadoEm = new Date(anteriorValido).toISOString();
    }
    log('dados idênticos aos da versão anterior: mantendo o "atualizadoEm" e o arquivo sem mudança');
  }

  imprimirResumo(precos);

  log('diferença em relação à versão anterior:');
  for (const linha of resumirDiferenca(anterior, precos)) log(`  ${linha}`);

  const json = `${JSON.stringify(precos, null, 2)}\n`;
  if (opcoes.dryRun) {
    log(`--dry-run: ${formatarTamanho(Buffer.byteLength(json))} de JSON gerados; nada foi gravado`);
    process.stdout.write(json);
    return;
  }

  gravarAtomico(caminhoSaida, json);
  log(`gravado ${caminhoSaida} (${formatarTamanho(Buffer.byteLength(json))})`);
}

if (executadoDiretamente()) {
  executar().catch((erro) => {
    console.error(`\nprecos: erro: ${erro.message}`);
    process.exitCode = 1;
  });
}
