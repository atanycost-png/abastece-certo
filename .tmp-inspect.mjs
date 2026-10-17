import { readFileSync } from 'node:fs';
import * as P from './tools/update-prices.mjs';

const buffer = readFileSync('.tmp-anp.xlsx');
const zip = P.abrirZip(buffer);
const shared = P.parsearSharedStrings(P.lerTextoZip(zip, 'xl/sharedStrings.xml') ?? '');
const abas = P.resolverAbas(zip);
console.log('abas:', abas ? [...abas.keys()] : 'nenhuma');

const caminho = abas?.get('MUNICIPIOS');
console.log('caminho MUNICIPIOS:', caminho);
const linhas = P.parsearLinhasPlanilha(zip.ler(caminho).toString('utf8'), shared);
console.log('linhas:', linhas.length);

// procura cabeçalho
const { indice, colunas } = P.encontrarCabecalho(linhas);
console.log('cabecalho na linha', linhas[indice].numero, colunas);

const cel = (linha, letra) => linha.celulas.get(letra)?.valor ?? null;
const amostra = linhas.slice(indice + 1, indice + 8);
for (const l of amostra) {
  console.log(JSON.stringify({
    estado: cel(l, colunas.estado),
    municipio: cel(l, colunas.municipio),
    produto: cel(l, colunas.produto),
    media: cel(l, colunas.media),
    postos: cel(l, colunas.postos),
  }));
}

// conta municípios e UFs (gasolina comum)
const cidades = new Set();
const ufs = new Set();
let linhasGas = 0;
for (const l of linhas.slice(indice + 1)) {
  const prod = P.normalizarProduto(cel(l, colunas.produto));
  if (prod !== 'gasolinaComum') continue;
  linhasGas++;
  const uf = P.estadoParaUF(cel(l, colunas.estado));
  const m = String(cel(l, colunas.municipio) ?? '').trim();
  if (uf && m) { ufs.add(uf); cidades.add(uf + '|' + m); }
}
console.log('linhas de gasolina comum:', linhasGas, '| UFs:', ufs.size, '| municípios:', cidades.size);
console.log('exemplos:', [...cidades].slice(0, 5));
