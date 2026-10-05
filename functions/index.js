'use strict';

/**
 * Cloud Function do agente conversacional de descoberta — piloto Segmento A.
 *
 * Plano técnico aprovado pelo fundador: ver sessão Hermes
 * 20261005_122529_b0399b ("Plano técnico agente conversacional descoberta")
 * e decisoes/2026-10-05-agente-piloto-descoberta-pme.md (repositório
 * Consultoria) para o roteiro completo.
 *
 * Resumo do desenho (detalhe em docs/agente-conversacional-descoberta.md,
 * repositório Consultoria):
 *   - Modelo: Gemini 2.5 Flash via Vertex AI, mesmo projeto GCP.
 *   - Persistência: Firestore (southamerica-east1), coleção
 *     conversas_piloto_descoberta (sessão) + subcoleção mensagens.
 *   - Escalonamento para lead: campo estruturado (JSON) devolvido pelo
 *     próprio modelo a cada turno, nunca por regex sobre texto livre.
 *   - "consultoria produtiva" escalona sempre (regra determinística no
 *     código, não depende do modelo lembrar disso).
 *   - E-mail de escalonamento via Web3Forms (mesmo canal já usado pelo
 *     formulário de contato do site, contato@refugio.tech).
 *   - Mitigação de abuso: Cloudflare Turnstile (obrigatório no 1º turno de
 *     cada sessão) + limite de turnos por sessão + limite de mensagens por
 *     IP por dia, aplicados dentro da própria function (ver nota em
 *     docs/agente-conversacional-descoberta.md sobre por que o rate
 *     limiting do lado da Cloudflare, previsto no plano original, não se
 *     aplica tecnicamente a este endpoint).
 */

const { onRequest } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const { VertexAI } = require('@google-cloud/vertexai');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({ region: 'southamerica-east1', maxInstances: 10 });

const PROJECT_ID = 'refugio-tech';
const VERTEX_LOCATION = 'us-central1'; // Gemini via Vertex AI não está disponível em southamerica-east1; dado em si (Firestore) fica no Brasil, só a chamada de inferência sai.
const MODEL_NAME = 'gemini-2.5-flash';

const ALLOWED_ORIGINS = new Set([
  'https://refugio.tech',
  'https://www.refugio.tech',
  'https://refugio-tech.web.app',
  'https://refugio-tech.firebaseapp.com',
]);
// Canais de pré-visualização do Firebase Hosting (ex.: hosting:channel:deploy)
// — usados só para QA interna antes de publicar no domínio de produção.
const ALLOWED_ORIGIN_PATTERN = /^https:\/\/refugio-tech--[a-z0-9-]+\.web\.app$/;

function origemPermitida(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGINS.has(origin) || ALLOWED_ORIGIN_PATTERN.test(origin);
}

// Limites de abuso — aplicados dentro da própria function (ver cabeçalho do arquivo).
const MAX_TURNOS_POR_SESSAO = 30;
const MAX_MENSAGENS_POR_IP_POR_DIA = 60;

const CATEGORIAS = [
  'seguranca_basica',
  'infraestrutura',
  'ferramentas_gestao',
  'suporte_terceirizado',
  'consultoria_produtiva',
];

let roteiro;
try {
  // eslint-disable-next-line global-require
  roteiro = require('./roteiro');
} catch (e) {
  roteiro = { SYSTEM_PROMPT: 'PLACEHOLDER — roteiro ainda não revisado pelo fundador. Ver docs/agente-conversacional-descoberta.md.' };
}

let cachedTurnstileSecret = null;
const secretClient = new SecretManagerServiceClient();

async function getTurnstileSecret() {
  if (cachedTurnstileSecret) return cachedTurnstileSecret;
  const [version] = await secretClient.accessSecretVersion({
    name: `projects/${PROJECT_ID}/secrets/turnstile-secret-key/versions/latest`,
  });
  cachedTurnstileSecret = version.payload.data.toString('utf8');
  return cachedTurnstileSecret;
}

async function verifyTurnstile(token, remoteIp) {
  if (!token) return false;
  const secret = await getTurnstileSecret();
  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret, response: token, remoteip: remoteIp }),
  });
  const data = await resp.json();
  return Boolean(data && data.success);
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip || 'desconhecido';
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

async function checkAndIncrementIpLimit(ip) {
  const ref = db.collection('rate_limits').doc(`${ip}_${todayKey()}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? snap.data().count || 0 : 0;
    if (current >= MAX_MENSAGENS_POR_IP_POR_DIA) {
      return false;
    }
    tx.set(ref, { count: current + 1, ip, data: todayKey() }, { merge: true });
    return true;
  });
}

function buildResponseSchema() {
  return {
    type: 'object',
    properties: {
      resposta: { type: 'string', description: 'Texto da resposta do agente para o PME, em português do Brasil.' },
      categoria: { type: 'string', enum: [...CATEGORIAS, 'nenhuma'] },
      escalar: { type: 'boolean' },
      motivo_escalonamento: { type: 'string' },
      resumo_para_lead: { type: 'string', description: 'Resumo factual do que o PME disse, para o fundador ler antes de responder o lead. Vazio se escalar=false.' },
      nome_pme: { type: 'string' },
      empresa_pme: { type: 'string' },
      contato_pme: { type: 'string' },
    },
    required: ['resposta', 'categoria', 'escalar'],
  };
}

async function callGemini(history, novaMensagem) {
  const vertexAI = new VertexAI({ project: PROJECT_ID, location: VERTEX_LOCATION });
  const model = vertexAI.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: roteiro.SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: buildResponseSchema(),
      temperature: 0.4,
    },
  });

  const contents = history.map((m) => ({
    role: m.autor === 'pme' ? 'user' : 'model',
    parts: [{ text: m.texto }],
  }));
  contents.push({ role: 'user', parts: [{ text: novaMensagem }] });

  const result = await model.generateContent({ contents });
  const text = result.response.candidates[0].content.parts[0].text;
  return JSON.parse(text);
}

/**
 * Dispara o aviso de escalonamento para o fundador.
 *
 * NÃO usa Web3Forms: testado nesta rodada e a própria API recusa chamada
 * server-side ("This method is not allowed. Use our API in client side or
 * contact support with server IP address (Pro plan is required)") — o
 * formulário de contato do site funciona porque é o NAVEGADOR do visitante
 * chamando a API, não um backend. Mesma restrição já encontrada e
 * documentada pelo diretor anterior ao tentar automatizar o cadastro da
 * Web3Forms (docs/infra-site-dominio-hospedagem.md seção 14.3).
 *
 * Em vez de assinar um novo fornecedor de e-mail transacional (custo e
 * conta novos, caminho não combinado com o fundador), uso só o que já está
 * disponível no mesmo projeto GCP: um log estruturado específico
 * ("LEAD_ESCALADO_AGENTE_DESCOBERTA") + uma política de alerta do Cloud
 * Monitoring (criada nesta mesma rodada) que dispara e-mail para
 * d3_nt@hotmail.com — o mesmo e-mail pessoal do fundador que já recebe o
 * contato do site. Zero fornecedor novo, zero custo adicional (Cloud
 * Monitoring tem cota gratuita generosa, muito acima do volume do piloto).
 */
function notificarEscalonamento({ sessionId, categoria, resumo, nome, empresa, contato, motivo }) {
  const consoleLink = `https://console.firebase.google.com/project/${PROJECT_ID}/firestore/data/~2Fconversas_piloto_descoberta~2F${sessionId}`;
  logger.warn('LEAD_ESCALADO_AGENTE_DESCOBERTA', {
    sessionId,
    categoria,
    motivo,
    nome,
    empresa,
    contato,
    resumo,
    consoleLink,
  });
}

exports.chat = onRequest({ cors: false, secrets: ['turnstile-secret-key'] }, async (req, res) => {
  const origin = req.headers.origin;
  if (origemPermitida(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
  }
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ erro: 'method_not_allowed' });
    return;
  }

  try {
    const { sessionId, message, turnstileToken } = req.body || {};
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128) {
      res.status(400).json({ erro: 'sessionId_invalido' });
      return;
    }
    if (!message || typeof message !== 'string' || message.length > 4000) {
      res.status(400).json({ erro: 'message_invalida' });
      return;
    }

    const ip = getClientIp(req);
    const okIp = await checkAndIncrementIpLimit(ip);
    if (!okIp) {
      res.status(429).json({ erro: 'limite_diario_excedido' });
      return;
    }

    const sessionRef = db.collection('conversas_piloto_descoberta').doc(sessionId);
    const sessionSnap = await sessionRef.get();
    const isFirstTurn = !sessionSnap.exists;

    if (isFirstTurn) {
      const humano = await verifyTurnstile(turnstileToken, ip);
      if (!humano) {
        res.status(403).json({ erro: 'verificacao_humana_falhou' });
        return;
      }
      await sessionRef.set({
        criadoEm: admin.firestore.FieldValue.serverTimestamp(),
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
        status: 'ativa',
        categoria: null,
        turnos: 0,
        leadCriado: false,
        ipOrigem: ip,
      });
    }

    const sessionData = (await sessionRef.get()).data();
    if ((sessionData.turnos || 0) >= MAX_TURNOS_POR_SESSAO) {
      res.status(429).json({ erro: 'limite_de_turnos_da_sessao_excedido' });
      return;
    }

    const mensagensRef = sessionRef.collection('mensagens');
    const historicoSnap = await mensagensRef.orderBy('timestamp', 'asc').limit(40).get();
    const historico = historicoSnap.docs.map((d) => d.data());

    const resultado = await callGemini(historico, message);

    const batch = db.batch();
    const agora = admin.firestore.FieldValue.serverTimestamp();
    batch.set(mensagensRef.doc(), { autor: 'pme', texto: message, timestamp: agora });
    batch.set(mensagensRef.doc(), { autor: 'agente', texto: resultado.resposta, timestamp: agora });

    const categoriaFinal = CATEGORIAS.includes(resultado.categoria) ? resultado.categoria : (sessionData.categoria || null);
    const escalarFinal = Boolean(resultado.escalar) || categoriaFinal === 'consultoria_produtiva';

    batch.set(sessionRef, {
      atualizadoEm: agora,
      categoria: categoriaFinal,
      turnos: (sessionData.turnos || 0) + 1,
      status: escalarFinal ? 'escalada' : sessionData.status,
    }, { merge: true });

    await batch.commit();

    if (escalarFinal && !sessionData.leadCriado) {
      await sessionRef.set({ leadCriado: true }, { merge: true });
      const leadRef = db.collection('leads').doc();
      await leadRef.set({
        sessionId,
        categoria: categoriaFinal,
        motivo: resultado.motivo_escalonamento || (categoriaFinal === 'consultoria_produtiva' ? 'categoria consultoria_produtiva escalona sempre' : null),
        resumo: resultado.resumo_para_lead || null,
        nome: resultado.nome_pme || null,
        empresa: resultado.empresa_pme || null,
        contato: resultado.contato_pme || null,
        criadoEm: agora,
      });
      await notificarEscalonamento({
        sessionId,
        categoria: categoriaFinal,
        resumo: resultado.resumo_para_lead,
        nome: resultado.nome_pme,
        empresa: resultado.empresa_pme,
        contato: resultado.contato_pme,
        motivo: resultado.motivo_escalonamento,
      });
    }

    res.status(200).json({ resposta: resultado.resposta, escalado: escalarFinal });
  } catch (err) {
    logger.error('Erro no endpoint /chat', err);
    res.status(500).json({ erro: 'erro_interno' });
  }
});
