
  # Refúgio Tech — Website

  Este repositório reúne os artefatos de site institucional da Refúgio Tech.
  A partir de 2026-10-02, por convenção organizacional, todo projeto técnico
  da Refúgio Tech vive em `/home/lito/projects/Refúgio Tech/` — este
  repositório é o destino correto para o código do site (nunca o repositório
  de estratégia/decisão `Consultoria`).

  ## Estado atual — dois sites no mesmo repositório, decisão pendente

  | | Localização | Stack | Status |
  |---|---|---|---|
  | **Site Premium (Figma Make)** | raiz (`src/`, `public/`, `dist/`, `package.json`) | React + Vite + Tailwind + MUI + Radix | Completo, com fonte Balgin da marca já embutida (`public/fonts/`). Commits anteriores à migração de 2026-10-02 (`Site inicial`, `github pages`). **Não está publicado em produção hoje** (sem domínio customizado, sem workflow de GitHub Pages configurado — o commit "github pages" apenas versionou o `dist/`, não configurou o Pages). Copy/conteúdo ainda não revisado pelo fundador para publicação pública. |
  | **static-site/** | `static-site/` | HTML + CSS puro, sem build | Minimalista. **É o que está publicado hoje** em `https://refugio-tech.web.app` (Firebase Hosting, projeto GCP `refugio-tech`). Construído pelo Diretor de Engenharia (Hermes) e migrado para este repositório em 2026-10-02 — antes vivia, incorretamente, no repositório de estratégia `Consultoria`. |

  `firebase.json` (raiz deste repositório) aponta o Hosting para `static-site/`,
  preservando exatamente o que já estava no ar no momento da migração.

  **Qual dos dois vira o site institucional definitivo é uma decisão do
  fundador, ainda em aberto.** Contexto completo da investigação, recomendação
  e histórico em `docs/infra-site-dominio-hospedagem.md` no repositório
  `Consultoria`.

  ## Site Premium (Figma Make) — como rodar

  Projeto original disponível em
  https://www.figma.com/design/P4f9VRyQ6if4aIgUQo485h/Premium-Website-for-Ref%C3%BAgio-Tech.

  Run `npm i` to install the dependencies.

  Run `npm run dev` to start the development server.

  ## static-site/ — como rodar

  Página única estática: abra `static-site/index.html` direto no navegador.
  Deploy: `firebase deploy --only hosting --project refugio-tech` (a partir
  da raiz deste repositório). Detalhes em `static-site/README.md`.
