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

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

function fmtTimestamp(ts) {
  if (!ts) return '—';
  return ts.toDate().toISOString();
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const sessoesSnap = await db.collection('conversas_piloto_descoberta').get();
  let exportadas = 0;

  for (const sessaoDoc of sessoesSnap.docs) {
    const sessao = sessaoDoc.data();
    const mensagensSnap = await sessaoDoc.ref.collection('mensagens').orderBy('timestamp', 'asc').get();
    const mensagens = mensagensSnap.docs.map((d) => d.data());

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
    linhas.push('');
    linhas.push('## Transcrição literal');
    linhas.push('');
    for (const m of mensagens) {
      const autor = m.autor === 'pme' ? 'PME' : 'Agente';
      linhas.push(`**${autor}** (${fmtTimestamp(m.timestamp)}):`);
      linhas.push('');
      linhas.push(m.texto || '');
      linhas.push('');
    }

    const outPath = path.join(OUT_DIR, `${sessaoDoc.id}.md`);
    fs.writeFileSync(outPath, linhas.join('\n'), 'utf8');
    exportadas += 1;
  }

  console.log(`Exportadas ${exportadas} conversas para ${OUT_DIR}`);
}

main().catch((err) => {
  console.error('Falha na exportação:', err);
  process.exit(1);
});
