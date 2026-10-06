'use strict';

/**
 * Cloud Function do agente conversacional de descoberta — piloto Segmento A,
 * nome de marca "Bússola" na página pública.
 *
 * STATUS (rodada 7, 2026-10-05): corrige 2 dos 4 bugs relatados pelo
 * fundador no teste real de conversa (ver docs/agente-conversacional-
 * descoberta.md, repositório Consultoria, seção da rodada 7, para o
 * relatório completo de causa raiz e teste):
 *
 *   - Bug de coerência do gate de escalonamento (causa raiz, não só
 *     sintoma): o schema de saída do modelo agora separa `resposta_base`
 *     (sempre preenchido) de `pergunta_continuidade` (só usado quando a
 *     conversa continua). O código NUNCA concatena `pergunta_continuidade`
 *     à resposta quando `escalarFinal` já foi decidido nesse turno — ver
 *     bloco "BLOQUEIO DE CAUSA RAIZ" dentro de exports.chat. Antes, o
 *     modelo escrevia uma única string livre (`resposta`) que podia conter
 *     pergunta de diagnóstico mesmo em turnos que o código ia escalar,
 *     porque nada no código impedia a concatenação. Agora a separação é
 *     estrutural (schema), não dependente de o modelo lembrar de uma regra
 *     de prompt.
 *   - Suporte a anexos (imagem, vídeo, áudio) — upload via signed URL pro
 *     bucket dedicado `refugio-tech-anexos-piloto` (Cloud Storage), nunca
 *     direto pelo corpo da requisição HTTP (limite de ~32MB do Cloud
 *     Functions 2ª geração). A function nunca confia no tipo/tamanho que o
 *     client declarou — relê os metadados reais do objeto no bucket antes
 *     de aceitar e montar a part multimodal (`fileData`) pro Gemini.
 *
 * Resumo do desenho (inalterado desde a rodada 4, exceto os dois pontos
 * acima):
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
 *     + limite de mensagens por IP por dia + (novo) limite de anexos por
 *     sessão e de bytes de anexo por IP por dia.
 */

const { onRequest } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const crypto = require('crypto');
const { VertexAI } = require('@google-cloud/vertexai');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const { Storage } = require('@google-cloud/storage');

admin.initializeApp();
const db = admin.firestore();
const storage = new Storage();

setGlobalOptions({ region: 'southamerica-east1', maxInstances: 10 });

const PROJECT_ID = 'refugio-tech';
const VERTEX_LOCATION = 'us-central1'; // Gemini via Vertex AI não está disponível em southamerica-east1; dado em si (Firestore, bucket de anexos) fica no Brasil, só a chamada de inferência sai.
const MODEL_NAME = 'gemini-2.5-flash';

// Bucket dedicado a anexos do piloto (ver docs/agente-conversacional-
// descoberta.md, rodada 7, seção de anexos, para a justificativa de usar um
// bucket GCS simples em vez do Firebase Storage "padrão": evita habilitar um
// produto novo do Firebase pra um caso de uso que só precisa de signed URL +
// leitura server-side, mais reversível). Privado (uniform bucket-level
// access + public access prevention enforced) — nenhum acesso público direto,
// só signed URLs de upload de curta duração e o service agent do Vertex AI
// (permissão concedida fora do código, via gcloud, ver relatório).
const BUCKET_ANEXOS = 'refugio-tech-anexos-piloto';

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

// Limites de anexo (ponto 4 do bug report, rodada 7) — teto autoimposto de
// proteção de custo/abuso, não limite técnico do Gemini (que aceita até 2GB
// por arquivo via Cloud Storage). Valores propostos por este diretor,
// pendentes de validação do fundador (ver relatório) — fáceis de ajustar,
// um único número cada.
const ANEXOS_CONFIG = {
  'image/jpeg': { extensao: 'jpg', maxBytes: 15 * 1024 * 1024 },
  'image/png': { extensao: 'png', maxBytes: 15 * 1024 * 1024 },
  'image/webp': { extensao: 'webp', maxBytes: 15 * 1024 * 1024 },
  'video/mp4': { extensao: 'mp4', maxBytes: 50 * 1024 * 1024 },
  'video/webm': { extensao: 'webm', maxBytes: 50 * 1024 * 1024 },
  'audio/mpeg': { extensao: 'mp3', maxBytes: 20 * 1024 * 1024 },
  'audio/wav': { extensao: 'wav', maxBytes: 20 * 1024 * 1024 },
  'audio/ogg': { extensao: 'ogg', maxBytes: 20 * 1024 * 1024 },
  'audio/webm': { extensao: 'webm', maxBytes: 20 * 1024 * 1024 },
};
const MAX_ANEXOS_POR_SESSAO = 5;
const MAX_BYTES_ANEXO_POR_IP_POR_DIA = 300 * 1024 * 1024; // 300MB/dia — teto de proteção, não previsão de uso real.
const MAX_ANEXO_URLS_POR_IP_POR_DIA = 40; // pedidos de signed URL por IP/dia — barato de gerar, mas limitado pra não virar vetor de martelo.
const EXPIRACAO_SIGNED_URL_MS = 5 * 60 * 1000; // 5 minutos pra completar o upload.

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

// Etapa de avaliação da Bússola, combinação A+B+C (ver decisoes/2026-10-05-
// agente-piloto-descoberta-pme.md, repositório Consultoria, seção "Etapa de
// avaliação da Bússola (2026-10-06)").
//
// Parte A: pergunta de satisfação (👍/👎) dentro do chat, disparada pelo
// client quando a resposta do /chat vem com mostrarSatisfacao=true — que o
// código abaixo só marca true no MESMO turno em que escalarFinal vira true
// pela primeira vez na sessão (mesma condição que já disparava a frase de
// handoff e a criação do lead: `escalarFinal && !sessionData.leadCriado`,
// ver variável primeiraVezEscalando dentro de exports.chat). O clique do PME
// chama o endpoint exports.satisfacao abaixo, que grava
// `satisfacao: { valor, timestamp }` no documento da sessão — sessão sem
// clique fica sem o campo (não é "neutro", é "não respondeu"; o script de
// exportação trata essa ausência explicitamente).
const SATISFACAO_VALORES = ['positiva', 'negativa'];
const MAX_SATISFACAO_POR_IP_POR_DIA = 20; // proteção leve de abuso — clique de botão é raro por IP/dia no volume do piloto.

// Parte B.1: origem da mensagem do PME — registrada a partir daqui (sessões
// anteriores a esta rodada não têm o campo; o script de exportação trata
// como "desconhecida").
const ORIGEM_MENSAGEM_VALORES = ['chip', 'digitado'];

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

/** Limite leve de pedidos de signed URL por IP/dia (gerar a URL é barato, mas sem teto vira vetor de martelo). */
async function checkAndIncrementAnexoUrlLimit(ip) {
  const ref = db.collection('rate_limits').doc(`${ip}_${todayKey()}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? snap.data().anexoUrls || 0 : 0;
    if (current >= MAX_ANEXO_URLS_POR_IP_POR_DIA) {
      return false;
    }
    tx.set(ref, { anexoUrls: current + 1, ip, data: todayKey() }, { merge: true });
    return true;
  });
}

/** Teto leve de cliques de satisfação (👍/👎) por IP/dia — ver SATISFACAO_VALORES. */
async function checkAndIncrementSatisfacaoLimit(ip) {
  const ref = db.collection('rate_limits').doc(`${ip}_${todayKey()}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? snap.data().satisfacoes || 0 : 0;
    if (current >= MAX_SATISFACAO_POR_IP_POR_DIA) {
      return false;
    }
    tx.set(ref, { satisfacoes: current + 1, ip, data: todayKey() }, { merge: true });
    return true;
  });
}

/** Teto de bytes de anexo efetivamente aceitos (pós-validação real) por IP/dia. */
async function checkAndIncrementAnexoBytes(ip, bytes) {
  const ref = db.collection('rate_limits').doc(`${ip}_${todayKey()}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? snap.data().bytesAnexos || 0 : 0;
    if (current + bytes > MAX_BYTES_ANEXO_POR_IP_POR_DIA) {
      return false;
    }
    tx.set(ref, { bytesAnexos: current + bytes, ip, data: todayKey() }, { merge: true });
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

/**
 * Schema de saída do modelo — ver cabeçalho do arquivo para o porquê da
 * separação `resposta_base` / `pergunta_continuidade` (correção de causa
 * raiz do bug de coerência do gate de escalonamento, rodada 7). Antes havia
 * um único campo `resposta` (texto livre) que podia conter tanto a resposta
 * de diagnóstico quanto uma pergunta de continuidade, sem nenhuma garantia
 * de que o modelo deixaria de perguntar quando ia escalar no mesmo turno.
 */
function buildDiagnosticoResponseSchema() {
  return {
    type: 'object',
    properties: {
      resposta_base: {
        type: 'string',
        description: 'Texto da resposta do agente para o PME, em português do Brasil — a parte que vale INDEPENDENTE de continuar a conversa ou escalar (acolhimento, orientação, confirmação do que foi entendido). Se precisa_fonte_externa=true, uma frase curta de transição. NUNCA inclua aqui uma pergunta de diagnóstico nova — isso vai só em pergunta_continuidade.',
      },
      pergunta_continuidade: {
        type: 'string',
        description: 'Preencha SÓ quando você pretende continuar diagnosticando neste turno (ou seja, quando padrao_conhecido=true E sinal_escalonamento="nenhum"). Deixe string vazia sempre que padrao_conhecido=false ou sinal_escalonamento != "nenhum" — o sistema vai decidir escalar com base nesses mesmos campos e, se escalar, essa pergunta é descartada automaticamente pelo código (nunca aparece junto com o aviso de escalonamento). Não adianta preenchê-la "por garantia": se escalar=true, ela nunca é usada.',
      },
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
    required: ['resposta_base', 'categoria', 'padrao_conhecido', 'precisa_fonte_externa', 'sinal_escalonamento', 'campos_diagnostico'],
  };
}

/**
 * Chamada 1 — sempre executada. `novaMensagemParts` é um array de parts no
 * formato do Gemini (`[{ text }]` no caso comum; `[{ fileData }, { text }]`
 * quando há anexo nesta mensagem — ver exports.chat).
 */
async function callDiagnostico(history, novaMensagemParts) {
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
    // Anexos de turnos passados não são reenviados ao modelo (custo/latência)
    // — só um marcador textual pra manter continuidade de contexto (ex. "ele
    // mandou uma foto antes"), sem duplicar bytes de arquivo a cada turno.
    parts: [{ text: m.anexo ? `${m.texto || '(sem legenda)'} [anexo enviado: ${m.anexo.mimeType}]` : m.texto }],
  }));
  contents.push({ role: 'user', parts: novaMensagemParts });

  const result = await model.generateContent({ contents });
  const text = result.response.candidates[0].content.parts[0].text;
  return JSON.parse(text);
}

/**
 * Chamada 2 — só disparada quando a chamada 1 devolve precisa_fonte_externa.
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
 * Compõe o texto final para o PME a partir de resposta_base + (opcional)
 * pergunta_continuidade — ESTE é o bloqueio de causa raiz do bug relatado
 * pelo fundador em 2026-10-05 ("site mal construído" perguntou e escalou na
 * mesma mensagem). `pergunta_continuidade` só é concatenada quando
 * `escalarFinal` é false, incondicionalmente — não importa o que o modelo
 * tenha preenchido nesse campo, nem qual dos quatro motivos de
 * MOTIVOS_ESCALONAMENTO disparou o escalonamento (sinal do próprio modelo,
 * fonte não aprovada, padrão desconhecido ou platô — os quatro são
 * cobertos igualmente, porque a checagem é sobre o resultado final
 * `escalarFinal`, não sobre qual gatilho específico foi). Isso corrige a
 * causa raiz (o código não impunha essa exclusão mútua antes), não só o
 * sintoma do caso específico testado pelo fundador.
 */
function comporRespostaBase(respostaBase, perguntaContinuidade, escalarFinal) {
  const base = (respostaBase || '').trim();
  if (escalarFinal) return base; // pergunta_continuidade descartada deliberadamente.
  const pergunta = (perguntaContinuidade || '').trim();
  if (!pergunta) return base;
  if (!base) return pergunta;
  const baseTerminaComPontuacao = /[.!?…]\s*$/.test(base);
  return base + (baseTerminaComPontuacao ? ' ' : '. ') + pergunta;
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

/**
 * Endpoint novo (rodada 7): devolve uma signed URL (v4, PUT, curta duração)
 * pro navegador subir o anexo DIRETO pro bucket, sem passar pela function
 * (contorna o limite de ~32MB do corpo de requisição do Cloud Functions 2ª
 * geração). A function nunca confia no tipo/tamanho declarados aqui — essa
 * validação de verdade acontece em exports.chat, relendo os metadados reais
 * do objeto já no bucket (ver bloco "VALIDAÇÃO REAL DO ANEXO").
 */
exports.anexoUrl = onRequest({ cors: false }, async (req, res) => {
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
    const { sessionId, mimeType } = req.body || {};
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128 || !/^[a-zA-Z0-9-]+$/.test(sessionId)) {
      res.status(400).json({ erro: 'sessionId_invalido' });
      return;
    }
    const config = ANEXOS_CONFIG[mimeType];
    if (!config) {
      res.status(400).json({ erro: 'tipo_de_arquivo_nao_suportado' });
      return;
    }

    const ip = getClientIp(req);
    const okIp = await checkAndIncrementAnexoUrlLimit(ip);
    if (!okIp) {
      res.status(429).json({ erro: 'limite_diario_de_anexos_excedido' });
      return;
    }

    const nomeObjeto = `anexos/${sessionId}/${crypto.randomUUID()}.${config.extensao}`;
    const file = storage.bucket(BUCKET_ANEXOS).file(nomeObjeto);
    const [uploadUrl] = await file.getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + EXPIRACAO_SIGNED_URL_MS,
      contentType: mimeType,
    });

    res.status(200).json({ uploadUrl, path: nomeObjeto, maxBytes: config.maxBytes, expiraEmMs: EXPIRACAO_SIGNED_URL_MS });
  } catch (err) {
    logger.error('Erro no endpoint /anexoUrl', err);
    res.status(500).json({ erro: 'erro_interno' });
  }
});

/**
 * Endpoint novo (etapa de avaliação da Bússola, parte A): grava a resposta
 * de satisfação (👍/👎) clicada pelo PME dentro do chat, imediatamente
 * depois da frase de handoff. Não bloqueia nada — se der erro, o client só
 * mostra uma mensagem amigável e segue, sem travar a conversa.
 */
exports.satisfacao = onRequest({ cors: false }, async (req, res) => {
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
    const { sessionId, valor } = req.body || {};
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128 || !/^[a-zA-Z0-9-]+$/.test(sessionId)) {
      res.status(400).json({ erro: 'sessionId_invalido' });
      return;
    }
    if (!SATISFACAO_VALORES.includes(valor)) {
      res.status(400).json({ erro: 'valor_invalido' });
      return;
    }

    const ip = getClientIp(req);
    const okIp = await checkAndIncrementSatisfacaoLimit(ip);
    if (!okIp) {
      res.status(429).json({ erro: 'limite_diario_excedido' });
      return;
    }

    const sessionRef = db.collection('conversas_piloto_descoberta').doc(sessionId);
    const sessionSnap = await sessionRef.get();
    if (!sessionSnap.exists) {
      res.status(404).json({ erro: 'sessao_nao_encontrada' });
      return;
    }

    await sessionRef.set({
      satisfacao: { valor, timestamp: admin.firestore.FieldValue.serverTimestamp() },
    }, { merge: true });

    res.status(200).json({ ok: true });
  } catch (err) {
    logger.error('Erro no endpoint /satisfacao', err);
    res.status(500).json({ erro: 'erro_interno' });
  }
});

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
    const { sessionId, message, turnstileToken, anexo, origem } = req.body || {};
    // Parte B.1 da etapa de avaliação: origem da mensagem do PME (clique em
    // chip de sugestão vs. texto digitado). Campo opcional no payload (client
    // antigo sem essa versão não envia) — qualquer valor fora do enum vira
    // 'digitado', nunca quebra a requisição.
    const origemMensagem = ORIGEM_MENSAGEM_VALORES.includes(origem) ? origem : 'digitado';
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128) {
      res.status(400).json({ erro: 'sessionId_invalido' });
      return;
    }

    const temAnexoDeclarado = Boolean(anexo) && typeof anexo === 'object' && typeof anexo.path === 'string';

    if (typeof message !== 'string' || message.length > 4000 || (!message.trim() && !temAnexoDeclarado)) {
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
        anexosCount: 0,
        ipOrigem: ip,
      });
    }

    const sessionData = (await sessionRef.get()).data();
    if ((sessionData.turnos || 0) >= MAX_TURNOS_POR_SESSAO) {
      res.status(429).json({ erro: 'limite_de_turnos_da_sessao_excedido' });
      return;
    }

    // --- VALIDAÇÃO REAL DO ANEXO (ponto 2 do bug report, rodada 7) ---
    // Nunca confia em path/tipo/tamanho declarados pelo client — relê os
    // metadados reais do objeto já no bucket antes de aceitar.
    let anexoParaGemini = null;
    let anexoParaFirestore = null;
    if (temAnexoDeclarado) {
      const prefixoEsperado = `anexos/${sessionId}/`;
      if (!anexo.path.startsWith(prefixoEsperado)) {
        res.status(400).json({ erro: 'anexo_invalido', motivo: 'path_fora_da_sessao' });
        return;
      }
      if ((sessionData.anexosCount || 0) >= MAX_ANEXOS_POR_SESSAO) {
        res.status(400).json({ erro: 'anexo_invalido', motivo: 'limite_de_anexos_da_sessao_excedido' });
        return;
      }

      let metadata;
      try {
        [metadata] = await storage.bucket(BUCKET_ANEXOS).file(anexo.path).getMetadata();
      } catch (e) {
        res.status(400).json({ erro: 'anexo_invalido', motivo: 'anexo_nao_encontrado_no_bucket' });
        return;
      }

      const contentTypeReal = metadata.contentType;
      const tamanhoReal = Number(metadata.size || 0);
      const configReal = ANEXOS_CONFIG[contentTypeReal];
      if (!configReal || tamanhoReal <= 0 || tamanhoReal > configReal.maxBytes) {
        await storage.bucket(BUCKET_ANEXOS).file(anexo.path).delete().catch(() => {});
        res.status(400).json({ erro: 'anexo_invalido', motivo: 'tipo_ou_tamanho_fora_do_permitido' });
        return;
      }

      const bytesOk = await checkAndIncrementAnexoBytes(ip, tamanhoReal);
      if (!bytesOk) {
        await storage.bucket(BUCKET_ANEXOS).file(anexo.path).delete().catch(() => {});
        res.status(429).json({ erro: 'limite_diario_de_bytes_de_anexo_excedido' });
        return;
      }

      anexoParaGemini = { path: anexo.path, mimeType: contentTypeReal };
      anexoParaFirestore = { path: anexo.path, mimeType: contentTypeReal, tamanhoBytes: tamanhoReal };
    }

    const mensagensRef = sessionRef.collection('mensagens');
    const historicoSnap = await mensagensRef.orderBy('timestamp', 'asc').limit(40).get();
    const historico = historicoSnap.docs.map((d) => d.data());

    const textoEfetivo = message.trim()
      ? message
      : '[PME enviou um anexo sem legenda. Analise o conteúdo do arquivo pra entender o problema.]';
    const partesMensagemAtual = [];
    if (anexoParaGemini) {
      partesMensagemAtual.push({ fileData: { fileUri: `gs://${BUCKET_ANEXOS}/${anexoParaGemini.path}`, mimeType: anexoParaGemini.mimeType } });
    }
    partesMensagemAtual.push({ text: textoEfetivo });

    const resultado = await callDiagnostico(historico, partesMensagemAtual);

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
    let corpoResposta = resultado.resposta_base;
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
          corpoResposta = grounding.texto + (dominioCitado ? ` (fonte: ${dominioCitado})` : '');
        } else {
          semFonteAprovada = true;
          // mantém resultado.resposta_base (frase de transição) como handoff
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

    // BLOQUEIO DE CAUSA RAIZ (ver comporRespostaBase) — nunca concatena
    // pergunta_continuidade quando escalarFinal=true, independente do que o
    // modelo tenha preenchido nesse campo.
    const respostaComposta = comporRespostaBase(corpoResposta, resultado.pergunta_continuidade, escalarFinal);

    // Etapa de avaliação da Bússola, parte A: este é o único ponto de "fim"
    // bem definido do fluxo atual — escalarFinal virando true pela PRIMEIRA
    // vez na sessão (mesma condição que já decide se a frase de handoff e o
    // lead são criados agora, não repetidos nos turnos seguintes).
    const primeiraVezEscalando = escalarFinal && !sessionData.leadCriado;

    let respostaFinal = aplicarPisoSeguranca(respostaComposta);
    if (primeiraVezEscalando) {
      respostaFinal = respostaFinal + '\n\n' + MENSAGEM_HANDOFF_PADRAO;
    }

    const batch = db.batch();
    const agora = admin.firestore.FieldValue.serverTimestamp();
    const pmeMsgData = { autor: 'pme', texto: message, timestamp: agora, origem: origemMensagem };
    if (anexoParaFirestore) pmeMsgData.anexo = anexoParaFirestore;
    batch.set(mensagensRef.doc(), pmeMsgData);
    batch.set(mensagensRef.doc(), { autor: 'agente', texto: respostaFinal, timestamp: agora });

    batch.set(sessionRef, {
      atualizadoEm: agora,
      categoria: categoriaFinal,
      turnos: (sessionData.turnos || 0) + 1,
      turnosSemNovoCampo,
      camposDiagnostico: camposAtuaisCategoria,
      status: escalarFinal ? 'escalada' : sessionData.status,
      anexosCount: (sessionData.anexosCount || 0) + (anexoParaGemini ? 1 : 0),
    }, { merge: true });

    await batch.commit();

    if (primeiraVezEscalando) {
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

    res.status(200).json({ resposta: respostaFinal, escalado: escalarFinal, mostrarSatisfacao: primeiraVezEscalando });
  } catch (err) {
    logger.error('Erro no endpoint /chat', err);
    res.status(500).json({ erro: 'erro_interno' });
  }
});

// Exportado só para o script de testes unitários isolados (ver
// functions/_teste-unitario-gate.js, não implantado — roda fora do Cloud
// Functions). Não é usado pelo runtime da function em si.
module.exports._testavel = {
  calcularMotivoEscalonamento,
  comporRespostaBase,
  contarCamposNovos,
  dominioAprovado,
  aplicarPisoSeguranca,
};
