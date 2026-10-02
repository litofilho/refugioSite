# static-site/ — site institucional mínimo (HTML+CSS puro)

Status: **é o conteúdo publicado hoje** em `https://refugio-tech.web.app`
(Firebase Hosting, projeto GCP `refugio-tech`), enquanto o domínio final
`refugio.tech` não está apontado.

Origem: construído pelo Diretor de Engenharia (perfil Hermes
`diretor-engenharia`) no repositório `Consultoria` (decisão/contexto/
conhecimento da Refúgio Tech), e migrado para este repositório em
2026-10-02 por instrução do fundador — código de produto não deve viver
no repositório de estratégia.

Página única, estática, sem build, sem dependência de servidor: abra
`index.html` direto no navegador.

## Atenção — decisão em aberto

Este repositório também contém, na raiz, um site **premium** construído em
React/Vite/Tailwind via Figma Make (ver `README.md` principal), com commits
anteriores a esta migração. Os dois sites são incompatíveis (stacks
diferentes) e não foram unificados. **Qual dos dois é o site institucional
definitivo é uma decisão do fundador**, ainda pendente — ver
`docs/infra-site-dominio-hospedagem.md` no repositório `Consultoria` para o
histórico completo da investigação e a recomendação registrada.

Até essa decisão, `firebase.json` (na raiz deste repositório) aponta o
Firebase Hosting para esta pasta (`static-site/`), preservando exatamente o
que já estava no ar — nenhuma mudança de conteúdo público aconteceu nesta
migração.

## Deploy

```
cd ".../Refúgio Tech/Website"
firebase deploy --only hosting --project refugio-tech
```
