/**
 * Refúgio Tech — main.js
 * Efeito sutil de fade-in ao rolar a página. Vanilla JS, sem dependências.
 *
 * Degradação segura: a classe "reveal-ready" só é adicionada à <html>
 * quando este script efetivamente roda. O CSS só oculta os elementos
 * .reveal quando essa classe existe — então, sem JS, ou se o arquivo
 * falhar ao carregar, ou se o navegador não suportar IntersectionObserver,
 * o conteúdo permanece visível desde o início (nunca fica em branco).
 */
(function () {
  "use strict";

  var root = document.documentElement;
  var reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  if (reduceMotion || !("IntersectionObserver" in window)) {
    return; // mantém o conteúdo visível, sem animação
  }

  var revealEls = document.querySelectorAll(".reveal");
  if (!revealEls.length) return;

  root.classList.add("reveal-ready");

  // Correção crítica: sem isto, elementos já visíveis no primeiro
  // frame (hero, por exemplo) ficam com opacity:0 até o
  // IntersectionObserver disparar de forma assíncrona — em alguns
  // navegadores/condições isso cria um "flash" de conteúdo em branco
  // (confirmado em captura headless: headline, parágrafo e CTA
  // ficaram invisíveis no primeiro frame). Verificação síncrona aqui
  // marca como visível, antes da primeira pintura, tudo que já está
  // dentro do viewport no carregamento.
  function inViewport(el) {
    var rect = el.getBoundingClientRect();
    var viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    return rect.top < viewportHeight && rect.bottom > 0;
  }

  revealEls.forEach(function (el) {
    if (inViewport(el)) {
      el.classList.add("is-visible");
    }
  });

  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    {
      threshold: 0.15,
      rootMargin: "0px 0px -40px 0px",
    }
  );

  revealEls.forEach(function (el) {
    if (!el.classList.contains("is-visible")) {
      observer.observe(el);
    }
  });
})();

/**
 * Formulário de contato (Web3Forms) — melhoria progressiva.
 * Sem este script, o <form> ainda funciona: submit normal via POST,
 * Web3Forms processa e redireciona para a URL do campo "redirect"
 * (mesma página, com "?mensagem-enviada=1"). Com o script, a
 * submissão vira fetch/AJAX: sem sair da página, com mensagem de
 * sucesso/erro inline.
 */
(function () {
  "use strict";

  function showStatus(el, message, state) {
    el.textContent = message;
    if (state) {
      el.setAttribute("data-state", state);
    } else {
      el.removeAttribute("data-state");
    }
  }

  // Caso de fallback sem JS: se o redirect do Web3Forms trouxe o
  // visitante de volta com "?mensagem-enviada=1", mostra a confirmação.
  function checkRedirectReturn(statusEl) {
    var params = new URLSearchParams(window.location.search);
    if (params.get("mensagem-enviada") === "1") {
      showStatus(statusEl, "Mensagem enviada. Obrigado — vamos responder em breve.", "success");
      var url = new URL(window.location.href);
      url.searchParams.delete("mensagem-enviada");
      window.history.replaceState({}, "", url.pathname + url.hash);
    }
  }

  var form = document.getElementById("contact-form");
  if (!form) return;

  var statusEl = document.getElementById("contact-form-status");
  if (statusEl) checkRedirectReturn(statusEl);

  if (typeof window.fetch !== "function") return; // sem fetch, cai no POST normal

  form.addEventListener("submit", function (event) {
    event.preventDefault();

    if (!form.reportValidity()) return;

    var submitBtn = form.querySelector('button[type="submit"]');
    var originalLabel = submitBtn ? submitBtn.textContent : "";
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Enviando…";
    }
    showStatus(statusEl, "Enviando…", null);

    fetch(form.action, {
      method: "POST",
      body: new FormData(form),
      headers: { Accept: "application/json" },
    })
      .then(function (response) {
        return response.json().then(function (data) {
          return { ok: response.ok, data: data };
        });
      })
      .then(function (result) {
        if (result.ok && result.data && result.data.success) {
          showStatus(statusEl, "Mensagem enviada. Obrigado — vamos responder em breve.", "success");
          form.reset();
        } else {
          showStatus(
            statusEl,
            "Não deu para enviar agora. Tente de novo em instantes ou escreva direto para contato@refugio.tech.",
            "error"
          );
        }
      })
      .catch(function () {
        showStatus(
          statusEl,
          "Não deu para enviar agora. Tente de novo em instantes ou escreva direto para contato@refugio.tech.",
          "error"
        );
      })
      .finally(function () {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = originalLabel;
        }
      });
  });
})();
