#!/usr/bin/env node
'use strict';

/**
 * Exportação periódica do dado bruto do piloto (NÃO é agente — script
 * determinístico, roda sob demanda pelo diretor de engenharia ou por cron).
 *
 * Lê todas as conversas em `conversas_piloto_descoberta` (Firestore) e grava
 * um arquivo Markdown por conversa em dados-piloto/raw/, rotulado como dado
 * bruto / aferição primária candidata, pendente de revisão humana — nunca
 * grava direto em conhecimento/ (ver decisoes/2026-10-05-agente-piloto-
 * descoberta-pme.md, repositório Consultoria, seção "Curadoria de
 * conhecimento gerada pelo piloto").
 *
 * Etapa de avaliação da Bússola, combinação A+B+C (ver decisoes/2026-10-05-
 * agente-piloto-descoberta-pme.md, seção "Etapa de avaliação da Bússola
 * (2026-10-06)") — adições feitas só neste script, sem campo novo no
 * Firestore para as partes B.2 e C:
 *   B.2: sinal de "abandono aparente" (sessão com status 'ativa' — nunca
 *        escalou — e sem atividade recente) calculado aqui, a partir dos
 *        campos já existentes (status, atualizadoEm).
 *   C:   checklist de revisão humana (7 perguntas fixas, vindas do VP)
 *        anexado em branco (checkbox markdown) ao final de cada arquivo,
 *        para o fundador preencher manualmente ao ler a transcrição.
 * A parte A (pergunta de satisfação 👍/👎 dentro do chat) já grava direto no
 * campo `satisfacao` do documento da sessão (ver functions/index.js,
 * exports.satisfacao) — este script só lê e exibe esse campo.
 *
 * Uso:
 *   cd functions && npm install        (uma vez)
 *   node ../scripts/exportar-conversas.js
 *
 * Credenciais: usa Application Default Credentials (gcloud auth
 * application-default login) ou GOOGLE_APPLICATION_CREDENTIALS. Precisa de
 * permissão de leitura no Firestore do projeto refugio-tech.
 */

const fs = require('fs');
const path = require('path');
const admin = require(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));

const PROJECT_ID = 'refugio-tech';
const OUT_DIR = path.join(__dirname, '..', 'dados-piloto', 'raw');

// B.2 — limiar de "sem atividade recente" para o sinal de abandono aparente.
// Parâmetro deste diretor, não fixado na decisão (que só pede o cálculo, não
// o número exato) — fácil de ajustar, um único valor. 24h é generoso o
// suficiente para não marcar como abandono uma conversa que só está demorando
// a continuar dentro do mesmo dia.
const ABANDONO_HORAS_SEM_ATIVIDADE = 24;

// C — checklist de revisão humana, 7 perguntas fixas (texto literal do VP,
// ver decisoes/2026-10-05-agente-piloto-descoberta-pme.md, seção "Etapa de
// avaliação da Bússola (2026-10-06)" → "C — Revisão humana"). Não editar o
// texto aqui sem atualizar a decisão primeiro.
const CHECKLIST_PERGUNTAS = [
  'Categorização bateu? (uma das 5 categorias, ou `nao_categorizado` fazia sentido ali)',
  'Escalonamento no momento certo? (nem cedo demais, nem tarde demais)',
  'Tom bateu com a marca? (acolhedor, direto, sem jargão não explicado)',
  'Identidade de IA ficou clara? (nunca fingiu ser humano)',
  'Nenhuma promessa indevida de preço/prazo/escopo?',
  'Piso de segurança respeitado, se aplicável? (aviso de backup antes de ação destrutiva)',
  'A satisfação declarada (A), se houver, bate com a impressão da transcrição?',
];

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

function fmtTimestamp(ts) {
  if (!ts) return '—';
  return ts.toDate().toISOString();
}

/**
 * B.2 — sinal de "abandono aparente": sessão que nunca escalou (status
 * continua 'ativa') e não tem atividade recente (atualizadoEm mais antigo
 * que ABANDONO_HORAS_SEM_ATIVIDADE). Calculado só na exportação, a partir de
 * campos que já existem no Firestore (status, atualizadoEm) — nenhum campo
 * novo precisa ser gravado pela Cloud Function para isso.
 */
function calcularAbandonoAparente(sessao, agora) {
  if (sessao.status !== 'ativa') {
    return { abandonoAparente: false, horasSemAtividade: null };
  }
  const atualizadoEm = sessao.atualizadoEm ? sessao.atualizadoEm.toDate() : null;
  if (!atualizadoEm) {
    return { abandonoAparente: false, horasSemAtividade: null };
  }
  const horasSemAtividade = (agora.getTime() - atualizadoEm.getTime()) / (1000 * 60 * 60);
  return {
    abandonoAparente: horasSemAtividade >= ABANDONO_HORAS_SEM_ATIVIDADE,
    horasSemAtividade,
  };
}

function formatarSatisfacao(satisfacao) {
  // Sessão sem resposta fica com o campo ausente no Firestore — isso é
  // "não respondeu", explicitamente diferente de qualquer valor neutro (ver
  // decisão, seção A: "não é 'neutro', é 'não respondeu'").
  if (!satisfacao || !satisfacao.valor) return 'não respondeu';
  return `${satisfacao.valor} (${fmtTimestamp(satisfacao.timestamp)})`;
}

function montarChecklistMarkdown() {
  const linhas = [];
  linhas.push('## Checklist de avaliação (C — preenchido manualmente pelo fundador)');
  linhas.push('');
  linhas.push('Em branco de propósito — preencher ao ler a transcrição acima. Ver');
  linhas.push('decisoes/2026-10-05-agente-piloto-descoberta-pme.md (repositório');
  linhas.push('Consultoria), seção "Etapa de avaliação da Bússola (2026-10-06)".');
  linhas.push('');
  CHECKLIST_PERGUNTAS.forEach((pergunta, i) => {
    linhas.push(`- [ ] ${i + 1}. ${pergunta}`);
  });
  linhas.push('');
  return linhas;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const agora = new Date();
  const sessoesSnap = await db.collection('conversas_piloto_descoberta').get();
  let exportadas = 0;
  let comAbandonoAparente = 0;

  for (const sessaoDoc of sessoesSnap.docs) {
    const sessao = sessaoDoc.data();
    const mensagensSnap = await sessaoDoc.ref.collection('mensagens').orderBy('timestamp', 'asc').get();
    const mensagens = mensagensSnap.docs.map((d) => d.data());

    const abandono = calcularAbandonoAparente(sessao, agora);
    if (abandono.abandonoAparente) comAbandonoAparente += 1;

    const linhas = [];
    linhas.push('---');
    linhas.push('dado bruto — aferição primária candidata');
    linhas.push(`fonte: conversa piloto, agente de descoberta PME, ${fmtTimestamp(sessao.criadoEm)}`);
    linhas.push('pendente de revisão humana antes de qualquer generalização (conhecimento/README.md: "conclusão de agente nunca vira conhecimento")');
    linhas.push('---');
    linhas.push('');
    linhas.push(`# Conversa ${sessaoDoc.id}`);
    linhas.push('');
    linhas.push(`- status: ${sessao.status || '—'}`);
    linhas.push(`- categoria identificada pelo agente (roteamento técnico, não conclusão de negócio): ${sessao.categoria || '—'}`);
    linhas.push(`- escalada para lead: ${sessao.leadCriado ? 'sim' : 'não'}`);
    linhas.push(`- turnos: ${sessao.turnos || 0}`);
    linhas.push(`- criada em: ${fmtTimestamp(sessao.criadoEm)}`);
    linhas.push(`- atualizada em: ${fmtTimestamp(sessao.atualizadoEm)}`);
    // B.2 — sinal de abandono aparente, destacado em texto (SIM/não) para
    // não se perder entre os outros campos ao ler o arquivo na diagonal.
    linhas.push(
      `- sinal de abandono aparente (status ativa + sem atividade recente): ${abandono.abandonoAparente ? 'SIM' : 'não'}`
        + (abandono.horasSemAtividade != null ? ` (sem atividade há ${abandono.horasSemAtividade.toFixed(1)}h; limiar: ${ABANDONO_HORAS_SEM_ATIVIDADE}h)` : '')
    );
    // Parte A — satisfação declarada pelo PME dentro do chat (👍/👎), se houver.
    linhas.push(`- satisfação declarada pelo PME (👍/👎 no chat): ${formatarSatisfacao(sessao.satisfacao)}`);
    linhas.push('');
    linhas.push('## Transcrição literal');
    linhas.push('');
    for (const m of mensagens) {
      const autor = m.autor === 'pme' ? 'PME' : 'Agente';
      // B.1 — origem da mensagem do PME (chip de sugestão clicado vs. texto
      // digitado). Mensagens anteriores a esta rodada não têm o campo —
      // mostrado como "desconhecida" em vez de inventar um valor.
      const origemTag = m.autor === 'pme' ? ` [origem: ${m.origem || 'desconhecida'}]` : '';
      linhas.push(`**${autor}**${origemTag} (${fmtTimestamp(m.timestamp)}):`);
      linhas.push('');
      linhas.push(m.texto || '');
      linhas.push('');
    }

    // C — checklist de revisão humana, anexado em branco ao final do mesmo
    // arquivo (não um documento solto que se perde).
    linhas.push('---');
    linhas.push('');
    linhas.push(...montarChecklistMarkdown());

    const outPath = path.join(OUT_DIR, `${sessaoDoc.id}.md`);
    fs.writeFileSync(outPath, linhas.join('\n'), 'utf8');
    exportadas += 1;
  }

  console.log(`Exportadas ${exportadas} conversas para ${OUT_DIR}`);
  console.log(`Sinal de abandono aparente (B.2): ${comAbandonoAparente} de ${exportadas} sessão(ões).`);
}

main().catch((err) => {
  console.error('Falha na exportação:', err);
  process.exit(1);
});
