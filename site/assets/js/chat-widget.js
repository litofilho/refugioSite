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

   REDESIGN (rodada de UX): a mecânica de rede/sessão/Turnstile é a mesma
   de antes (não alterada). O que muda é onde/como a UI é montada: o
   widget agora vive embutido na hero (sem position:fixed) e ganha
   sugestões de início clicáveis que enviam a mensagem direto, com o
   mínimo de cliques possível entre a página carregar e a 1ª resposta.
   =================================================================== */
(function () {
  'use strict';

  var CHAT_ENDPOINT = 'https://southamerica-east1-refugio-tech.cloudfunctions.net/chat';
  var TURNSTILE_SITE_KEY = '0x4AAAAAAFOdF-ZOtkuLF9u6';
  var STORAGE_KEY = 'refugio_chat_session_id';

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
        },
        'expired-callback': function () {
          turnstileToken = null;
        },
      });
    }

    function abrirPainel() {
      if (root.classList.contains('is-open')) {
        input.focus();
        return;
      }
      root.classList.add('is-open');
      panel.hidden = false;
      launcher.setAttribute('aria-expanded', 'true');
      if (!enviouPrimeiraMensagem) {
        renderTurnstileSeNecessario();
      }
      input.focus();
    }
    function fecharPainel() {
      root.classList.remove('is-open');
      panel.hidden = true;
      launcher.setAttribute('aria-expanded', 'false');
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

    function enviarMensagem(texto) {
      texto = (texto || '').trim();
      if (!texto) return;

      if (!enviouPrimeiraMensagem && !turnstileToken) {
        addBubble('sistema', 'Só um instante, confirmando que você não é um robô…');
        renderTurnstileSeNecessario();
        // tenta de novo automaticamente quando o token chegar, sem exigir
        // um clique extra do visitante.
        var tentativas = 0;
        var aguardarToken = setInterval(function () {
          tentativas++;
          if (turnstileToken) {
            clearInterval(aguardarToken);
            enviarMensagemReal(texto);
          } else if (tentativas > 100) { // ~20s
            clearInterval(aguardarToken);
          }
        }, 200);
        return;
      }

      enviarMensagemReal(texto);
    }

    function enviarMensagemReal(texto) {
      esconderSugestoes();
      addBubble('pme', texto);
      input.value = '';
      sendBtn.disabled = true;
      chipButtons.forEach(function (btn) { btn.disabled = true; });
      showTyping();

      var payload = { sessionId: sessionId, message: texto };
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
          hideTyping();
          addBubble('agente', data.resposta);
          if (data.escalado) {
            if (turnstileContainer) turnstileContainer.innerHTML = '';
          }
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
      enviarMensagem(input.value);
    });

    // Sugestões de início: um clique preenche E envia direto, reduzindo
    // ao mínimo os cliques entre chegar na página e receber a 1ª resposta.
    chipButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.disabled) return;
        var texto = btn.getAttribute('data-suggestion') || btn.textContent;
        enviarMensagem(texto);
      });
    });
  });
})();
