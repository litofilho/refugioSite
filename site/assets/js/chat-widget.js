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

   AJUSTE DE UX (2026-10-08, pedido do fundador após revisão em produção,
   pós-deploy do commit 89550de): o preview de solução (addPreviewCard,
   feature real já existente — ver comentário na função, mais abaixo; NÃO
   é o mock estático da hero, que é só ilustração) aparecia só como um
   card pequeno dentro do fluxo da conversa. Agora o card ganha um botão
   "expandir" (.chat-widget__preview-card-expand, no canto, ao lado do
   label) que abre uma modal em tela cheia (abrirPreviewModal/
   fecharPreviewModal/criarPreviewModalSeNecessario, mais abaixo) mostrando o
   MESMO iframe sandboxed (mesmo srcdoc, mesmo sandbox="allow-same-origin"
   SEM allow-scripts — essa restrição de segurança nunca muda) em tamanho
   maior. A modal reaproveita a mesma lógica de transição/classes .is-open/
   .is-closing do ajuste acima, e segue o padrão WAI-ARIA de "Dialog
   (Modal)": role="dialog", aria-modal="true", aria-label próprio, ESC
   fecha, foco preso dentro dela (Tab/Shift+Tab não escapam), foco inicial
   no botão de fechar, foco devolvido pro botão que abriu quando fecha.
   Ver o bloco de comentário grande junto das funções, mais abaixo, para o
   racional completo.

   MUDANÇA 4 (2026-10-08, pedido direto do fundador após teste real em
   celular: "fica inutilizável, precisa se adaptar como app de chat"): a
   MUDANÇA 3 (acima) tinha desligado DELIBERADAMENTE o hack de tela cheia
   mobile pro modo embutido — ficava sempre inline, em qualquer tamanho de
   tela, mesmo no momento de digitar. Certo pro estado de repouso (painel
   pequeno dentro do fluxo da seção), errado pro momento de interagir de
   verdade: no celular, o painel pequeno+inline fica inutilizável pra
   digitar (teclado cobre o campo). Reverte a decisão só nesse momento,
   reaproveitando o MESMO mecanismo de reparenting pra <body> que já existe
   e já corrigiu o bug de clipping (BUG 1, mais abaixo) — não reinventa
   nada:
     - gatilho: foco no campo de texto (input.focus) OU clique num chip de
       sugestão — os dois jeitos reais de alguém começar a "usar" o painel
       embutido (entrarFullscreenEmbutido, junto de
       moverPainelParaFullscreen, mais abaixo);
     - saída: só pelo botão de fechar (mesmo affordance "Fechar" que o
       modo launcher já usa em tela cheia) — nunca por blur (perder foco
       tocando num chip ou rolando a lista de mensagens não deve "fechar"
       nada, por isso não existe nenhum listener de blur neste arquivo);
     - ao sair, o painel embutido volta pro tamanho inline normal da
       seção (devolverPainelAoLugarOriginal) — NUNCA fica escondido, ele é
       o produto da seção (diferente do modo launcher, onde fechar
       esconde o painel). Por isso a saída usa uma função própria
       (sairDoFullscreenEmbutido), não fecharPainel();
     - é o MESMO nó do painel sendo reparentado (não um clone), então a
       conversa e o texto já digitado no campo são preservados ao entrar/
       sair — confirmado por teste real via CDP, não só presumido pelo
       mecanismo (ver notas de teste no commit).
   Ver o comentário grande junto de entrarFullscreenEmbutido/
   sairDoFullscreenEmbutido, mais abaixo, para o racional completo.
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
        // AJUSTE DE UX (pedido do fundador pós-revisão em produção, pós-
        // deploy 89550de): label + botão de expandir agora vivem numa
        // linha de cabeçalho própria (ver .chat-widget__preview-card-header
        // em chat-widget.css) — o botão fica no canto, perto do label.
        var header = document.createElement('div');
        header.className = 'chat-widget__preview-card-header';

        var frameLabel = document.createElement('p');
        frameLabel.className = 'chat-widget__preview-card-label';
        frameLabel.textContent = 'mockup visual · sandbox, sem script';
        header.appendChild(frameLabel);

        // Botão "expandir": abre o MESMÍSSIMO mockup (mesmo srcdoc, mesmo
        // sandbox SEM allow-scripts — nunca muda) numa modal em tela
        // cheia (abrirPreviewModal, mais abaixo). Não gera nada de novo,
        // não faz nenhuma chamada de rede — só mostra o mesmo conteúdo
        // maior, pro visitante ver o rascunho com mais detalhe do que
        // cabe no card pequeno dentro do fluxo da conversa.
        var expandBtn = document.createElement('button');
        expandBtn.type = 'button';
        expandBtn.className = 'chat-widget__preview-card-expand';
        expandBtn.setAttribute('aria-label', 'Ver mockup em tela cheia');
        expandBtn.title = 'Ver em tela cheia';
        expandBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true"><path d="M9 4H5a1 1 0 0 0-1 1v4M15 4h4a1 1 0 0 1 1 1v4M9 20H5a1 1 0 0 1-1-1v-4M15 20h4a1 1 0 0 0 1-1v-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        expandBtn.addEventListener('click', function () {
          abrirPreviewModal(data.mockupHtml, expandBtn);
        });
        header.appendChild(expandBtn);

        card.appendChild(header);

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

    // --- AJUSTE DE UX (pedido do fundador pós-revisão em produção, pós-
    // deploy 89550de): expandir o preview de solução em tela cheia. Hoje
    // o preview só aparece como o card pequeno acima (addPreviewCard),
    // dentro do fluxo da conversa — o fundador quer uma forma de ver o
    // MESMO mockup maior, numa modal que ocupa a maior parte da viewport.
    //
    // Reaproveita a MESMA lógica de transição de abrir/fechar do painel
    // principal (commit 89550de, ver abrirPainel/fecharPainel acima): o
    // elemento que anima ganha [hidden] removido + um reflow forçado +
    // só então a classe .is-open (abertura), e perde .is-open na hora mas
    // só ganha [hidden] de volta depois que a transição de saída termina,
    // via transitionend + timeout de segurança (fechamento). Aqui o
    // elemento que anima é o próprio overlay (.chat-widget__preview-
    // modal) — não existe reparenting nem hack de tela cheia mobile
    // envolvido, então não precisa de uma classe "is-closing" num
    // elemento raiz separado só pra esconder outra coisa (diferença do
    // painel); a classe is-closing aqui serve só pra evitar reentrância
    // (clique duplo no meio do próprio fade-out) — mesmo papel, escopo
    // menor. prefers-reduced-motion: nenhuma media query própria, mesma
    // razão do painel (regra global em styles.css já zera toda transição
    // do site; prefereMovimentoReduzido() aqui só evita esperar o
    // evento/timeout).
    //
    // Acessibilidade (WAI-ARIA Authoring Practices — padrão de "Dialog
    // (Modal)"): role="dialog" + aria-modal="true" + aria-label próprio;
    // ESC fecha; foco preso dentro da modal (Tab/Shift+Tab não escapam
    // pro resto da página enquanto aberta); foco inicial vai pro botão de
    // fechar (primeiro elemento interativo útil); foco volta pro botão
    // que abriu a modal (expandBtn, guardado em previewModalInvoker)
    // quando ela fecha — nunca se perde no <body>.
    //
    // MESMO iframe sandboxed do card pequeno: sandbox="allow-same-origin"
    // SEM allow-scripts, srcdoc idêntico — nunca gera/busca nada de novo,
    // só reexibe o mesmo conteúdo maior. Essa restrição de segurança
    // NUNCA muda (ver comentário em addPreviewCard, acima).
    var previewModal = null;
    var previewModalDialog = null;
    var previewModalFrame = null;
    var previewModalCloseBtn = null;
    var previewModalFechandoTimeoutId = null;
    var previewModalInvoker = null; // elemento a devolver o foco ao fechar

    // Elementos realmente focáveis dentro da modal agora (fica só o botão
    // de fechar — ver nota abaixo sobre por que o iframe fica de fora de
    // propósito). Calculada de novo a cada Tab/Shift+Tab em vez de
    // guardada uma única vez, por robustez.
    //
    // NOTA IMPORTANTE (achado real no teste local, não hipotético): o
    // iframe NÃO entra na lista de focáveis (tabindex="-1" aplicado em
    // criarPreviewModalSeNecessario) de propósito. Testado ao vivo: um
    // mockup com um <a> focável no srcdoc faz o Tab entrar de verdade no
    // CONTEÚDO do iframe (não só no elemento <iframe>) — e dali pra
    // frente o keydown passa a disparar no DOCUMENTO INTERNO do iframe,
    // que não propaga (bubble) pro document do painel pai. Resultado
    // observado: o 2º Tab escapava da modal direto pro <body> da página,
    // quebrando o focus trap — mesmo com sandbox sem allow-scripts, isso
    // é comportamento nativo de navegação por teclado entre documentos,
    // nada a ver com JS. Como o mockup é só visual (mesmíssima filosofia
    // do sandbox sem allow-scripts — "só é desenhado", nunca interativo),
    // a correção mais simples e robusta é excluir o iframe da ordem de
    // tabulação: a modal fica com um único elemento focável (o botão de
    // fechar), o que também é um padrão válido e comum de dialog modal.
    function focaveisDentroDoPreviewModal() {
      if (!previewModalDialog) return [];
      var nodes = previewModalDialog.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      var lista = [];
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (el.hasAttribute('disabled')) continue;
        if (el.offsetParent === null) continue; // escondido, não foca de verdade
        lista.push(el);
      }
      return lista;
    }

    // Focus trap + ESC — só ativo enquanto a modal está aberta (listener
    // adicionado em abrirPreviewModal, removido em fecharPreviewModal/
    // finalizarFechamentoPreviewModal).
    function onPreviewModalKeydown(ev) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        fecharPreviewModal();
        return;
      }
      if (ev.key !== 'Tab') return;
      var focaveis = focaveisDentroDoPreviewModal();
      if (focaveis.length === 0) return;
      var primeiro = focaveis[0];
      var ultimo = focaveis[focaveis.length - 1];
      if (ev.shiftKey && document.activeElement === primeiro) {
        ev.preventDefault();
        ultimo.focus();
      } else if (!ev.shiftKey && document.activeElement === ultimo) {
        ev.preventDefault();
        primeiro.focus();
      } else if (focaveis.indexOf(document.activeElement) === -1) {
        // Foco não está em nenhum elemento conhecido da modal (ex.: ainda
        // no <body>, ou escapou por algum motivo) — devolve pro primeiro
        // em vez de deixar vazar pro resto da página.
        ev.preventDefault();
        primeiro.focus();
      }
    }

    // Monta a modal uma única vez (singleton reaproveitado por qualquer
    // preview-card da sessão) e anexa direto em <body> — igual ao painel
    // em modo fullscreen mobile, escapa de qualquer ancestral com
    // overflow:hidden no caminho.
    function criarPreviewModalSeNecessario() {
      if (previewModal) return;

      previewModal = document.createElement('div');
      previewModal.className = 'chat-widget__preview-modal';
      previewModal.hidden = true;

      previewModalDialog = document.createElement('div');
      previewModalDialog.className = 'chat-widget__preview-modal-dialog';
      previewModalDialog.setAttribute('role', 'dialog');
      previewModalDialog.setAttribute('aria-modal', 'true');
      previewModalDialog.setAttribute('aria-label', 'Rascunho visual em tela cheia, gerado pela Bússola');
      previewModalDialog.setAttribute('tabindex', '-1');

      var header = document.createElement('div');
      header.className = 'chat-widget__preview-modal-header';

      var label = document.createElement('p');
      label.className = 'chat-widget__preview-modal-label';
      label.textContent = 'mockup visual · sandbox, sem script';
      header.appendChild(label);

      previewModalCloseBtn = document.createElement('button');
      previewModalCloseBtn.type = 'button';
      previewModalCloseBtn.className = 'chat-widget__preview-modal-close';
      previewModalCloseBtn.setAttribute('aria-label', 'Fechar visualização em tela cheia');
      previewModalCloseBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
      previewModalCloseBtn.addEventListener('click', function () { fecharPreviewModal(); });
      header.appendChild(previewModalCloseBtn);

      previewModalDialog.appendChild(header);

      previewModalFrame = document.createElement('iframe');
      previewModalFrame.className = 'chat-widget__preview-modal-frame';
      // MESMA restrição de segurança do card pequeno — nunca mudar.
      previewModalFrame.setAttribute('sandbox', 'allow-same-origin');
      previewModalFrame.setAttribute('title', 'Rascunho visual gerado pela Bússola, em tela cheia');
      // tabindex="-1" de propósito: fora da ordem de tabulação — ver nota
      // longa em focaveisDentroDoPreviewModal(), acima, sobre por que
      // isso é necessário pro focus trap funcionar de verdade (achado em
      // teste real: Tab entrando no conteúdo do iframe escapava da
      // modal, porque o keydown ali não propaga pro document pai).
      previewModalFrame.setAttribute('tabindex', '-1');
      previewModalDialog.appendChild(previewModalFrame);

      previewModal.appendChild(previewModalDialog);
      document.body.appendChild(previewModal);

      // Clique no backdrop (fora do dialog) também fecha — padrão comum
      // de modal. O teste é só "o alvo do clique é o próprio overlay",
      // nunca um filho (o dialog não precisa de stopPropagation).
      previewModal.addEventListener('click', function (ev) {
        if (ev.target === previewModal) fecharPreviewModal();
      });
    }

    function onPreviewModalFechouTransicao(ev) {
      if (ev.target !== previewModal || ev.propertyName !== 'opacity') return;
      finalizarFechamentoPreviewModal();
    }

    function limparFechamentoPreviewModalPendente() {
      if (previewModalFechandoTimeoutId !== null) {
        clearTimeout(previewModalFechandoTimeoutId);
        previewModalFechandoTimeoutId = null;
      }
      previewModal.removeEventListener('transitionend', onPreviewModalFechouTransicao);
      previewModal.classList.remove('is-closing');
    }

    // Passo final do fechamento — só depois que a transição de saída já
    // terminou visualmente (ou de imediato, com movimento reduzido).
    // Esvazia o iframe (libera o conteúdo em memória) e devolve o foco
    // pro elemento que abriu a modal (acessibilidade: nunca perder o
    // foco no <body> ao fechar um dialog).
    function finalizarFechamentoPreviewModal() {
      limparFechamentoPreviewModalPendente();
      previewModal.hidden = true;
      previewModalFrame.srcdoc = '';
      document.removeEventListener('keydown', onPreviewModalKeydown);
      var devolverFocoPara = previewModalInvoker;
      previewModalInvoker = null;
      if (devolverFocoPara && typeof devolverFocoPara.focus === 'function') {
        devolverFocoPara.focus();
      }
    }

    // Abre a modal com o MESMO srcdoc do card pequeno (nunca gera/busca
    // de novo). `invoker` é o botão de expandir clicado — guardado pra
    // devolver o foco a ele quando a modal fechar.
    function abrirPreviewModal(mockupHtml, invoker) {
      criarPreviewModalSeNecessario();
      limparFechamentoPreviewModalPendente();
      previewModalInvoker = invoker || null;
      previewModalFrame.srcdoc = mockupHtml;
      previewModal.hidden = false;
      if (!prefereMovimentoReduzido()) {
        // Mesmo reflow forçado do painel principal (ver abrirPainel) —
        // sem isso, hidden=false + .is-open se fundem na mesma atualização
        // de estilo e a transição de entrada não anima.
        void previewModal.offsetHeight;
      }
      previewModal.classList.add('is-open');
      document.addEventListener('keydown', onPreviewModalKeydown);
      // Foco inicial dentro do dialog (WAI-ARIA Authoring Practices): o
      // botão de fechar é o primeiro elemento interativo útil.
      previewModalCloseBtn.focus();
    }

    function fecharPreviewModal() {
      if (!previewModal || previewModal.hidden || previewModal.classList.contains('is-closing')) return;
      previewModal.classList.remove('is-open');
      previewModal.classList.add('is-closing');
      document.removeEventListener('keydown', onPreviewModalKeydown);

      if (prefereMovimentoReduzido()) {
        finalizarFechamentoPreviewModal();
        return;
      }
      previewModal.addEventListener('transitionend', onPreviewModalFechouTransicao);
      previewModalFechandoTimeoutId = setTimeout(finalizarFechamentoPreviewModal, PANEL_TRANSITION_MS + 80);
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

    // MUDANÇA 4 (ver comentário grande junto de entrarFullscreenEmbutido,
    // mais abaixo): foco no campo de texto é um dos dois gatilhos reais de
    // "começar a usar" o painel embutido no celular (o outro é clique num
    // chip de sugestão, no forEach de chipButtons, mais abaixo). No modo
    // launcher (!embedded) é no-op (entrarFullscreenEmbutido já retorna
    // cedo se !embedded) — o launcher continua usando o fluxo de tela
    // cheia de sempre, acionado em abrirPainel.
    input.addEventListener('focus', function () {
      entrarFullscreenEmbutido({ restaurarFoco: true });
    });

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

    // MUDANÇA 4 (2026-10-08, pedido direto do fundador pós-teste real em
    // celular: "fica inutilizável, precisa se adaptar como app de chat"):
    // o modo embutido (home) tinha o hack de tela cheia DELIBERADAMENTE
    // desligado (ver MUDANÇA 3, header do arquivo) — ficava sempre inline,
    // em qualquer tamanho de tela. Isso é certo pro estado de REPOUSO (o
    // painel pequeno dentro do fluxo da seção), mas o fundador testou o
    // momento de INTERAGIR de verdade (focar o campo pra digitar, ou tocar
    // num chip de sugestão) com o painel ainda pequeno e inline: no
    // celular, o painel embutido some atrás do teclado virtual, campo
    // minúsculo — inutilizável. Reverte a decisão só pra esse momento: ao
    // focar o campo OU clicar num chip, com tela <1024px, o painel embutido
    // entra em tela cheia reaproveitando o MESMO mecanismo acima
    // (moverPainelParaFullscreen), que já corrigiu o bug de clipping
    // (BUG 1, comentário grande acima) — não reinventa nada, só aciona o
    // reparenting pra <body> também no caso embutido, condicionado à
    // interação real em vez de ligado sempre (que é exatamente o que a
    // MUDANÇA 3 queria evitar: nenhuma mudança de layout chamativa só por
    // a página ter carregado).
    //
    // Saída é uma função PRÓPRIA (sairDoFullscreenEmbutido), não
    // fecharPainel(): fecharPainel() existe pro modo launcher, onde
    // "fechar" significa esconder o painel inteiro (panel.hidden = true,
    // ver finalizarFechamentoPainel) — errado aqui, porque no modo
    // embutido o painel É o produto da seção (ver MUDANÇA 3) e nunca pode
    // ficar escondido. Sair da tela cheia embutida só devolve o painel
    // pro lugar original (devolverPainelAoLugarOriginal, mesmo mecanismo
    // de sempre) e mantém root.is-open/panel.is-open como já estavam —
    // o painel continua visível, só que de volta ao tamanho inline normal
    // do fluxo da página.
    //
    // Importante (ver pedido do fundador, item 2): a saída SÓ acontece
    // pelo botão de fechar (closeBtn, mesmo affordance "Fechar" que já
    // existe pro modo launcher em tela cheia — CSS em
    // .chat-widget__panel--fullscreen .chat-widget__close, chat-widget.css,
    // não depende de onde o painel está no DOM). NUNCA por perda de foco
    // (blur) — não existe nenhum listener de blur neste arquivo, de
    // propósito: o usuário pode tocar num chip ou rolar a lista de
    // mensagens sem querer "fechar".
    // BUG encontrado NESTA rodada, ao testar de verdade via CDP (clique real
    // no campo, não dispatchEvent sintético): mover um elemento FOCADO para
    // um novo pai no DOM (appendChild, dentro de moverPainelParaFullscreen)
    // zera o foco — document.activeElement volta pro <body> assim que o
    // reparenting acontece (confirmado ao vivo, não presumido). Isso é grave
    // justamente aqui porque a entrada em tela cheia É disparada pelo
    // próprio evento `focus` do campo: sem corrigir, o teclado virtual
    // chegaria a abrir e fechar na mesma interação — exatamente o problema
    // original ("teclado cobre a área") que esta mudança existe pra
    // resolver, só que de um jeito diferente (perda de foco em vez de
    // clipping). O modo launcher nunca bateu nesse bug porque lá a ordem já
    // era a certa por acaso: moverPainelParaFullscreen() roda dentro de
    // abrirPainel() e SÓ DEPOIS vem `if (foco) input.focus()` — reparenta
    // primeiro, foca depois. Aqui é o oposto (o foco já aconteceu, é ele
    // que dispara o reparenting), então precisa restaurar o foco
    // explicitamente depois de mover o nó.
    // opts.restaurarFoco só é passado true pelo listener de `focus` do
    // campo (abaixo) — NUNCA pelo clique em chip: ali o campo nunca foi
    // focado pra começar (mesmo padrão do resto do arquivo: clique em chip
    // não força abertura de teclado, ver enviarMensagem/enviarMensagemReal,
    // nenhum input.focus() ali).
    function entrarFullscreenEmbutido(opts) {
      if (!embedded || panelEstaFullscreen) return;
      if (!dentroDoBreakpointMobileFullscreen()) return;
      atualizarAlturaHeaderFullscreen();
      moverPainelParaFullscreen();
      document.body.classList.add('is-chat-fullscreen-open');
      if (opts && opts.restaurarFoco) {
        input.focus();
      }
    }
    function sairDoFullscreenEmbutido() {
      if (!panelEstaFullscreen) return;
      devolverPainelAoLugarOriginal();
      document.body.classList.remove('is-chat-fullscreen-open');
      // Propositalmente NÃO toca panel.hidden nem root/panel.classList
      // 'is-open' — o painel embutido continua aberto/visível, só volta a
      // ser um bloco inline normal da seção (requisito do fundador: nunca
      // esconder o painel embutido).
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
    // MUDANÇA 4 (ver comentário grande junto de entrarFullscreenEmbutido/
    // sairDoFullscreenEmbutido, acima): o mesmo botão físico (closeBtn, já
    // reaproveitado do modo launcher — affordance "Fechar" em
    // chat-widget.css) precisa de dois comportamentos diferentes conforme
    // o contexto. Se o painel embutido está em tela cheia (entrou por foco
    // no campo ou clique num chip), fechar significa só devolver ao
    // tamanho inline normal da seção — NUNCA esconder o painel (ele é o
    // produto da seção). Em qualquer outro caso (modo launcher, ou
    // embutido já no tamanho normal) o comportamento é o de sempre:
    // fecharPainel() esconde o painel inteiro.
    closeBtn.addEventListener('click', function () {
      if (embedded && panelEstaFullscreen) {
        sairDoFullscreenEmbutido();
      } else {
        fecharPainel();
      }
    });

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
        // MUDANÇA 4 (ver comentário grande junto de
        // entrarFullscreenEmbutido, acima): clique num chip é o segundo
        // gatilho real de "começar a usar" o painel embutido no celular
        // (o outro é foco no campo, registrado acima). No modo launcher
        // é no-op.
        entrarFullscreenEmbutido();
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
