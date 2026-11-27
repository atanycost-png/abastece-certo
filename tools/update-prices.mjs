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

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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

/** Diretório dos preços por posto (um JSON compacto por UF). */
export const DIRETORIO_POSTOS = join(RAIZ, 'postos');

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
  --sem-postos                não gera os arquivos postos/UF.json (só médias)
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
  // A ANP já publicou em vários formatos: 2026-10-04_2026-10-10 (antigo),
  // 2026-10-11-2026-10-17 e 2026_11_15_2026-11-21 (misto, a partir de out/2026).
  // Aceitamos "-" ou "_" entre qualquer parte da data.
  const casa = /resumo_semanal_lpc_(\d{4})[-_](\d{1,2})[-_](\d{1,2})[-_](\d{4})[-_](\d{1,2})[-_](\d{1,2})\.xlsx/i.exec(
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

/** Últimas semanas completas (domingo–sábado), da mais recente para a mais antiga. */
export function semanasRecentes(agora = new Date(), quantidade = 4) {
  const base = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate()));
  const diaSemana = base.getUTCDay(); // 0 = domingo … 6 = sábado
  const diasAteSabado = (diaSemana - 6 + 7) % 7;
  const sabado = new Date(base.getTime() - diasAteSabado * 86_400_000);
  const semanas = [];
  for (let i = 0; i < quantidade; i++) {
    const fim = new Date(sabado.getTime() - i * 7 * 86_400_000);
    const inicio = new Date(fim.getTime() - 6 * 86_400_000);
    semanas.push(`${inicio.toISOString().slice(0, 10)}_${fim.toISOString().slice(0, 10)}`);
  }
  return semanas;
}

/**
 * URLs candidatas para o XLSX de uma semana, em ordem de tentativa.
 * A ANP já publicou com "-", com "_" e com os dois misturados; como o padrão
 * muda sem aviso, tentamos as combinações conhecidas.
 */
export function urlsCandidatasDaSemana(semana) {
  const { inicio, fim } = normalizarSemana(typeof semana === 'string' ? semana : `${semana.inicio}_${semana.fim}`);
  const a = inicio.replaceAll('-', '_');
  const b = fim.replaceAll('-', '_');
  const base = `${BASE_ARQUIVOS_LPC}/${inicio.slice(0, 4)}`;
  return [
    ...new Set([
      `${base}/resumo_semanal_lpc_${a}_${fim}.xlsx`, // 2026_11_15_2026-11-21 (misto, visto em nov/2026)
      `${base}/resumo_semanal_lpc_${a}-${fim}.xlsx`, // 2026_11_08-2026_11_14
      `${base}/resumo_semanal_lpc_${a}_${b}.xlsx`, // 2026_11_15_2026_11_21
      `${base}/resumo_semanal_lpc_${inicio}_${fim}.xlsx`, // formato antigo: 2026-10-04_2026-10-10
    ]),
  ];
}

/**
 * Fallback quando a página da ANP não responde: tenta baixar diretamente o
 * XLSX da semana mais recente pelas URLs canônicas conhecidas.
 */
export async function baixarSemanaRecente({
  agora = new Date(),
  quantidade = 4,
  baixarFn = baixar,
  userAgent = AGENTE_NAVEGADOR,
} = {}) {
  const erros = [];
  for (const semana of semanasRecentes(agora, quantidade)) {
    for (const url of urlsCandidatasDaSemana(semana)) {
      try {
        const resposta = await baixarFn(url, { tentativas: 1, timeoutMs: 45_000, userAgent });
        const arquivo = basename(new URL(url).pathname);
        if (!extrairSemanaDoNome(arquivo)) continue;
        return { url: resposta.url || url, buffer: resposta.buffer, arquivo, semana };
      } catch (erro) {
        erros.push(`${semana}: ${erro.message.split('\n')[0]}`);
      }
    }
  }
  throw new Error(`nenhuma semana recente pôde ser baixada (${erros.slice(-4).join(' | ')})`);
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

/**
 * Extrai as médias por município da aba MUNICIPIOS (gasolina comum e etanol).
 * A amostra semanal do LPC traz alguns milhares de municípios; guardamos só esses
 * dois produtos para o JSON continuar leve.
 *
 * @returns {{ municipios: Record<string, Record<string, {gasolinaComum?: number, etanol?: number}>>, semana: object|null, avisos: string[] }}
 */
export function extrairMunicipios(linhas) {
  const { indice, colunas } = encontrarCabecalho(linhas);
  if (!colunas.municipio || !colunas.estado) {
    throw new Error('aba MUNICIPIOS sem colunas de estado/município');
  }
  const dados = linhas.slice(indice + 1);
  const { semana } = semanaDeLinhas(dados, colunas);
  const avisos = [];
  const porUf = new Map();
  const naoReconhecidos = new Set();

  for (const linha of dados) {
    const chave = normalizarProduto(valorDaCelula(linha, colunas.produto));
    if (!chave || chave === 'gasolinaAditivada') continue;
    const uf = estadoParaUF(valorDaCelula(linha, colunas.estado));
    const municipio = String(valorDaCelula(linha, colunas.municipio) ?? '').replace(/\s+/g, ' ').trim();
    if (!uf || !municipio) {
      const bruto = valorDaCelula(linha, colunas.estado);
      if (bruto && !uf) naoReconhecidos.add(String(bruto));
      continue;
    }
    const media = parseNumeroPtBr(valorDaCelula(linha, colunas.media));
    if (media === null) {
      avisos.push(`linha ${linha.numero} da aba MUNICIPIOS (${uf}/${municipio}/${chave}) sem preço médio; ignorada`);
      continue;
    }
    if (!porUf.has(uf)) porUf.set(uf, new Map());
    const cidades = porUf.get(uf);
    if (!cidades.has(municipio)) cidades.set(municipio, {});
    const item = cidades.get(municipio);
    if (item[chave] !== undefined) {
      avisos.push(`${uf}/${municipio}/${chave} aparece mais de uma vez na aba MUNICIPIOS; mantendo o primeiro valor`);
      continue;
    }
    item[chave] = arredondar2(media);
  }

  if (naoReconhecidos.size) {
    avisos.push(`estados não reconhecidos na aba MUNICIPIOS: ${[...naoReconhecidos].join(', ')}`);
  }
  if (porUf.size === 0) {
    throw new Error('aba MUNICIPIOS sem nenhum município reconhecido; arquivo inesperado, nada será gravado');
  }

  const ordenado = {};
  for (const uf of [...porUf.keys()].sort()) {
    const cidades = porUf.get(uf);
    const saida = {};
    for (const nome of [...cidades.keys()].sort((a, b) => a.localeCompare(b, 'pt-BR'))) {
      const item = cidades.get(nome);
      const preco = {};
      if (item.gasolinaComum !== undefined) preco.gasolinaComum = item.gasolinaComum;
      if (item.etanol !== undefined) preco.etanol = item.etanol;
      if (Object.keys(preco).length) saida[nome] = preco;
    }
    if (Object.keys(saida).length) ordenado[uf] = saida;
  }
  return { municipios: ordenado, semana, avisos };
}

// ---------------------------------------------------------------------------
// Nomes de municípios (IBGE): a ANP escreve em CAIXA ALTA e sem acento
// ---------------------------------------------------------------------------

/** Endpoint público do IBGE com os municípios de uma UF. */
export function ibgeMunicipiosUrl(uf) {
  return `https://servicodados.ibge.gov.br/api/v1/localidades/estados/${encodeURIComponent(uf)}/municipios`;
}

/** Converte "SAO PAULO" em "São Paulo" quando o IBGE conhece o nome. */
export function tituloCidade(nome) {
  const minusculas = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'd']);
  return String(nome ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((palavra, indice) => {
      if (indice > 0 && minusculas.has(palavra)) return palavra;
      return palavra.charAt(0).toUpperCase() + palavra.slice(1);
    })
    .join(' ');
}

/**
 * Baixa a lista oficial de municípios por UF no IBGE e devolve um mapa
 * `"UF|NOME NORMALIZADO" -> "Nome Correto"`. Falhas são só avisos: sem IBGE,
 * `aplicarNomesIBGE` usa `tituloCidade`.
 */
export async function baixarNomesIBGE(baixarFn = baixar) {
  const mapa = new Map();
  const ufs = [...UFS_VALIDAS].sort();
  for (const uf of ufs) {
    try {
      const resposta = await baixarFn(ibgeMunicipiosUrl(uf), {
        tentativas: 2,
        timeoutMs: 20_000,
        userAgent: AGENTE_NAVEGADOR,
      });
      const lista = JSON.parse(resposta.buffer.toString('utf8'));
      if (!Array.isArray(lista)) continue;
      for (const item of lista) {
        if (item && typeof item.nome === 'string') {
          mapa.set(`${uf}|${normalizarTexto(item.nome)}`, item.nome);
        }
      }
    } catch (erro) {
      aviso(`IBGE indisponível para ${uf}: ${erro.message}`);
    }
  }
  return mapa;
}

/** Aplica os nomes do IBGE (ou title case) no bloco de municípios. */
export function aplicarNomesIBGE(municipios, mapa) {
  const saida = {};
  for (const uf of Object.keys(municipios ?? {}).sort()) {
    const cidades = {};
    for (const nome of Object.keys(municipios[uf]).sort((a, b) => a.localeCompare(b, 'pt-BR'))) {
      const chave = `${uf}|${normalizarTexto(nome)}`;
      const correto = mapa && mapa.get(chave);
      cidades[correto || tituloCidade(nome)] = municipios[uf][nome];
    }
    saida[uf] = cidades;
  }
  return saida;
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
      if (tipo === 'municipios' && colunas.estado && colunas.municipio) return caminho;
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
  const caminhoMunicipios = abas?.get('MUNICIPIOS') ?? detectarAba(zip, shared, 'municipios');
  if (!caminhoBrasil) throw new Error('aba BRASIL não encontrada no XLSX');
  if (!caminhoEstados) throw new Error('aba ESTADOS não encontrada no XLSX');

  const linhasBrasil = parsearLinhasPlanilha(zip.ler(caminhoBrasil).toString('utf8'), shared);
  const linhasEstados = parsearLinhasPlanilha(zip.ler(caminhoEstados).toString('utf8'), shared);
  const brasil = extrairBrasil(linhasBrasil);
  const estados = extrairEstados(linhasEstados);

  let municipios = { municipios: {}, semana: null, avisos: [] };
  if (caminhoMunicipios) {
    try {
      const linhasMunicipios = parsearLinhasPlanilha(zip.ler(caminhoMunicipios).toString('utf8'), shared);
      municipios = extrairMunicipios(linhasMunicipios);
    } catch (erro) {
      aviso(`não foi possível ler a aba MUNICIPIOS: ${erro.message}; o JSON sairá só com Brasil/UF`);
    }
  } else {
    aviso('aba MUNICIPIOS não encontrada no XLSX; o JSON sairá só com Brasil/UF');
  }

  const avisos = [...brasil.avisos, ...estados.avisos, ...municipios.avisos];
  if (brasil.semana && estados.semana && brasil.semana.chave !== estados.semana.chave) {
    avisos.push(
      `semana da aba BRASIL (${brasil.semana.chave}) difere da aba ESTADOS (${estados.semana.chave}); usando a do BRASIL`,
    );
  }
  if (brasil.semana && municipios.semana && brasil.semana.chave !== municipios.semana.chave) {
    avisos.push(
      `semana da aba BRASIL (${brasil.semana.chave}) difere da aba MUNICIPIOS (${municipios.semana.chave}); usando a do BRASIL`,
    );
  }

  return {
    brasil: brasil.brasil,
    estados: estados.estados,
    municipios: municipios.municipios,
    semana: brasil.semana ?? estados.semana ?? municipios.semana ?? null,
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
/**
 * Mantém o histórico das últimas semanas (Brasil + UFs) para o app mostrar a
 * tendência ("gasolina subiu R$ 0,07"). Não é histórico municipal: é compacto.
 */
export function atualizarHistorico(anterior = [], semana, brasil = {}, estados = {}, maximo = 8) {
  const semanaNormalizada = typeof semana === 'string' ? normalizarSemana(semana) : semana;
  if (!semanaNormalizada?.inicio || !semanaNormalizada?.fim) {
    throw new Error('atualizarHistorico: semana ausente ou inválida');
  }
  const chave = `${semanaNormalizada.inicio}_${semanaNormalizada.fim}`;
  const base = Array.isArray(anterior)
    ? anterior.filter((h) => h && typeof h === 'object' && /^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/.test(String(h.semana)))
    : [];
  const entrada = {
    semana: chave,
    brasil: {
      gasolina: arredondar2(brasil?.gasolinaComum?.media),
      aditivada: arredondar2(brasil?.gasolinaAditivada?.media),
      etanol: arredondar2(brasil?.etanol?.media),
    },
    estados: {},
  };
  for (const uf of Object.keys(estados ?? {}).sort()) {
    const g = arredondar2(estados[uf]?.gasolinaComum);
    const e = arredondar2(estados[uf]?.etanol);
    if (g !== null && e !== null) entrada.estados[uf] = { gasolina: g, etanol: e };
  }
  const semDuplicata = base.filter((h) => h.semana !== chave);
  return [...semDuplicata, entrada]
    .sort((a, b) => a.semana.localeCompare(b.semana))
    .slice(-Math.max(1, maximo));
}

export function montarPrecos({ url, semana, brasil, estados, municipios, atualizadoEm, historico } = {}) {
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

  // Municípios em formato compacto: "Cidade": [gasolina, etanol] (null quando falta).
  const municipiosSaida = {};
  for (const uf of Object.keys(municipios ?? {}).sort()) {
    const cidades = {};
    const nomes = Object.keys(municipios[uf] ?? {}).sort((a, b) => a.localeCompare(b, 'pt-BR'));
    for (const nome of nomes) {
      const item = municipios[uf][nome] ?? {};
      const gasolina = arredondar2(item.gasolinaComum);
      const etanol = arredondar2(item.etanol);
      if (gasolina === null && etanol === null) continue;
      cidades[nome] = [gasolina, etanol];
    }
    if (Object.keys(cidades).length) municipiosSaida[uf] = cidades;
  }

  const saida = {
    fonte: FONTE,
    url,
    semana: { inicio: semanaNormalizada.inicio, fim: semanaNormalizada.fim },
    atualizadoEm: dataAtualizacao.toISOString(),
    brasil: brasilSaida,
    estados: estadosSaida,
  };
  if (Object.keys(municipiosSaida).length) saida.municipios = municipiosSaida;
  if (Array.isArray(historico) && historico.length) saida.historico = historico;
  return saida;
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

  if (precos.municipios !== undefined) {
    erros.push(...validarMunicipios(precos.municipios));
  }

  if (precos.historico !== undefined) {
    erros.push(...validarHistorico(precos.historico));
    if (Array.isArray(precos.historico) && precos.historico.length && precos.semana) {
      const esperado = `${precos.semana.inicio}_${precos.semana.fim}`;
      const ultima = precos.historico[precos.historico.length - 1];
      if (ultima?.semana !== esperado) {
        erros.push(`historico: a última entrada deveria ser ${esperado}`);
      }
    }
  }

  return { ok: erros.length === 0, erros };
}

/**
 * Valida o bloco opcional `municipios` (`UF -> { Cidade: [gasolina, etanol] }`).
 * Cada item é `[gasolina, etanol]` com número plausível ou `null`.
 */
function validarMunicipios(municipios) {
  const erros = [];
  if (!municipios || typeof municipios !== 'object' || Array.isArray(municipios)) {
    return ['campo "municipios" deveria ser um objeto'];
  }
  let total = 0;
  for (const uf of Object.keys(municipios)) {
    if (!/^[A-Z]{2}$/.test(uf) || !UFS_VALIDAS.has(uf)) {
      erros.push(`municipios: UF inválida "${uf}"`);
      continue;
    }
    const cidades = municipios[uf];
    if (!cidades || typeof cidades !== 'object' || Array.isArray(cidades)) {
      erros.push(`municipios.${uf} deveria ser um objeto de cidades`);
      continue;
    }
    for (const nome of Object.keys(cidades)) {
      total++;
      const limpo = String(nome).replace(/\s+/g, ' ').trim();
      if (!limpo || limpo.length > 80 || /[\u0000-\u001f]/.test(limpo)) {
        erros.push(`municipios.${uf}: nome de cidade inválido (${JSON.stringify(nome)})`);
        continue;
      }
      const precos = cidades[nome];
      if (!Array.isArray(precos) || precos.length !== 2) {
        erros.push(`municipios.${uf}.${nome}: esperado [gasolina, etanol]`);
        continue;
      }
      if (precos[0] === null && precos[1] === null) {
        erros.push(`municipios.${uf}.${nome}: sem nenhum preço`);
        continue;
      }
      const faixas = [FAIXAS.gasolinaComum, FAIXAS.etanol];
      for (let i = 0; i < 2; i++) {
        const valor = precos[i];
        if (valor === null) continue;
        if (!numeroPlausivel(valor, faixas[i])) {
          erros.push(
            `municipios.${uf}.${nome}[${i}] fora da faixa plausível (${faixas[i].min}–${faixas[i].max}): ${valor}`,
          );
        }
      }
    }
  }
  if (total === 0) erros.push('campo "municipios" vazio');
  if (total > 6000) erros.push(`campo "municipios" com ${total} cidades (esperado <= 6000)`);
  return erros;
}

/** Valida o bloco opcional `historico` (últimas 8 semanas: Brasil + UFs). */
function validarHistorico(historico) {
  const erros = [];
  if (!Array.isArray(historico)) return ['campo "historico" deveria ser uma lista'];
  if (historico.length === 0) return ['campo "historico" vazio'];
  if (historico.length > 8) erros.push(`campo "historico" com ${historico.length} semanas (esperado <= 8)`);
  const semanaValida = /^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/;
  for (const item of historico) {
    if (!item || typeof item !== 'object') {
      erros.push('historico: item não é objeto');
      continue;
    }
    if (!semanaValida.test(String(item.semana))) {
      erros.push(`historico: semana inválida "${item.semana}"`);
      continue;
    }
    if (!item.brasil || typeof item.brasil !== 'object') {
      erros.push(`historico.${item.semana}: brasil ausente`);
      continue;
    }
    for (const [chave, faixa] of [
      ['gasolina', FAIXAS.gasolinaComum],
      ['aditivada', FAIXAS.gasolinaAditivada],
      ['etanol', FAIXAS.etanol],
    ]) {
      if (item.brasil[chave] === null || item.brasil[chave] === undefined) continue;
      if (!numeroPlausivel(item.brasil[chave], faixa)) {
        erros.push(`historico.${item.semana}.brasil.${chave} fora da faixa: ${item.brasil[chave]}`);
      }
    }
    if (item.estados === undefined) continue;
    if (!item.estados || typeof item.estados !== 'object' || Array.isArray(item.estados)) {
      erros.push(`historico.${item.semana}: estados deveria ser objeto`);
      continue;
    }
    for (const uf of Object.keys(item.estados)) {
      if (!/^[A-Z]{2}$/.test(uf) || !UFS_VALIDAS.has(uf)) {
        erros.push(`historico.${item.semana}: UF inválida "${uf}"`);
        continue;
      }
      const precos = item.estados[uf];
      if (!precos || typeof precos !== 'object') {
        erros.push(`historico.${item.semana}.${uf}: inválido`);
        continue;
      }
      for (const [chave, faixa] of [
        ['gasolina', FAIXAS.gasolinaComum],
        ['etanol', FAIXAS.etanol],
      ]) {
        if (precos[chave] === undefined || precos[chave] === null) continue;
        if (!numeroPlausivel(precos[chave], faixa)) {
          erros.push(`historico.${item.semana}.${uf}.${chave} fora da faixa: ${precos[chave]}`);
        }
      }
    }
  }
  return erros;
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
  if (JSON.stringify(anterior.municipios ?? {}) !== JSON.stringify(novo.municipios ?? {})) return false;
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
  if (precos.municipios) {
    let total = 0;
    let completos = 0;
    for (const uf of Object.keys(precos.municipios)) {
      for (const nome of Object.keys(precos.municipios[uf])) {
        total++;
        const [gas, eta] = precos.municipios[uf][nome];
        if (gas !== null && eta !== null) completos++;
      }
    }
    log(`Municípios: ${total} (${completos} com gasolina e etanol) em ${Object.keys(precos.municipios).length} UFs`);
  }
}

// ---------------------------------------------------------------------------
// Preços por posto (revendas_lpc_*.xlsx) — base da v5
// ---------------------------------------------------------------------------

/** Extrai a semana do nome de qualquer planilha da LPC (resumo ou revendas). */
export function extrairSemanaDoArquivo(nome) {
  const casa = /(?:resumo_semanal_lpc|revendas_lpc)_(\d{4})[-_](\d{1,2})[-_](\d{1,2})[-_](\d{4})[-_](\d{1,2})[-_](\d{1,2})\.xlsx/i.exec(
    String(nome ?? ''),
  );
  if (!casa) return null;
  const pad = (valor) => String(Number(valor)).padStart(2, '0');
  return {
    inicio: `${casa[1]}-${pad(casa[2])}-${pad(casa[3])}`,
    fim: `${casa[4]}-${pad(casa[5])}-${pad(casa[6])}`,
  };
}

/** Lista os links de revendas_lpc_*.xlsx presentes no HTML da ANP. */
export function listarLinksRevendas(html, baseUrl = PAGINA_LPC) {
  if (typeof html !== 'string' || !html.trim()) {
    throw new Error('HTML da página da ANP vazio ou inválido');
  }
  const porUrl = new Map();
  const padrao = /(?:href\s*=\s*["']([^"']*revendas_lpc_[^"']+\.xlsx)["'])|((?:https?:)?\/\/[^\s"'<>]*revendas_lpc_[^\s"'<>]+\.xlsx)/gi;
  for (const casa of html.matchAll(padrao)) {
    const bruto = (casa[1] ?? casa[2] ?? '').replace(/&amp;/g, '&').trim();
    if (!bruto) continue;
    const arquivo = /revendas_lpc_[\d\-_]+\.xlsx/i.exec(bruto)?.[0];
    const semana = extrairSemanaDoArquivo(arquivo ?? bruto);
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
  return [...porUrl.values()].sort(compararSemanas);
}

export function escolherLinkRevendasDaSemana(html, semana, baseUrl = PAGINA_LPC) {
  const alvo = typeof semana === 'string' ? normalizarSemana(semana) : semana;
  return (
    listarLinksRevendas(html, baseUrl).find(
      (link) => link.semana.inicio === alvo.inicio && link.semana.fim === alvo.fim,
    ) ?? null
  );
}

/** URLs canônicas do XLSX de revendas de uma semana (para quando a página falha). */
export function urlsRevendasDaSemana(semana) {
  const { inicio, fim } = normalizarSemana(typeof semana === 'string' ? semana : `${semana.inicio}_${semana.fim}`);
  const a = inicio.replaceAll('-', '_');
  const base = `${BASE_ARQUIVOS_LPC}/${inicio.slice(0, 4)}`;
  return [
    ...new Set([
      `${base}/revendas_lpc_${a}-${fim}.xlsx`,
      `${base}/revendas_lpc_${inicio}_${fim}.xlsx`,
    ]),
  ];
}

/**
 * Extrai os postos de uma planilha de revendas já parseada em linhas.
 * Cada posto vira `{ cnpj, name, brand, city, uf, address, gas, eta }`.
 */
export function extrairPostosDeLinhas(linhas) {
  if (!Array.isArray(linhas) || !linhas.length) return { postos: [], avisos: ['planilha vazia'], produtos: [] };
  const avisos = [];
  let cabecalho = null;
  let colunas = null;
  for (let i = 0; i < Math.min(40, linhas.length); i++) {
    const linha = linhas[i];
    if (!linha || !linha.celulas) continue;
    const mapa = {};
    for (const [letra, celula] of linha.celulas) {
      const titulo = normalizarTexto(celula?.valor).toLowerCase();
      if (titulo) mapa[titulo] = letra;
    }
    if (mapa.cnpj && mapa.produto && mapa['preco de revenda']) {
      cabecalho = i;
      colunas = mapa;
      break;
    }
  }
  if (!colunas) return { postos: [], avisos: ['cabeçalho de revendas não encontrado'], produtos: [] };

  const valor = (linha, nome) => {
    const letra = colunas[nome];
    return letra ? linha.celulas.get(letra)?.valor ?? null : null;
  };
  const produtos = new Set();
  const porPosto = new Map();
  for (let i = cabecalho + 1; i < linhas.length; i++) {
    const linha = linhas[i];
    if (!linha || !linha.celulas) continue;
    const produtoBruto = String(valor(linha, 'produto') ?? '').trim();
    if (!produtoBruto) continue;
    const produto = normalizarTexto(produtoBruto).toLowerCase();
    produtos.add(produtoBruto.toUpperCase());
    const uf = estadoParaUF(String(valor(linha, 'estado') ?? ''));
    const cidade = String(valor(linha, 'municipio') ?? '').replace(/\s+/g, ' ').trim();
    const nome = String(valor(linha, 'fantasia') || valor(linha, 'razao') || '').replace(/\s+/g, ' ').trim();
    const cnpj = String(valor(linha, 'cnpj') ?? '').replace(/\D/g, '');
    if (!uf || !cidade || !nome) continue;
    const preco = parseNumeroPtBr(String(valor(linha, 'preco de revenda') ?? ''));
    if (!isFinite(preco) || preco <= 0) continue;
    const chave = cnpj || `${uf}|${normalizarTexto(cidade)}|${normalizarTexto(nome)}`;
    if (!porPosto.has(chave)) {
      const endereco = [valor(linha, 'endereco'), valor(linha, 'numero'), valor(linha, 'bairro')]
        .map((parte) => String(parte ?? '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(', ')
        .slice(0, 70);
      porPosto.set(chave, {
        cnpj,
        name: nome,
        brand: String(valor(linha, 'bandeira') ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
        city: cidade,
        uf,
        address: endereco,
        gas: null,
        eta: null,
      });
    }
    const posto = porPosto.get(chave);
    if (produto === 'gasolina comum' && preco >= 2 && preco <= 12) posto.gas = arredondar2(preco);
    if (produto === 'etanol' && preco >= 1 && preco <= 9) posto.eta = arredondar2(preco);
  }
  const postos = [...porPosto.values()].filter((posto) => posto.gas !== null || posto.eta !== null);
  if (!postos.length) avisos.push('nenhum posto com gasolina/etanol encontrado');
  return { postos, avisos, produtos: [...produtos] };
}

/** Lê o XLSX de revendas e delega a extração das linhas. */
export function extrairPostosDoArquivo(buffer) {
  const zip = abrirZip(buffer);
  const shared = parsearSharedStrings(lerTextoZip(zip, 'xl/sharedStrings.xml') || '');
  const abas = resolverAbas(zip);
  const caminhos = abas ? [...abas.values()] : zip.nomes.filter((nome) => /^xl\/worksheets\/sheet\d+\.xml$/.test(nome));
  for (const caminho of caminhos) {
    const resultado = extrairPostosDeLinhas(parsearLinhasPlanilha(zip.ler(caminho).toString('utf8'), shared));
    if (resultado.postos.length) return resultado;
  }
  return { postos: [], avisos: ['nenhuma aba de revendas reconhecida'], produtos: [] };
}

/** Agrupa os postos por UF com nomes em caixa normal (para exibição). */
export function agruparPostosPorUf(postos) {
  const porUf = {};
  for (const posto of postos ?? []) {
    if (!posto || !posto.uf) continue;
    if (!porUf[posto.uf]) porUf[posto.uf] = [];
    porUf[posto.uf].push([
      tituloCidade(posto.city),
      tituloCidade(posto.name),
      tituloCidade(posto.brand),
      posto.address,
      posto.gas,
      posto.eta,
    ]);
  }
  for (const uf of Object.keys(porUf)) {
    porUf[uf].sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1], 'pt-BR') : a[0].localeCompare(b[0], 'pt-BR')));
  }
  return porUf;
}

/** Monta o JSON compacto por UF (formato consumido pelo app). */
export function gerarPostosPorUf(postos, { url, semana, atualizadoEm } = {}) {
  const porUf = agruparPostosPorUf(postos);
  const semanaNormalizada = typeof semana === 'string' ? normalizarSemana(semana) : semana;
  const saida = {};
  for (const uf of Object.keys(porUf).sort()) {
    saida[uf] = {
      fonte: FONTE,
      url,
      semana: { inicio: semanaNormalizada.inicio, fim: semanaNormalizada.fim },
      atualizadoEm: new Date(atualizadoEm ?? Date.now()).toISOString(),
      uf,
      postos: porUf[uf],
    };
  }
  return saida;
}

/** Validação defensiva dos arquivos postos/UF.json. */
export function validarPostos(porUf) {
  const erros = [];
  if (!porUf || typeof porUf !== 'object') return { ok: false, erros: ['postos por UF não é objeto'] };
  const ufs = Object.keys(porUf);
  if (!ufs.length) erros.push('nenhuma UF gerada');
  for (const uf of ufs) {
    if (!/^[A-Z]{2}$/.test(uf) || !UFS_VALIDAS.has(uf)) {
      erros.push(`UF inválida: ${uf}`);
      continue;
    }
    const dados = porUf[uf];
    if (!dados || !Array.isArray(dados.postos) || !dados.postos.length) {
      erros.push(`postos.${uf} vazio`);
      continue;
    }
    if (dados.postos.length > 30000) erros.push(`postos.${uf} com itens demais`);
    for (const item of dados.postos) {
      if (!Array.isArray(item) || item.length !== 6) {
        erros.push(`postos.${uf}: item deveria ter [cidade, nome, bandeira, endereco, gasolina, etanol]`);
        break;
      }
      const gas = item[4];
      const eta = item[5];
      if (gas !== null && !numeroPlausivel(gas, FAIXAS.gasolinaComum)) {
        erros.push(`postos.${uf}: gasolina inválida ${gas}`);
        break;
      }
      if (eta !== null && !numeroPlausivel(eta, FAIXAS.etanol)) {
        erros.push(`postos.${uf}: etanol inválido ${eta}`);
        break;
      }
    }
  }
  return { ok: erros.length === 0, erros };
}

// ---------------------------------------------------------------------------
// Rede e E/S
// ---------------------------------------------------------------------------

const AGENTE = 'AbasteceCerto/2.0 (script de atualização de preços; sem dependências)';

/** O IBGE responde 400 para agentes "de script"; este UA simples resolve. */
const AGENTE_NAVEGADOR = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** Baixa uma URL com timeout e até 3 tentativas. */
export async function baixar(url, { tentativas = 3, timeoutMs = 60_000, userAgent = AGENTE } = {}) {
  const erros = [];
  for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
    try {
      const resposta = await fetch(url, {
        headers: {
          'user-agent': userAgent,
          accept: '*/*',
          'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8',
        },
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

/** Grava um JSON compacto por UF em postos/ e remove UFs que não existem mais. */
function gravarPostos(porUf, diretorio) {
  const arquivos = {};
  let bytes = 0;
  for (const uf of Object.keys(porUf)) {
    const json = JSON.stringify(porUf[uf]);
    arquivos[`${uf}.json`] = json;
    bytes += Buffer.byteLength(json);
  }
  if (!existsSync(diretorio)) mkdirSync(diretorio, { recursive: true });
  for (const [nome, json] of Object.entries(arquivos)) {
    gravarAtomico(join(diretorio, nome), `${json}\n`);
  }
  for (const nome of readdirSync(diretorio)) {
    if (!nome.endsWith(".json")) continue;
    if (!arquivos[nome]) {
      try {
        unlinkSync(join(diretorio, nome));
      } catch {
        // arquivo em uso: deixa para a próxima execução
      }
    }
  }
  return { arquivos: Object.keys(arquivos).length, bytes };
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
  const opcoes = { arquivo: null, saida: null, semana: null, dryRun: false, semPostos: false, ajuda: false };
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
      case '--sem-postos':
        opcoes.semPostos = true;
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
  let paginaHtml = "";

  if (opcoes.arquivo) {
    const caminho = resolve(opcoes.arquivo);
    if (!existsSync(caminho)) throw new Error(`arquivo não encontrado: ${caminho}`);
    buffer = readFileSync(caminho);
    nomeArquivo = basename(caminho);
    url = urlDoArquivoLocal(caminho);
    log(`usando arquivo local: ${caminho} (${formatarTamanho(buffer.length)})`);
  } else {
    let pagina = null;
    try {
      log('baixando a página da ANP...');
      pagina = await baixar(PAGINA_LPC, { userAgent: AGENTE_NAVEGADOR });
      log(`página baixada (${formatarTamanho(pagina.buffer.length)}); procurando o resumo semanal...`);
    } catch (erro) {
      aviso(
        `página da ANP indisponível (${erro.message.split('\n')[0]}); tentando as URLs canônicas das últimas semanas`,
      );
    }

    if (pagina) {
      const html = pagina.buffer.toString('utf8');
      paginaHtml = html;

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
      const xlsx = await baixar(link.url, { userAgent: AGENTE_NAVEGADOR });
      buffer = xlsx.buffer;
      url = xlsx.url || link.url;
      nomeArquivo = link.arquivo ?? basename(new URL(url).pathname);
      log(`XLSX baixado (${formatarTamanho(buffer.length)})`);
    } else {
      const alternativa = await baixarSemanaRecente();
      buffer = alternativa.buffer;
      url = alternativa.url;
      nomeArquivo = alternativa.arquivo;
      log(`XLSX obtido pela URL canônica: ${url} (${formatarTamanho(buffer.length)})`);
    }
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
  const historico = atualizarHistorico(anterior?.historico, semana, extraido.brasil, extraido.estados);

  let municipios = extraido.municipios ?? {};
  if (Object.keys(municipios).length) {
    log('buscando nomes de municípios no IBGE (para acentos e grafia correta)...');
    const nomes = await baixarNomesIBGE();
    if (nomes.size) log(`nomes do IBGE carregados: ${nomes.size}`);
    municipios = aplicarNomesIBGE(municipios, nomes);
  }

  const precos = montarPrecos({
    url,
    semana,
    brasil: extraido.brasil,
    estados: extraido.estados,
    municipios,
    historico,
  });

  const validacao = validarPrecos(precos);
  if (!validacao.ok) {
    throw new Error(`precos.json inválido, nada foi gravado:\n - ${validacao.erros.join('\n - ')}`);
  }

  // Preços por posto (v5): baixa a planilha "revendas" da mesma semana.
  let postosPorUf = null;
  if (!opcoes.semPostos) {
    try {
      let linkRevendas = null;
      if (paginaHtml) {
        try {
          linkRevendas = escolherLinkRevendasDaSemana(paginaHtml, semana);
        } catch {
          linkRevendas = null;
        }
      }
      let revendas = null;
      let revendasUrl = "";
      if (linkRevendas) {
        log(`baixando o XLSX de postos: ${linkRevendas.url}`);
        const baixado = await baixar(linkRevendas.url, { userAgent: AGENTE_NAVEGADOR });
        revendas = baixado.buffer;
        revendasUrl = baixado.url || linkRevendas.url;
      } else {
        for (const candidata of urlsRevendasDaSemana(semana)) {
          try {
            const baixado = await baixar(candidata, { tentativas: 1, timeoutMs: 45_000, userAgent: AGENTE_NAVEGADOR });
            revendas = baixado.buffer;
            revendasUrl = baixado.url || candidata;
            break;
          } catch {
            // tenta a próxima URL canônica
          }
        }
      }
      if (!revendas) throw new Error("planilha de postos não encontrada");
      log(`XLSX de postos baixado (${formatarTamanho(revendas.length)})`);
      const extraidoPostos = extrairPostosDoArquivo(revendas);
      for (const mensagem of extraidoPostos.avisos) aviso(mensagem);
      postosPorUf = gerarPostosPorUf(extraidoPostos.postos, {
        url: revendasUrl,
        semana,
        atualizadoEm: precos.atualizadoEm,
      });
      const validacaoPostos = validarPostos(postosPorUf);
      if (!validacaoPostos.ok) {
        throw new Error(validacaoPostos.erros.slice(0, 3).join("; "));
      }
      log(`postos: ${extraidoPostos.postos.length} postos em ${Object.keys(postosPorUf).length} UFs`);
    } catch (erro) {
      aviso(`preços por posto indisponíveis nesta execução: ${erro.message}`);
      postosPorUf = null;
    }
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
    if (postosPorUf) {
      log(`--dry-run: ${Object.keys(postosPorUf).length} arquivos de postos por UF seriam gravados; nada foi gravado`);
    }
    log(`--dry-run: ${formatarTamanho(Buffer.byteLength(json))} de JSON gerados; nada foi gravado`);
    process.stdout.write(json);
    return;
  }

  gravarAtomico(caminhoSaida, json);
  log(`gravado ${caminhoSaida} (${formatarTamanho(Buffer.byteLength(json))})`);

  if (postosPorUf) {
    const resultado = gravarPostos(postosPorUf, DIRETORIO_POSTOS);
    log(`postos gravados em ${DIRETORIO_POSTOS}: ${resultado.arquivos} arquivos (${formatarTamanho(resultado.bytes)})`);
  }
}

if (executadoDiretamente()) {
  executar().catch((erro) => {
    console.error(`\nprecos: erro: ${erro.message}`);
    process.exitCode = 1;
  });
}
