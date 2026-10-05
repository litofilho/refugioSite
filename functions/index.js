'use strict';

/**
 * Cloud Function do agente conversacional de descoberta — piloto Segmento A,
 * nome de marca "Bússola" na página pública.
 *
 * STATUS (rodada 4, 2026-10-05): implementa os 6 pontos da "Resolução final
 * da rodada 3" em decisoes/2026-10-05-agente-piloto-descoberta-pme.md
 * (repositório Consultoria) — arquitetura de duas chamadas, heurísticas sem
 * ITIL/COBIT para suporte_terceirizado, validação de domínio por melhor
 * esforço + checagem pós-resposta, orçamento de alerta GCP em R$50/mês,
 * piso de segurança por palavra-chave determinística, gate de escalonamento
 * por checklist de campos + plateau. AGUARDANDO APROVAÇÃO DO FUNDADOR —
 * nenhum `firebase deploy --only functions` foi executado nesta rodada.
 * Testado fora do Cloud Functions, com chamadas diretas à API do Vertex AI
 * (ver docs/agente-conversacional-descoberta.md, repositório Consultoria,
 * seção da rodada 4, para o relatório de teste).
 *
 * Resumo do desenho:
 *   - Modelo: Gemini 2.5 Flash via Vertex AI, mesmo projeto GCP.
 *   - Persistência: Firestore (southamerica-east1), coleção
 *     conversas_piloto_descoberta (sessão) + subcoleção mensagens.
 *   - Chamada 1 (callDiagnostico): sempre executada, saída JSON estruturada
 *     (responseSchema) — categoriza, preenche o checklist de campos por
 *     categoria, sinaliza necessidade de fonte externa e os três motivos de
 *     escalonamento que só o modelo pode perceber (execução prática, decisão
 *     de investimento, mudança de contrato).
 *   - Chamada 2 (callGrounding): só disparada quando a chamada 1 sinalizar
 *     precisa_fonte_externa=true. Sem responseSchema (incompatível com
 *     grounding no Gemini 2.5 Flash), usa a ferramenta googleSearch. O
 *     código confere se o domínio citado bate com DOMINIOS_APROVADOS da
 *     categoria; se não bater, trata como "sem fonte confiável" (gatilho de
 *     escalonamento).
 *   - Gate de escalonamento 100% determinístico em código — ver
 *     calcularMotivoEscalonamento(). motivo_escalonamento sempre em
 *     MOTIVOS_ESCALONAMENTO (enum fixo), nunca texto livre do modelo.
 *   - Piso de segurança: filtro de palavra-chave determinístico
 *     (aplicarPisoSeguranca) antepõe aviso de backup sempre que a resposta
 *     final contém termo destrutivo da lista TERMOS_DESTRUTIVOS. Limite
 *     aceito e declarado: não cobre paráfrase ou instrução disfarçada.
 *   - E-mail de escalonamento via log estruturado + Cloud Monitoring (ver
 *     notificarEscalonamento) — inalterado nesta rodada.
 *   - Mitigação de abuso: Cloudflare Turnstile + limite de turnos por sessão
 *     + limite de mensagens por IP por dia — inalterado nesta rodada.
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

// Checklist fino de campos de diagnóstico por categoria — ver
// docs/agente-conversacional-descoberta.md (rodada 4) para a justificativa
// de cada campo. Usado tanto para montar o responseSchema quanto para
// calcular o diff de "campo novo preenchido" turno a turno.
const CAMPOS_POR_CATEGORIA = {
  seguranca_basica: ['alvo_protegido', 'existe_backup', 'onde_fica_backup', 'ja_teve_incidente', 'nivel_urgencia_percebido'],
  infraestrutura: ['equipamento_envolvido', 'sintoma_principal', 'quantidade_pessoas_afetadas', 'ja_tentou_resolver', 'ambiente_fisico'],
  ferramentas_gestao: ['ferramenta_atual', 'processo_afetado', 'volume_de_uso', 'dor_especifica', 'ja_tentou_resolver'],
  suporte_terceirizado: ['tem_fornecedor_hoje', 'existe_contrato_ou_sla_escrito', 'tempo_resposta_relatado', 'custo_relatado', 'motivo_insatisfacao'],
  consultoria_produtiva: ['o_que_quer_construir', 'motivo_construir_do_zero', 'orcamento_mencionado', 'prazo_mencionado'],
};

// Validação de domínio por "melhor esforço + checagem pós-resposta" (ponto 3
// da resolução) — não é allowlist garantido via Vertex AI Search, é uma
// lista de referência conferida em código depois da busca livre. Domínio
// vazio = categoria nunca aciona grounding (suporte_terceirizado: heurística
// própria, sem fornecedor oficial a citar).
const DOMINIOS_APROVADOS = {
  seguranca_basica: ['microsoft.com', 'google.com', 'kaspersky.com', 'kaspersky.com.br', 'avast.com'],
  infraestrutura: ['intelbras.com.br', 'tp-link.com', 'tp-link.com.br'],
  ferramentas_gestao: ['omie.com.br', 'bling.com.br', 'tiny.com.br', 'contaazul.com', 'microsoft.com', 'google.com'],
  suporte_terceirizado: [],
  consultoria_produtiva: ['omie.com.br', 'bling.com.br', 'tiny.com.br', 'contaazul.com', 'microsoft.com', 'google.com'],
};

const MOTIVOS_ESCALONAMENTO = [
  'execucao_pratica',
  'decisao_investimento',
  'mudanca_contrato',
  'sem_fonte_confiavel',
  'fora_padrao_conhecido',
  'plateau_diagnostico',
];

const SINAIS_ESCALONAMENTO_DO_MODELO = ['execucao_pratica', 'decisao_investimento', 'mudanca_contrato'];

const PLATEAU_TURNOS = 2;

// Piso de segurança (ponto 5): lista fixa de termos destrutivos em PT-BR.
// Limite aceito e declarado: não cobre paráfrase nem instrução destrutiva
// disfarçada — é rede de segurança determinística, não garantia semântica.
const TERMOS_DESTRUTIVOS_REGEX = /apagar|deletar|exclu(ir|a|indo|ídos?)|formatar|reinstala(r|ndo)|reseta(r|ndo)|reset\s+de\s+f[aá]brica|restaura[rç][aã]o?\s+de\s+f[aá]brica|revoga(r|ndo)\s+(o\s+)?acesso|limpar\s+(o\s+disco|tudo)|sobrescreve(r|ndo)|desinstala(r|ndo)|zera(r|ndo)|wipe|factory reset/i;

const AVISO_BACKUP = 'Antes de qualquer coisa: garanta (ou confirme que já existe) um backup atualizado antes de continuar — essa ação não tem volta.';

const MENSAGEM_HANDOFF_PADRAO = 'Vou registrar isso para um especialista humano da Refúgio Tech continuar com você.';

let roteiro;
try {
  // eslint-disable-next-line global-require
  roteiro = require('./roteiro');
} catch (e) {
  roteiro = {
    SYSTEM_PROMPT_DIAGNOSTICO: 'PLACEHOLDER — roteiro ainda não revisado pelo fundador. Ver docs/agente-conversacional-descoberta.md.',
    SYSTEM_PROMPT_GROUNDING: 'Responda de forma factual e curta, citando a fonte.',
  };
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

/** Sub-schema de um campo de checklist: string livre, vazio se desconhecido. */
function campoSchema(descricao) {
  return { type: 'string', description: descricao || 'Deixe string vazia se ainda não souber.' };
}

/** Monta o sub-objeto de campos de uma categoria a partir de CAMPOS_POR_CATEGORIA. */
function categoriaCamposSchema(categoria) {
  const properties = {};
  for (const campo of CAMPOS_POR_CATEGORIA[categoria]) {
    properties[campo] = campoSchema();
  }
  return { type: 'object', properties, required: [] };
}

function buildCamposDiagnosticoSchema() {
  const properties = {};
  for (const categoria of CATEGORIAS) {
    properties[categoria] = categoriaCamposSchema(categoria);
  }
  return {
    type: 'object',
    description: 'Checklist de diagnóstico. Preencha só os campos da categoria identificada; deixe as outras quatro com todos os campos em string vazia.',
    properties,
  };
}

function buildDiagnosticoResponseSchema() {
  return {
    type: 'object',
    properties: {
      resposta: { type: 'string', description: 'Texto da resposta do agente para o PME, em português do Brasil. Se precisa_fonte_externa=true, uma frase curta de transição.' },
      categoria: { type: 'string', enum: [...CATEGORIAS, 'nenhuma'] },
      padrao_conhecido: { type: 'boolean', description: 'true se a situação casa com um padrão que o agente sabe resolver com orientação; false se é genuinamente atípica.' },
      precisa_fonte_externa: { type: 'boolean', description: 'true só quando o passo exato depende de documentação oficial de um fornecedor específico. suporte_terceirizado nunca marca true.' },
      consulta_busca: { type: 'string', description: 'Pergunta de busca objetiva, preenchida só quando precisa_fonte_externa=true.' },
      sinal_escalonamento: { type: 'string', enum: ['nenhum', ...SINAIS_ESCALONAMENTO_DO_MODELO] },
      campos_diagnostico: buildCamposDiagnosticoSchema(),
      resumo_para_lead: { type: 'string', description: 'Resumo factual do que o PME disse, para o fundador ler antes de responder o lead. Vazio se ainda não há motivo de escalonamento.' },
      nome_pme: { type: 'string' },
      empresa_pme: { type: 'string' },
      contato_pme: { type: 'string' },
    },
    required: ['resposta', 'categoria', 'padrao_conhecido', 'precisa_fonte_externa', 'sinal_escalonamento', 'campos_diagnostico'],
  };
}

async function callDiagnostico(history, novaMensagem) {
  const vertexAI = new VertexAI({ project: PROJECT_ID, location: VERTEX_LOCATION });
  const model = vertexAI.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: roteiro.SYSTEM_PROMPT_DIAGNOSTICO,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: buildDiagnosticoResponseSchema(),
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
 * Chamada 2 — só disparada quando a chamada 1 sinaliza precisa_fonte_externa.
 * Sem responseSchema (incompatível com a ferramenta googleSearch no Gemini
 * 2.5 Flash). Devolve { texto, dominiosCitados } — dominiosCitados vem do
 * campo "domain" de cada groundingChunk.web (confirmado via teste direto à
 * API nesta rodada: a API já devolve um hostname limpo, sem precisar
 * resolver o link de redirecionamento do Vertex AI Search).
 */
async function callGrounding(categoria, consultaBusca) {
  const vertexAI = new VertexAI({ project: PROJECT_ID, location: VERTEX_LOCATION });
  const model = vertexAI.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: roteiro.SYSTEM_PROMPT_GROUNDING,
    tools: [{ googleSearch: {} }],
    generationConfig: { temperature: 0.2 },
  });

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: consultaBusca }] }],
  });
  const candidate = result.response.candidates[0];
  const texto = candidate.content.parts.map((p) => p.text || '').join(' ').trim();
  const chunks = (candidate.groundingMetadata && candidate.groundingMetadata.groundingChunks) || [];
  const dominiosCitados = chunks
    .map((c) => c.web && c.web.domain)
    .filter(Boolean);
  return { texto, dominiosCitados };
}

function dominioAprovado(dominio, listaAprovados) {
  return listaAprovados.some((aprovado) => dominio === aprovado || dominio.endsWith('.' + aprovado));
}

/** Piso de segurança (ponto 5) — ver TERMOS_DESTRUTIVOS_REGEX no topo do arquivo. */
function aplicarPisoSeguranca(texto) {
  if (TERMOS_DESTRUTIVOS_REGEX.test(texto)) {
    return AVISO_BACKUP + ' ' + texto;
  }
  return texto;
}

/**
 * Diff de campos novos preenchidos nesta categoria, turno a turno — calculado
 * em código, nunca por autoavaliação do modelo (ponto 6).
 */
function contarCamposNovos(camposAtuais, camposAnteriores, camposDaCategoria) {
  let novos = 0;
  for (const campo of camposDaCategoria) {
    const atual = (camposAtuais && camposAtuais[campo]) || '';
    const anterior = (camposAnteriores && camposAnteriores[campo]) || '';
    if (atual.trim() !== '' && anterior.trim() === '') novos += 1;
  }
  return novos;
}

/**
 * Gate de escalonamento 100% determinístico (ponto 6). Ordem de prioridade
 * fixa; motivo sempre em MOTIVOS_ESCALONAMENTO, nunca texto livre.
 */
function calcularMotivoEscalonamento({ sinalModelo, semFonteAprovada, padraoConhecido, plateau }) {
  if (SINAIS_ESCALONAMENTO_DO_MODELO.includes(sinalModelo)) return sinalModelo;
  if (semFonteAprovada) return 'sem_fonte_confiavel';
  if (padraoConhecido === false) return 'fora_padrao_conhecido';
  if (plateau) return 'plateau_diagnostico';
  return null;
}

/**
 * Dispara o aviso de escalonamento para o fundador — ver docs/agente-
 * conversacional-descoberta.md seção 4 para por que não é Web3Forms.
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
        turnosSemNovoCampo: 0,
        camposDiagnostico: {},
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

    const resultado = await callDiagnostico(historico, message);

    const categoriaFinal = CATEGORIAS.includes(resultado.categoria) ? resultado.categoria : (sessionData.categoria || null);
    const categoriaMudou = categoriaFinal !== sessionData.categoria;

    // --- Checklist / plateau (ponto 6) ---
    const camposAtuaisCategoria = (categoriaFinal && resultado.campos_diagnostico && resultado.campos_diagnostico[categoriaFinal]) || {};
    const camposAnterioresCategoria = (!categoriaMudou && sessionData.camposDiagnostico) || {};
    const camposDaCategoria = categoriaFinal ? (CAMPOS_POR_CATEGORIA[categoriaFinal] || []) : [];
    const novosCampos = contarCamposNovos(camposAtuaisCategoria, camposAnterioresCategoria, camposDaCategoria);

    let turnosSemNovoCampo;
    if (categoriaMudou) {
      turnosSemNovoCampo = 0; // categoria nova: checklist começa do zero, não penaliza
    } else if (novosCampos > 0) {
      turnosSemNovoCampo = 0;
    } else {
      turnosSemNovoCampo = (sessionData.turnosSemNovoCampo || 0) + 1;
    }
    const plateau = Boolean(categoriaFinal) && categoriaFinal !== 'nenhuma' && turnosSemNovoCampo >= PLATEAU_TURNOS;

    // --- Chamada 2 (grounding), só se sinalizada e categoria permite ---
    let respostaFinal = resultado.resposta;
    let semFonteAprovada = false;
    const categoriaPermiteGrounding = categoriaFinal && DOMINIOS_APROVADOS[categoriaFinal] && DOMINIOS_APROVADOS[categoriaFinal].length > 0;
    const precisaFonteExterna = Boolean(resultado.precisa_fonte_externa) && categoriaPermiteGrounding;

    if (precisaFonteExterna && resultado.consulta_busca) {
      try {
        const grounding = await callGrounding(categoriaFinal, resultado.consulta_busca);
        const listaAprovados = DOMINIOS_APROVADOS[categoriaFinal] || [];
        const algumAprovado = grounding.dominiosCitados.some((d) => dominioAprovado(d, listaAprovados));
        if (algumAprovado && grounding.texto) {
          const dominioCitado = grounding.dominiosCitados.find((d) => dominioAprovado(d, listaAprovados));
          respostaFinal = grounding.texto + (dominioCitado ? ` (fonte: ${dominioCitado})` : '');
        } else {
          semFonteAprovada = true;
          // mantém resultado.resposta (frase de transição) como handoff
        }
      } catch (groundingErr) {
        logger.error('Erro na chamada de grounding', groundingErr);
        semFonteAprovada = true;
      }
    }

    const motivoEscalonamento = calcularMotivoEscalonamento({
      sinalModelo: resultado.sinal_escalonamento,
      semFonteAprovada,
      padraoConhecido: resultado.padrao_conhecido,
      plateau,
    });
    const escalarFinal = motivoEscalonamento !== null;

    respostaFinal = aplicarPisoSeguranca(respostaFinal);
    if (escalarFinal && !sessionData.leadCriado) {
      respostaFinal = respostaFinal + '\n\n' + MENSAGEM_HANDOFF_PADRAO;
    }

    const batch = db.batch();
    const agora = admin.firestore.FieldValue.serverTimestamp();
    batch.set(mensagensRef.doc(), { autor: 'pme', texto: message, timestamp: agora });
    batch.set(mensagensRef.doc(), { autor: 'agente', texto: respostaFinal, timestamp: agora });

    batch.set(sessionRef, {
      atualizadoEm: agora,
      categoria: categoriaFinal,
      turnos: (sessionData.turnos || 0) + 1,
      turnosSemNovoCampo,
      camposDiagnostico: camposAtuaisCategoria,
      status: escalarFinal ? 'escalada' : sessionData.status,
    }, { merge: true });

    await batch.commit();

    if (escalarFinal && !sessionData.leadCriado) {
      await sessionRef.set({ leadCriado: true }, { merge: true });
      const leadRef = db.collection('leads').doc();
      await leadRef.set({
        sessionId,
        categoria: categoriaFinal,
        motivo: motivoEscalonamento,
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
        motivo: motivoEscalonamento,
      });
    }

    res.status(200).json({ resposta: respostaFinal, escalado: escalarFinal });
  } catch (err) {
    logger.error('Erro no endpoint /chat', err);
    res.status(500).json({ erro: 'erro_interno' });
  }
});
