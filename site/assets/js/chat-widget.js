/* ===================================================================
   Refúgio Tech — chat-widget.js
   Widget do agente conversacional de descoberta (piloto Segmento A).

   Fala só com o endpoint HTTPS da Cloud Function (nunca com o Firestore
   direto do navegador — ver functions/index.js e firestore.rules no
   repositório). Mantém sessionId em localStorage para dar continuidade à
   conversa entre mensagens (sem exigir login/cadastro do visitante).

   AVISO: este arquivo faz parte da infraestrutura do agente. O TEXTO que o
   agente fala vem do servidor (roteiro.js, Cloud Function) — este arquivo
   não contém nenhum conteúdo de marca/roteiro, só mecânica de UI.

   RODADA 7 (2026-10-05) — 3 correções de bug relatadas pelo fundador no
   teste real:
     1. Turnstile agora COLAPSA (classe .is-collapsed, ver chat-widget.css)
        assim que a verificação passa, em vez de continuar ocupando espaço
        até o fim da conversa.
     2. Enter no campo de texto envia a mensagem (Shift+Enter continua
        quebrando linha, padrão de qualquer app de chat) — antes só o
        clique no botão funcionava, porque o campo é um <textarea> (não
        envia nativamente com Enter como um <input type="text">).
     3. Suporte a anexo (imagem/vídeo/áudio): botão de clipe abre o
        seletor de arquivo; o arquivo sobe DIRETO pro Cloud Storage via
        signed URL obtida em /anexoUrl (nunca passa pelo corpo da
        requisição /chat — ver functions/index.js pro porquê do limite de
        32MB do Cloud Functions). Depois do upload, a referência (path)
        viaja junto da próxima mensagem enviada.

   RODADA 28 (2026-10-07) — o teste A/B de ângulo de abertura (rodada 27,
   "seguranca" vs "receita") foi DESCARTADO junto com a troca das cinco
   categorias de diagnóstico (ver docs/agente-conversacional-descoberta.md,
   repositório Consultoria, seção da rodada 28, e functions/roteiro.js).
   Não existe mais parâmetro `angulo`, nem mais de um grupo de chips: um
   único conjunto de sugestões, refletindo as cinco categorias novas.
   =================================================================== */
(function () {
  'use strict';

  var CHAT_ENDPOINT = 'https://southamerica-east1-refugio-tech.cloudfunctions.net/chat';
  var ANEXO_URL_ENDPOINT = 'https://southamerica-east1-refugio-tech.cloudfunctions.net/anexoUrl';
  var SATISFACAO_URL_ENDPOINT = 'https://southamerica-east1-refugio-tech.cloudfunctions.net/satisfacao';
  var TURNSTILE_SITE_KEY = '0x4AAAAAAFOdF-ZOtkuLF9u6';
  var STORAGE_KEY = 'refugio_chat_session_id';
  // Teto de auto-resize do textarea (~6 linhas) — mantido em sincronia com
  // o max-height de .chat-widget__input em chat-widget.css. Acima disso o
  // campo passa a rolar internamente em vez de continuar crescendo.
  var INPUT_MAX_HEIGHT = 148;

  function getSessionId() {
    var id = window.localStorage.getItem(STORAGE_KEY);
    if (!id) {
      id = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
      window.localStorage.setItem(STORAGE_KEY, id);
    }
    return id;
  }

  document.addEventListener('DOMContentLoaded', function () {
    var root = document.getElementById('refugio-chat-widget');
    if (!root) return;

    var sessionId = getSessionId();
    var turnstileToken = null;
    var turnstileWidgetId = null;
    var enviouPrimeiraMensagem = false;
    var anexoSelecionado = null; // { path, mimeType } depois de upload concluído
    var anexoEmUpload = false;

    var launcher = root.querySelector('.chat-widget__launcher');
    var panel = root.querySelector('.chat-widget__panel');
    var closeBtn = root.querySelector('.chat-widget__close');
    var messagesEl = root.querySelector('.chat-widget__messages');
    var suggestionsEl = root.querySelector('.chat-widget__suggestions');
    var chipButtons = root.querySelectorAll('.chat-widget__chip');
    var form = root.querySelector('.chat-widget__form');
    var input = root.querySelector('.chat-widget__input');
    var sendBtn = root.querySelector('.chat-widget__send');
    var turnstileContainer = root.querySelector('.chat-widget__turnstile');
    var attachBtn = root.querySelector('.chat-widget__attach');
    var fileInput = root.querySelector('.chat-widget__file-input');
    var anexoPreview = root.querySelector('.chat-widget__anexo-preview');
    var anexoPreviewNome = root.querySelector('.chat-widget__anexo-preview-nome');
    var anexoRemoverBtn = root.querySelector('.chat-widget__anexo-remover');
    var typingEl = null;

    function addBubble(autor, texto) {
      var div = document.createElement('div');
      div.className = 'chat-widget__bubble chat-widget__bubble--' + autor;
      div.textContent = texto;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function esconderSugestoes() {
      if (suggestionsEl) suggestionsEl.hidden = true;
    }

    function showTyping() {
      if (typingEl) return;
      typingEl = document.createElement('div');
      typingEl.className = 'chat-widget__typing';
      typingEl.setAttribute('aria-label', 'Bússola está digitando');
      typingEl.innerHTML = '<span></span><span></span><span></span>';
      messagesEl.appendChild(typingEl);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    function hideTyping() {
      if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
      typingEl = null;
    }

    // --- Etapa de avaliação da Bússola, parte A (2026-10-06): pergunta de
    // satisfação (👍/👎), opcional, aparece imediatamente depois da frase de
    // handoff quando o /chat responde mostrarSatisfacao=true (ver
    // functions/index.js — só true no turno em que escalarFinal vira true
    // pela primeira vez na sessão). Não bloqueia nada: o visitante pode
    // ignorar e continuar digitando normalmente. ---
    function addSatisfacaoPrompt() {
      var wrap = document.createElement('div');
      wrap.className = 'chat-widget__bubble chat-widget__bubble--agente chat-widget__satisfacao';

      var texto = document.createElement('p');
      texto.className = 'chat-widget__satisfacao-texto';
      texto.textContent = 'Essa conversa te ajudou?';
      wrap.appendChild(texto);

      var botoes = document.createElement('div');
      botoes.className = 'chat-widget__satisfacao-botoes';

      var btnPos = document.createElement('button');
      btnPos.type = 'button';
      btnPos.className = 'chat-widget__satisfacao-btn';
      btnPos.textContent = '👍';
      btnPos.setAttribute('aria-label', 'Sim, essa conversa ajudou');

      var btnNeg = document.createElement('button');
      btnNeg.type = 'button';
      btnNeg.className = 'chat-widget__satisfacao-btn';
      btnNeg.textContent = '👎';
      btnNeg.setAttribute('aria-label', 'Não, essa conversa não ajudou');

      function registrarSatisfacao(valor) {
        btnPos.disabled = true;
        btnNeg.disabled = true;
        fetch(SATISFACAO_URL_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId, valor: valor }),
        })
          .then(function () {
            texto.textContent = 'Obrigado pelo retorno!';
            if (botoes.parentNode) botoes.parentNode.removeChild(botoes);
          })
          .catch(function () {
            // Opcional, não bloqueia: se der erro de rede, só não insiste.
            texto.textContent = 'Obrigado! (não consegui registrar agora)';
            if (botoes.parentNode) botoes.parentNode.removeChild(botoes);
          });
      }

      btnPos.addEventListener('click', function () { registrarSatisfacao('positiva'); });
      btnNeg.addEventListener('click', function () { registrarSatisfacao('negativa'); });

      botoes.appendChild(btnPos);
      botoes.appendChild(btnNeg);
      wrap.appendChild(botoes);
      messagesEl.appendChild(wrap);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // --- Ajuste de UX (relatado pelo fundador): o textarea tinha altura
    // fixa de 1 linha e rolava internamente/cortava o texto conforme o
    // visitante digitava e quebrava linha. Agora cresce automaticamente
    // até um teto (~6 linhas, INPUT_MAX_HEIGHT) e só então passa a rolar
    // internamente — padrão comum de auto-resize de textarea. ---
    function autoResizeInput() {
      input.style.height = 'auto';
      var novaAltura = Math.min(input.scrollHeight, INPUT_MAX_HEIGHT);
      input.style.height = novaAltura + 'px';
    }
    input.addEventListener('input', autoResizeInput);
    autoResizeInput(); // altura inicial correta mesmo antes de digitar

    // --- BUG 1: Turnstile precisa colapsar/desaparecer assim que a
    // verificação passa, não só quando a conversa escala. ---
    function colapsarTurnstile() {
      if (turnstileContainer) turnstileContainer.classList.add('is-collapsed');
    }
    function expandirTurnstileDeNovo() {
      if (turnstileContainer) turnstileContainer.classList.remove('is-collapsed');
    }

    function renderTurnstileSeNecessario() {
      if (turnstileWidgetId !== null) return;
      if (typeof window.turnstile === 'undefined') {
        // script ainda não carregou — tenta de novo em breve.
        setTimeout(renderTurnstileSeNecessario, 300);
        return;
      }
      turnstileWidgetId = window.turnstile.render(turnstileContainer, {
        sitekey: TURNSTILE_SITE_KEY,
        theme: 'light',
        callback: function (token) {
          turnstileToken = token;
          // Verificação passou: colapsa o widget imediatamente — não
          // espera a resposta da primeira mensagem pra sumir (esse era o
          // bug: o widget ficava ocupando espaço até o fim da conversa).
          colapsarTurnstile();
        },
        'expired-callback': function () {
          turnstileToken = null;
          // Token expirou antes de ser usado (ex.: usuário demorou pra
          // digitar a 1a mensagem) — reabre o widget pra permitir
          // verificar de novo, já que sem token a 1a mensagem não passa.
          if (!enviouPrimeiraMensagem) expandirTurnstileDeNovo();
        },
      });
    }

    // PROPOSTA (full-screen mobile): classe no <body> usada pelo CSS
    // (chat-widget.css, media query max-width:1023px) só para travar o
    // scroll da página por trás do painel enquanto ele ocupa a tela
    // inteira. Em telas >=1024px essa classe não tem nenhum efeito
    // visual (a media query correspondente não existe lá).
    //
    // OPÇÃO 3 (header do site continua visível): o painel não cobre o
    // header, começa logo abaixo dele (CSS: top: var(--chat-fs-header-h)).
    // Mede a altura real do header em JS (em vez de cravar um valor fixo
    // no CSS) pra não desalinhar se o header mudar de altura no futuro
    // (ex.: notificação, banner, etc.).
    function atualizarAlturaHeaderFullscreen() {
      var header = document.querySelector('.site-header');
      if (!header) return;
      document.documentElement.style.setProperty('--chat-fs-header-h', header.offsetHeight + 'px');
    }

    // BUG 1 (celular real, pós-rodada 18 — Opção 3 fullscreen): o painel
    // em tela cheia do mobile usava position:fixed mas continuava sendo
    // DESCENDENTE de `.bussola-hero` (overflow:hidden) e de `<body>`
    // (overflow:hidden só enquanto aberto). Confirmado por teste real via
    // CDP (elementFromPoint + captura de tela, em localhost E em produção):
    // Chrome/Blink recorta (clipa) um descendente position:fixed pelos
    // ancestrais com overflow:hidden — a partir de ~metade do painel pra
    // baixo (bem onde fica o campo de texto), toque/scroll caía direto no
    // CONTEÚDO DE FUNDO da página (texto da seção seguinte vazava
    // visualmente por trás do Turnstile e do campo). É exatamente esse
    // "buraco" que deixa o fundo da página rolar/roubar o toque quando o
    // teclado abre perto do campo de texto, na mesma região clipada.
    // Correção de causa raiz (confirmada ao vivo antes de aplicar, não
    // presumida): mover o painel para ser filho direto de <body> enquanto
    // está em modo tela cheia (mobile, <1024px) — escapa de QUALQUER
    // ancestral com overflow:hidden no caminho. Volta pro lugar original
    // dentro de #refugio-chat-widget ao fechar, sem perder os listeners
    // (é o mesmo nó DOM sendo movido, não um clone).
    var panelParentOriginal = panel.parentNode;
    var panelEstaFullscreen = false;

    function dentroDoBreakpointMobileFullscreen() {
      return window.matchMedia('(max-width: 1023px)').matches;
    }

    function moverPainelParaFullscreen() {
      if (panelEstaFullscreen) return;
      document.body.appendChild(panel);
      panel.classList.add('chat-widget__panel--fullscreen');
      panelEstaFullscreen = true;
    }
    function devolverPainelAoLugarOriginal() {
      if (!panelEstaFullscreen) return;
      panelParentOriginal.appendChild(panel);
      panel.classList.remove('chat-widget__panel--fullscreen');
      panelEstaFullscreen = false;
    }

    function abrirPainel() {
      if (root.classList.contains('is-open')) {
        input.focus();
        return;
      }
      atualizarAlturaHeaderFullscreen();
      if (dentroDoBreakpointMobileFullscreen()) {
        moverPainelParaFullscreen();
      }
      root.classList.add('is-open');
      document.body.classList.add('is-chat-fullscreen-open');
      panel.hidden = false;
      launcher.setAttribute('aria-expanded', 'true');
      if (!enviouPrimeiraMensagem) {
        renderTurnstileSeNecessario();
      }
      input.focus();
    }
    function fecharPainel() {
      root.classList.remove('is-open');
      document.body.classList.remove('is-chat-fullscreen-open');
      panel.hidden = true;
      launcher.setAttribute('aria-expanded', 'false');
      devolverPainelAoLugarOriginal();
    }

    launcher.addEventListener('click', function () {
      if (root.classList.contains('is-open')) {
        fecharPainel();
      } else {
        abrirPainel();
      }
    });
    closeBtn.addEventListener('click', fecharPainel);

    // Qualquer elemento da página (ex.: link de "voltar para a conversa"
    // mais abaixo no texto institucional) pode reabrir/focar o mesmo chat
    // da hero marcando-se com [data-chat-reopen] — não cria um segundo
    // ponto de entrada, só devolve o visitante ao único chat que existe.
    var reopenLinks = document.querySelectorAll('[data-chat-reopen]');
    for (var i = 0; i < reopenLinks.length; i++) {
      reopenLinks[i].addEventListener('click', function () {
        abrirPainel();
      });
    }

    // --- BUG 2 (anexos): seleção de arquivo, upload via signed URL ---
    var EXTENSAO_POR_MIME = {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
      'video/mp4': 'mp4', 'video/webm': 'webm',
      'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/webm': 'webm',
    };

    function mostrarPreviewAnexo(nome) {
      if (!anexoPreview) return;
      anexoPreviewNome.textContent = nome;
      anexoPreview.hidden = false;
    }
    function esconderPreviewAnexo() {
      if (!anexoPreview) return;
      anexoPreview.hidden = true;
      anexoPreviewNome.textContent = '';
    }
    function limparAnexo() {
      anexoSelecionado = null;
      anexoEmUpload = false;
      if (fileInput) fileInput.value = '';
      esconderPreviewAnexo();
    }

    if (attachBtn && fileInput) {
      attachBtn.addEventListener('click', function () {
        if (anexoEmUpload) return;
        fileInput.click();
      });

      fileInput.addEventListener('change', function () {
        var arquivo = fileInput.files && fileInput.files[0];
        if (!arquivo) return;

        if (!EXTENSAO_POR_MIME[arquivo.type]) {
          addBubble('sistema', 'Esse tipo de arquivo não é aceito. Envie imagem (jpg/png/webp), vídeo (mp4/webm) ou áudio (mp3/wav/ogg).');
          limparAnexo();
          return;
        }

        anexoEmUpload = true;
        mostrarPreviewAnexo('Enviando ' + arquivo.name + '…');
        sendBtn.disabled = true;

        fetch(ANEXO_URL_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId, mimeType: arquivo.type }),
        })
          .then(function (resp) {
            if (!resp.ok) throw new Error('status ' + resp.status);
            return resp.json();
          })
          .then(function (data) {
            if (arquivo.size > data.maxBytes) {
              throw new Error('arquivo_grande_demais');
            }
            return fetch(data.uploadUrl, {
              method: 'PUT',
              headers: { 'Content-Type': arquivo.type },
              body: arquivo,
            }).then(function (putResp) {
              if (!putResp.ok) throw new Error('upload_falhou');
              anexoSelecionado = { path: data.path, mimeType: arquivo.type };
              anexoEmUpload = false;
              mostrarPreviewAnexo(arquivo.name);
              sendBtn.disabled = false;
            });
          })
          .catch(function (err) {
            anexoEmUpload = false;
            sendBtn.disabled = false;
            var msg = 'Não consegui enviar esse arquivo agora. Tente de novo ou escreva o problema em texto.';
            if (err && err.message === 'arquivo_grande_demais') {
              msg = 'Esse arquivo é grande demais. Tente um arquivo menor.';
            }
            addBubble('sistema', msg);
            limparAnexo();
          });
      });
    }

    if (anexoRemoverBtn) {
      anexoRemoverBtn.addEventListener('click', function () {
        limparAnexo();
      });
    }

    function enviarMensagem(texto, origem) {
      texto = (texto || '').trim();
      if (!texto && !anexoSelecionado) return;
      if (anexoEmUpload) return; // espera o upload terminar antes de enviar

      if (!enviouPrimeiraMensagem && !turnstileToken) {
        addBubble('sistema', 'Só um instante, confirmando que você não é um robô…');
        renderTurnstileSeNecessario();
        expandirTurnstileDeNovo();
        // tenta de novo automaticamente quando o token chegar, sem exigir
        // um clique extra do visitante.
        var tentativas = 0;
        var aguardarToken = setInterval(function () {
          tentativas++;
          if (turnstileToken) {
            clearInterval(aguardarToken);
            enviarMensagemReal(texto, origem);
          } else if (tentativas > 100) { // ~20s
            clearInterval(aguardarToken);
          }
        }, 200);
        return;
      }

      enviarMensagemReal(texto, origem);
    }

    function enviarMensagemReal(texto, origem) {
      esconderSugestoes();
      var anexoParaEnvio = anexoSelecionado;
      addBubble('pme', texto || (anexoParaEnvio ? '📎 ' + '(anexo enviado)' : ''));
      input.value = '';
      autoResizeInput(); // volta pra altura de 1 linha depois de limpar o campo
      limparAnexo();
      sendBtn.disabled = true;
      chipButtons.forEach(function (btn) { btn.disabled = true; });
      showTyping();

      // Parte B.1 da etapa de avaliação: origem da mensagem (clique em chip
      // de sugestão vs. texto digitado) — campo opcional, servidor trata
      // qualquer valor fora do enum como 'digitado'.
      var payload = { sessionId: sessionId, message: texto, origem: origem === 'chip' ? 'chip' : 'digitado' };
      if (anexoParaEnvio) payload.anexo = anexoParaEnvio;
      if (!enviouPrimeiraMensagem) {
        payload.turnstileToken = turnstileToken;
      }

      fetch(CHAT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (resp) {
          if (!resp.ok) throw new Error('status ' + resp.status);
          return resp.json();
        })
        .then(function (data) {
          enviouPrimeiraMensagem = true;
          // Verificação já foi usada com sucesso — garante que o widget
          // fica colapsado pro resto da conversa (reforço do bug 1, caso
          // o callback de sucesso do Turnstile não tenha disparado antes
          // por algum motivo).
          colapsarTurnstile();
          hideTyping();
          addBubble('agente', data.resposta);
          if (data.mostrarSatisfacao) addSatisfacaoPrompt();
          sendBtn.disabled = false;
        })
        .catch(function () {
          hideTyping();
          addBubble('sistema', 'Não consegui enviar sua mensagem agora. Tente de novo em alguns instantes ou escreva para contato@refugio.tech.');
          sendBtn.disabled = false;
        });
    }

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      enviarMensagem(input.value, 'digitado');
    });

    // --- BUG 3: Enter envia, Shift+Enter quebra linha (padrão de chat) ---
    // O campo é um <textarea>, que não tem o comportamento nativo de
    // "Enter envia" que um <input type="text"> dentro de um <form> tem —
    // por isso precisa deste listener explícito.
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        enviarMensagem(input.value, 'digitado');
      }
    });

    // Sugestões de início: um clique preenche E envia direto, reduzindo
    // ao mínimo os cliques entre chegar na página e receber a 1ª resposta.
    chipButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.disabled) return;
        var texto = btn.getAttribute('data-suggestion') || btn.textContent;
        enviarMensagem(texto, 'chip');
      });
    });
  });
})();
