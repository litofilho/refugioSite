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
