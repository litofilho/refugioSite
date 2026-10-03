
  # Refúgio Tech — Website

  Site institucional de página única da Refúgio Tech. Repositório git dedicado
  — por convenção organizacional (ver `docs/convencoes-tecnicas.md` e
  `docs/infra-site-dominio-hospedagem.md` no repositório `Consultoria`), todo
  projeto técnico da Refúgio Tech vive em `/home/lito/projects/Refúgio Tech/`,
  nunca no repositório de estratégia/decisão.

  ## Reconstrução de 2026-10-02 — site atual

  Até 2026-10-02 este repositório tinha dois sites concorrentes, sem definição
  de qual era o definitivo (um "site premium" em React/Vite/Tailwind feito via
  Figma Make, e um `static-site/` HTML+CSS mínimo). Por decisão do fundador,
  **nenhum dos dois** virou o definitivo — o site foi refeito do zero porque a
  execução visual de ambos estava amadora/simplória demais para a marca
  (boutique, qualidade, solidez).

  O conteúdo publicado hoje vive em `site/` (HTML + CSS + um pouco de JS
  vanilla, sem build, sem framework). Escopo de conteúdo mantido idêntico ao
  anterior — hero, parágrafo honesto sobre o projeto estar em construção,
  contato, footer — só a execução visual (tipografia, composição, paleta,
  responsividade) foi elevada. Copy e design desta versão foram produzidos por
  dois agentes efêmeros (conteúdo e design/frontend), orquestrados e revisados
  pelo Diretor de Engenharia antes do deploy. Detalhe completo da execução,
  dos bugs encontrados/corrigidos na revisão e da verificação pós-deploy em
  `docs/infra-site-dominio-hospedagem.md` (repositório `Consultoria`), seção
  "Reconstrução visual do site — 2026-10-02".

  ### Onde ficou o conteúdo anterior

  Os dois sites anteriores (premium Figma Make e `static-site/`) foram movidos
  para `_obsoleto-pre-reconstrucao-2026-10-02/` nesta mesma pasta, **fora do
  controle de versão** (está em `.gitignore` — inclui `node_modules/`, ~370MB).
  Isso preserva os arquivos como rede de segurança local, mas o histórico real
  e auditável está no git: o estado completo de ambos os sites antes desta
  reconstrução continua acessível em qualquer commit anterior a
  2026-10-02 (`git log`), por exemplo `git show <commit>:index.html`.

  ## Estrutura

  ```
  site/
    index.html
    assets/
      css/styles.css
      js/main.js
      refugio-tech.svg      (logo oficial completo, ativos/marca/ do repositório Consultoria)
      refugio-tech-mark.svg (recorte só do símbolo, sem o texto — usado no lockup horizontal do header)
      favicon.png
      fonts/
        balgin-light.otf        (fonte principal da marca — recuperada do
        balgin-extralight.otf   site premium antes de ser arquivado)
  firebase.json   — Hosting aponta para site/
  .firebaserc     — projeto Firebase/GCP: refugio-tech
  ```

  ## Como rodar localmente

  Página estática pura — não precisa de build nem servidor específico:

  ```
  cd site && python3 -m http.server 8080
  # abrir http://localhost:8080
  ```

  (ou abrir `site/index.html` direto no navegador — funciona igual, exceto
  que alguns navegadores restringem `fetch`/fontes locais via `file://`; usar
  um servidor local evita isso)

  ## Deploy

  ```
  cd "/home/lito/projects/Refúgio Tech/Website"
  firebase deploy --only hosting --project refugio-tech
  ```

  Publica em `https://refugio-tech.web.app` e, via domínio customizado já
  configurado, em `https://refugio.tech`. Detalhe de domínios/DNS/certificado
  em `docs/infra-site-dominio-hospedagem.md` no repositório `Consultoria`.
