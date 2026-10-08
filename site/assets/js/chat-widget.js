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

   MUDANÇA 3 (2026-10-08, autorizada pelo fundador — ver comentário grande
   em index.html, seção #solucoes): o widget passou a ser embutido direto
   na home, além de continuar podendo existir em páginas próprias. Este
   arquivo é o MESMO usado em produção (nenhuma lógica de sessão/Turnstile/
   rede foi alterada) — só ganhou um modo "embutido", ativado por
   data-embed="inline" no elemento raiz (#refugio-chat-widget):
     - o painel fica visualmente presente/aberto ao carregar a página (é
       o produto da seção, não algo escondido atrás de um clique no
       launcher) — isso é só LAYOUT: painel.hidden=false, sem exigir
       interação prévia;
     - nunca aciona o reparenting de "tela cheia no celular" (pensado
       originalmente para a hero de /bussola ocupar a viewport inteira no
       mobile) — embutido, o widget é só mais um bloco no fluxo normal da
       seção, em qualquer tamanho de tela.
   Fora isso, todo o resto (fechar/reabrir, Turnstile, anexos, chips,
   preview de solução) funciona exatamente igual ao modo não-embutido.

   CORREÇÃO DE UX (2026-10-08, autorizada pelo fundador após revisão
   visual, commit 05a209c): a rodada anterior tinha feito o modo embutido
   chamar input.focus() no load (abrirPainel() sem distinguir origem), o
   que forçava foco de teclado na página inteira assim que ela carregava
   — em mobile isso abre o teclado virtual sozinho. O fundador pediu
   explicitamente para a Bússola ser PROMOVIDA por design/copy (isso já
   estava resolvido: ocupa a maior parte visual da home), nunca por
   comportamento que interrompe o usuário no load. Dois ajustes:
     1. abrirPainel(opts) agora recebe opts.foco (default true). A
        abertura automática do modo embutido no load passa opts.foco=false
        explicitamente — o campo de texto só recebe foco quando o próprio
        usuário clica no launcher, no campo, ou em [data-chat-reopen].
        Nenhum auto-scroll foi encontrado neste arquivo (confirmado por
        busca em todo o código por scrollIntoView/scrollTo no root/body —
        só existe scrollTop interno em .chat-widget__messages, que rola a
        LISTA DE MENSAGENS, não a página).
     2. Bug encontrado nesta revisão (não reportado antes, achado ao
        auditar o fluxo): abrirPainel() adicionava a classe
        is-chat-fullscreen-open ao <body> incondicionalmente, mesmo no
        modo embutido. Essa classe só tem efeito dentro de
        @media(max-width:1023px) (chat-widget.css) e trava o scroll da
        PÁGINA TODA (overflow:hidden). Como o modo embutido nunca usa o
        hack de tela cheia, isso travava a rolagem da home inteira em
        qualquer celular (<1024px) assim que a página carregava — pior que
        o autofoco, era um bloqueio de interação real. Corrigido: a classe
        só é adicionada quando !embedded (mesma guarda já usada pro
        reparenting de tela cheia).

   AJUSTE DE UX (2026-10-08, pedido do fundador pós-revisão em produção,
   pós-deploy do commit 917a4da): abrir/fechar o painel (embutido ou
   launcher) trocava de estado instantaneamente ([hidden] nativo —
   display:none/flex sem transição). Agora abrirPainel()/fecharPainel()
   coordenam uma transição real de opacity+transform (CSS em
   chat-widget.css, ~0.26s) com a classe .is-open no PRÓPRIO painel: o
   [hidden] só é removido no início da abertura (antes da classe, com um
   reflow forçado no meio) e só é reaplicado no FIM do fechamento, depois
   que a transição de saída termina (evento transitionend + timeout de
   segurança como fallback) — ver os comentários junto às funções
   abrirPainel/fecharPainel/finalizarFechamentoPainel, mais abaixo, para o
   racional completo de cada decisão (por que a classe vai no painel e não
   no elemento raiz, por que opts.animar existe, etc.). Não depende de
   nenhuma media query própria para respeitar prefers-reduced-motion: já
   existe uma regra global em styles.css que zera a duração de toda
   transição/animação do site nesse caso; chat-widget.js checa a mesma
   preferência em paralelo só para pular a espera do evento/timeout.
   =================================================================== */
(function () {
  'use strict';

  var CHAT_ENDPOINT = 'https://southamerica-east1-refugio-tech.cloudfunctions.net/chat';
  var ANEXO_URL_ENDPOINT = 'https://southamerica-east1-refugio-tech.cloudfunctions.net/anexoUrl';
  var SATISFACAO_URL_ENDPOINT = 'https://southamerica-east1-refugio-tech.cloudfunctions.net/satisfacao';
  // Feature NOVA (rodada 29, 2026-10-07) — preview de solução, NÃO
  // publicada em produção (ver docs/agente-conversacional-descoberta.md,
  // repositório Consultoria, seção 37, para a investigação que define
  // estas restrições, e functions/index.js para o endpoint). Endpoint
  // assíncrono separado do /chat de propósito — a geração leva 7,5–9,8s,
  // não pode travar a conversa principal.
  var PREVIEW_URL_ENDPOINT = 'https://southamerica-east1-refugio-tech.cloudfunctions.net/previewSolucao';
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
    var embedded = root.hasAttribute('data-embed'); // Mudança 3 — ver header do arquivo
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
      typingEl.setAttribute('role', 'status');
      typingEl.innerHTML = '<span class="chat-widget__typing-dots" aria-hidden="true"><span></span><span></span><span></span></span><span class="chat-widget__typing-label">Bússola está respondendo…</span>';
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

    // --- Feature NOVA (rodada 29, 2026-10-07): preview de solução, NÃO
    // publicada em produção — ver docs/agente-conversacional-
    // descoberta.md (repositório Consultoria, seção 37) para as
    // restrições que esta implementação segue à risca:
    //   - disparada no máximo pelo gatilho que o /chat manda 1x por
    //     sessão (data.ofertarPreview) + o teto do próprio endpoint
    //     (MAX_PREVIEWS_POR_SESSAO em functions/index.js);
    //   - renderizada em <iframe sandbox="allow-same-origin" srcdoc="…">
    //     SEM allow-scripts — o HTML do modelo nunca executa JS dentro
    //     do site de produção, só é desenhado;
    //   - estado de carregamento explícito, sem travar o campo de texto
    //     da conversa principal (chamada 100% separada do /chat). ---
    function addPreviewPrompt() {
      var wrap = document.createElement('div');
      wrap.className = 'chat-widget__bubble chat-widget__bubble--agente chat-widget__preview-prompt';

      var texto = document.createElement('p');
      texto.className = 'chat-widget__preview-prompt-texto';
      texto.textContent = 'Já tenho o suficiente pra esboçar uma ideia. Quer que eu te mostre um rascunho visual disso?';
      wrap.appendChild(texto);

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-widget__preview-prompt-btn';
      btn.textContent = 'Ver rascunho';

      btn.addEventListener('click', function () {
        btn.disabled = true;
        btn.textContent = 'Gerando rascunho, alguns segundos…';

        fetch(PREVIEW_URL_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId }),
        })
          .then(function (resp) {
            if (!resp.ok) throw new Error('status ' + resp.status);
            return resp.json();
          })
          .then(function (data) {
            if (btn.parentNode) btn.parentNode.removeChild(btn);
            texto.textContent = 'Aqui está um rascunho inicial — não é a solução final, é só pra dar uma ideia visual:';
            addPreviewCard(data);
          })
          .catch(function () {
            btn.disabled = false;
            btn.textContent = 'Não consegui gerar agora — tentar de novo';
          });
      });

      wrap.appendChild(btn);
      messagesEl.appendChild(wrap);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // Monta o cartão do preview — iframe SEM allow-scripts (piso de
    // segurança desta feature, ver comentário acima) + o esboço textual
    // de arquitetura abaixo. mockupDisponivel=false (guardrail de
    // tamanho/sanitização no servidor) cai só no texto, sem iframe.
    function addPreviewCard(data) {
      var card = document.createElement('div');
      card.className = 'chat-widget__preview-card';

      if (data.mockupDisponivel && data.mockupHtml) {
        var frameLabel = document.createElement('p');
        frameLabel.className = 'chat-widget__preview-card-label';
        frameLabel.textContent = 'mockup visual · sandbox, sem script';
        card.appendChild(frameLabel);

        var frame = document.createElement('iframe');
        frame.className = 'chat-widget__preview-frame';
        // SEM allow-scripts, de propósito — ver docs/agente-
        // conversacional-descoberta.md seção 37.3: o modelo já incluiu
        // <script> funcional sem pedir num teste real; o mockup é só
        // visual, nunca executa código dentro do site de produção.
        frame.setAttribute('sandbox', 'allow-same-origin');
        frame.setAttribute('title', 'Rascunho visual gerado pela Bússola');
        frame.srcdoc = data.mockupHtml;
        card.appendChild(frame);
      }

      var esboco = document.createElement('p');
      esboco.className = 'chat-widget__preview-card-esboco';
      esboco.textContent = data.esbocoArquitetura || '';
      card.appendChild(esboco);

      messagesEl.appendChild(card);
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

    // AJUSTE DE UX (2026-10-08, pedido do fundador pós-revisão em produção,
    // pós-deploy do commit 917a4da): abrir/fechar o painel trocava de
    // estado instantaneamente ([hidden] nativo — display:none não anima).
    // Agora existe uma transição real (opacity + transform, CSS em
    // chat-widget.css, ~0.26s): ao ABRIR, o painel sai do [hidden] e SÓ
    // DEPOIS ganha a classe .is-open que dispara a transição pro estado
    // visível — precisa de um reflow forçado (void panel.offsetHeight)
    // entre as duas mudanças, senão o navegador funde display:none→flex e
    // a classe na mesma atualização de estilo e pula a transição (o
    // elemento nunca existiu visualmente no estado de partida pra
    // interpolar a partir dele). Ao FECHAR, a classe .is-open sai do
    // painel IMEDIATAMENTE (dispara a transição de saída), mas o [hidden]
    // só é aplicado no fim de verdade — via evento `transitionend` da
    // própria propriedade opacity, com um setTimeout de segurança como
    // fallback (caso o evento não dispare por algum motivo: troca de aba
    // no meio da transição, etc.). Isso é o que permite a transição de
    // FECHAR aparecer — um elemento display:none não anima a própria
    // saída.
    //
    // A classe .is-open fica no PRÓPRIO painel (não no elemento raiz
    // .chat-widget) de propósito: no modo launcher (não-embutido) o
    // painel é reparentado para <body> em telas <1024px
    // (moverPainelParaFullscreen) — um seletor dependente do ancestral
    // .chat-widget perderia o match depois do reparenting.
    //
    // root.is-open sai IMEDIATAMENTE no clique de fechar (mesma semântica
    // simples de sempre: "aberto" é só o estado estável aberto, não
    // inclui "fechando") — é o que o resto do arquivo usa pra decidir
    // abrir/fechar (ex.: o handler de clique do launcher, mais abaixo).
    // Só que isso sozinho reexibiria o launcher (ele reaparece no fluxo
    // do layout) ENQUANTO o painel ainda está visualmente desaparecendo
    // por cima — um salto de layout no meio da própria transição que
    // este ajuste existe pra eliminar. Por isso existe root.is-closing,
    // junto: adicionada no mesmo instante que is-open sai, removida só no
    // FIM do fechamento (finalizarFechamentoPainel) — chat-widget.css
    // esconde o launcher enquanto QUALQUER uma das duas classes estiver
    // presente.
    var PANEL_TRANSITION_MS = 260; // em sincronia com chat-widget.css
    var panelFechandoTimeoutId = null;

    function prefereMovimentoReduzido() {
      // Mesma preferência de sistema que styles.css já respeita
      // globalmente (@media prefers-reduced-motion: reduce, que força
      // transition-duration/animation-duration pra 0.01ms em todo
      // elemento do site — inclusive este painel). Checar de novo aqui,
      // em paralelo, só evita depender de um evento `transitionend` (que
      // ainda dispara, só que quase instantâneo) pra aplicar o estado
      // final: quem tem essa preferência vê a troca sem nenhuma
      // animação, nem mínima, de forma explícita.
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    function onPanelFechouTransicao(ev) {
      // Reage só à transição de opacidade do PRÓPRIO painel — ignora
      // qualquer transição de elemento filho que borbulhe até aqui.
      if (ev.target !== panel || ev.propertyName !== 'opacity') return;
      finalizarFechamentoPainel();
    }

    function limparFechamentoPendente() {
      if (panelFechandoTimeoutId !== null) {
        clearTimeout(panelFechandoTimeoutId);
        panelFechandoTimeoutId = null;
      }
      panel.removeEventListener('transitionend', onPanelFechouTransicao);
      root.classList.remove('is-closing');
    }

    // Passo final do fechamento — só executa depois que a transição de
    // saída já terminou visualmente (ou de imediato, com movimento
    // reduzido). Remove de vez o painel do layout (hidden=true), destrava
    // o scroll do body (modo fullscreen mobile) e devolve o painel pro
    // lugar original no DOM, se tinha sido reparentado. root.is-open já
    // foi removida no INÍCIO do fechamento (ver fecharPainel) — aqui só
    // falta tirar o is-closing (feito dentro de limparFechamentoPendente).
    function finalizarFechamentoPainel() {
      limparFechamentoPendente();
      document.body.classList.remove('is-chat-fullscreen-open');
      panel.hidden = true;
      devolverPainelAoLugarOriginal();
    }

    // opts.foco (default true) controla só o foco de teclado no campo de
    // texto — nunca o layout/visibilidade do painel. Chamadas originadas
    // de interação real do usuário (clique no launcher, em
    // [data-chat-reopen], reabertura manual) mantêm o default true: focar
    // depois de um clique é comportamento esperado, não interrupção.
    // A abertura automática do modo embutido no load passa opts.foco=false
    // explicitamente — o campo de texto só recebe foco quando o próprio
    // usuário clica no launcher, no campo, ou em [data-chat-reopen].
    // Nenhum auto-scroll foi encontrado neste arquivo (confirmado por
    // busca em todo o código por scrollIntoView/scrollTo no root/body —
    // só existe scrollTop interno em .chat-widget__messages, que rola a
    // LISTA DE MENSAGENS, não a página).
    //
    // opts.animar (default true) controla só a transição visual de
    // abertura. A abertura automática do modo embutido no load passa
    // animar=false explicitamente: o painel embutido já nasce
    // visualmente presente/aberto na home (é o produto da seção, não algo
    // escondido atrás de um clique) — animá-lo na primeira pintura da
    // página pareceria um "pop" inesperado no load, não o reforço de
    // fluidez que este ajuste pede. Toda reabertura real feita pelo
    // visitante (launcher, [data-chat-reopen], reabrir depois de fechar)
    // sempre anima, inclusive no modo embutido.
    function abrirPainel(opts) {
      var foco = !opts || opts.foco !== false;
      var animar = !opts || opts.animar !== false;
      if (root.classList.contains('is-open') && panel.classList.contains('is-open')) {
        if (foco) input.focus();
        return;
      }
      // Cancela um fechamento em andamento (usuário reabriu no meio da
      // transição de saída) — sem isso, o timeout/listener pendente
      // aplicaria hidden=true por cima da reabertura em breve.
      limparFechamentoPendente();
      atualizarAlturaHeaderFullscreen();
      // Mudança 3: widget embutido na home nunca usa o hack de tela cheia
      // no celular (ver header do arquivo) — fica sempre inline, como
      // qualquer outro bloco da seção.
      if (!embedded && dentroDoBreakpointMobileFullscreen()) {
        moverPainelParaFullscreen();
      }
      root.classList.add('is-open');
      // Correção de UX (ver header do arquivo): esta classe só existe pra
      // travar o scroll do <body> atrás do painel em tela cheia no
      // celular (chat-widget.css, @media max-width:1023px). O modo
      // embutido nunca entra em tela cheia — aplicá-la mesmo assim
      // travava a rolagem da home inteira em qualquer celular ao carregar
      // a página. Mesma guarda do reparenting acima.
      if (!embedded) {
        document.body.classList.add('is-chat-fullscreen-open');
      }
      panel.hidden = false;
      if (animar) {
        // Reflow forçado: garante que o navegador registre o estado
        // "fechado" (opacity/transform definidos em chat-widget.css pro
        // painel sem .is-open) antes de aplicar a classe que dispara a
        // transição pro estado aberto — sem isso as duas mudanças de
        // estilo (hidden=false + .is-open) se fundem na mesma atualização
        // e o navegador pula direto pro estado final, sem animar.
        void panel.offsetHeight;
      }
      panel.classList.add('is-open');
      launcher.setAttribute('aria-expanded', 'true');
      if (!enviouPrimeiraMensagem) {
        renderTurnstileSeNecessario();
      }
      if (foco) input.focus();
    }
    function fecharPainel() {
      // Guarda contra clique duplo durante a própria transição de saída:
      // root.is-open já sai IMEDIATAMENTE aqui (mesma semântica simples
      // de antes do ajuste — "aberto" é só o estado estável, não inclui
      // "fechando"), então quem decide fechar/abrir de novo em outro
      // lugar (ex.: o próprio handler de clique do launcher, mais abaixo)
      // já vê o estado certo e reabre em vez de tentar fechar de novo.
      // is-closing é só o sinal interno de "já está fechando, não repetir
      // a mesma chamada" + mantém o launcher escondido durante o fade
      // (ver chat-widget.css — a regra de esconder o launcher olha tanto
      // .is-open quanto .is-closing).
      if (!root.classList.contains('is-open') || root.classList.contains('is-closing')) return;
      root.classList.remove('is-open');
      root.classList.add('is-closing');
      panel.classList.remove('is-open'); // dispara a transição de saída
      launcher.setAttribute('aria-expanded', 'false');

      if (prefereMovimentoReduzido()) {
        finalizarFechamentoPainel();
        return;
      }
      panel.addEventListener('transitionend', onPanelFechouTransicao);
      // Fallback de segurança: se `transitionend` não disparar por algum
      // motivo, garante que o painel termina de fechar mesmo assim.
      panelFechandoTimeoutId = setTimeout(finalizarFechamentoPainel, PANEL_TRANSITION_MS + 80);
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
          if (data.ofertarPreview) addPreviewPrompt();
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

    // Mudança 3 (2026-10-08): instância embutida na home fica visualmente
    // aberta no load, sem esperar clique no launcher — é o próprio
    // produto da seção (ver comentário grande em index.html, #solucoes, e
    // no header deste arquivo). abrirPainel() já guarda `!embedded` antes
    // de acionar o hack de tela cheia do celular e de travar o scroll do
    // body, então isso aqui é seguro em qualquer tamanho de tela.
    //
    // Correção de UX (2026-10-08, autorizada pelo fundador): foco=false
    // explícito — carregar a página NUNCA deve roubar foco de teclado
    // (nem abrir o teclado virtual sozinho no mobile). A Bússola é
    // promovida por layout/copy (já resolvido antes), não por interromper
    // o usuário no load. O campo só foca quando o usuário interage de
    // verdade (clique no launcher — que fica escondido via CSS
    // .chat-widget.is-open .chat-widget__launcher quando já está aberto,
    // então aqui isso só afeta um clique novo em [data-chat-reopen] ou no
    // próprio campo — ou clique direto no textarea).
    if (embedded) {
      abrirPainel({ foco: false, animar: false });
    }
  });
})();
