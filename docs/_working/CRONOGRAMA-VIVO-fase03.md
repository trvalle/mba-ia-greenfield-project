# Cronograma Vivo — Fase 03 (Upload e Processamento de Vídeos)

> **Como usar:** este é um documento vivo. A cada passo concluído, troque o status do item.
> Legenda: ✅ Concluído · 🔄 Em andamento · ⬜ Pendente · ⚠️ Atenção/observação
>
> Última atualização: **SI-03.1 concluído** (2 de 9 SIs).

---

## Visão geral (barra de progresso)

```
PLANEJAMENTO  ██████████████████████████  100%  ✅ (research → plano validado)
IMPLEMENTAÇÃO ██████░░░░░░░░░░░░░░░░░░░░░░   22%  🔄 (2 de 9 SIs)
FECHAMENTO    ░░░░░░░░░░░░░░░░░░░░░░░░░░░░    0%  ⬜ (DoD + docs + PR)
```

---

## PARTE 1 — Pipeline de planejamento (a "planta da obra")

| # | Etapa | Artefato gerado | Status |
|---|-------|-----------------|--------|
| 1 | Setup do ambiente (fork, branch, Docker, baseline, context7) | — | ✅ |
| 2 | **research** — decisões técnicas | `technical-decisions-phase-03-videos.md` (8 TDs decididos) | ✅ |
| 3 | **plan-context** — consolidar contexto | `context.md` (9 capabilities cobertas) | ✅ |
| 4 | **plan-validate** — validar | `validation.md` (dirty → 7 issues) | ✅ |
| 5 | **plan-resolve** — resolver pendências | issues resolvidas + `library-refs.md` | ✅ |
| 6 | **plan-validate (re)** — confirmar | `validation.md` → **clean** | ✅ |
| 7 | **plan-build** — gerar o plano | `phase-03-videos.md` (SI-03.0 a SI-03.8 + Tech Specs) | ✅ |

**Parte 1: 100% concluída.** ✅

---

## PARTE 2 — Implementação (as "etapas de obra" — SIs)

| SI | O que faz (linguagem simples) | Depende de | Status | Verificação real feita? |
|----|-------------------------------|------------|--------|--------------------------|
| **SI-03.0** | **Infraestrutura** — liga os equipamentos: armazém (MinIO), fila (Redis), operário (worker+FFmpeg), variáveis de ambiente, libs | — | ✅ | ✅ 6 containers Up, ffmpeg 5.1.9, tsc OK |
| **SI-03.1** | **Ficha do vídeo** — tabela `videos` no banco, ligada ao canal, + repositório | SI-03.0 | ✅ | ✅ 3 migrations limpas, 19 testes verdes, módulo registrado |
| **SI-03.2** | **Conexão com o armazém** — StorageModule: cria bucket, gera links de upload/download (presigned), lê/grava objetos no MinIO | SI-03.0 | 🔄 **PRÓXIMO** | ⬜ |
| **SI-03.3** | **Fila de tarefas** — RedisModule/BullMQ: a "esteira" que leva os vídeos pro operário processar | SI-03.0 | ⬜ | ⬜ |
| **SI-03.4** | **Endpoints de upload** — as "portas" da API: inicia upload (rascunho), recebe confirmação, dispara o processamento | SI-03.1, 03.2, 03.3 | ⬜ | ⬜ |
| **SI-03.5** | **Streaming** — toca o vídeo aos pedaços (Range/206) + download | SI-03.1, 03.2 | ⬜ | ⬜ |
| **SI-03.6** | **O operário (worker)** — pega o vídeo da fila, extrai duração/metadados (ffprobe), gera a capa (ffmpeg), marca como pronto | SI-03.2, 03.3 | ⬜ | ⬜ |
| **SI-03.7** | **Tratamento de erros** — respostas de erro no padrão da Fase 02, status "failed" quando algo dá errado | SI-03.4, 03.5, 03.6 | ⬜ | ⬜ |
| **SI-03.8** | **Reforço dos testes** — garante que os testes de integração sejam robustos (não quebram por ordem de execução) | todos anteriores | ⬜ | ⬜ |

**Parte 2: 2 de 9 SIs (22%).** 🔄

> ⚠️ **Regra de ouro da execução (vale para todo SI):** o relatório do Claude Code diz "✅ PASS", mas
> a verificação REAL é feita no terminal (migration aplica? container sobe? teste passa isolado?).
> Já pegamos 2 bugs reais assim (timestamp de migration de 10 dígitos; banco em estado inconsistente)
> que o relatório do agente havia mascarado. **Nunca aprovar SI só pelo relatório.**

---

## PARTE 3 — Fechamento (entrega final)

| # | Item | Comando / ação | Status |
|---|------|----------------|--------|
| 1 | Suíte unit+integração verde | `docker compose exec nestjs-api npm test -- --runInBand` | ⬜ |
| 2 | Suíte e2e verde | `docker compose exec nestjs-api npm run test:e2e` | ⬜ |
| 3 | TypeScript compila (código 0) | `docker compose exec nestjs-api npx tsc --noEmit` | ⬜ |
| 4 | Lint passa | `docker compose exec nestjs-api npm run lint` | ⬜ |
| 5 | `progress.md` da fase completo | (atualizado a cada SI) | 🔄 |
| 6 | `CLAUDE.md` atualizado com seção de vídeos | editar refletindo o código real | ⬜ |
| 7 | Push da branch + PR `feature/phase-03-videos` → `dev` (nunca `main`) | `git push origin feature/phase-03-videos` | ⬜ |
| 8 | Revisão final dos Critérios de Aceite item a item | conferir lista do enunciado | ⬜ |

---

## Checklist dos Critérios de Aceite (cópia do enunciado — marcar no fim)

**Decisões e planejamento**
- [x] `technical-decisions-phase-03-videos.md` com fila, upload, streaming, processamento/thumbnail, ciclo de status
- [x] Pasta `phase-03-videos/` com context.md, validation.md (clean), plano, progress.md, library-refs.md
- [x] Plano com SIs SI-03.x + Technical Specs (Data Model, API Contracts, Authorization Matrix, Error Catalog, Events/Messages) + Dependency Map + Deliverables

**Feature**
- [ ] Upload até 10GB sem travar a API, com pré-cadastro como rascunho
- [ ] Processamento automático: duração/metadados + thumbnail
- [ ] URL única por vídeo, sem conflito
- [ ] Streaming (Range/206) + download
- [ ] Ciclo de status (draft → processing → ready/failed) no banco

**Infra e qualidade**
- [x] Storage (MinIO), fila (Redis) e worker subindo via docker compose *(SI-03.0)*
- [x] Migration cria a tabela de vídeos; entidade ligada ao canal *(SI-03.1)*
- [ ] Testes nos níveis adequados, verdes (`npm test` e `npm run test:e2e`)
- [ ] DoD completa: suíte verde + `tsc --noEmit` (0) + `lint`
- [x] Git Flow respeitado (feature/* a partir de dev, sem commit em main)

**Documentação**
- [ ] `CLAUDE.md` atualizado com a seção de vídeos, coerente com o código

---

## Registro de observações (fora de escopo / dívidas anotadas)

| Data | Observação | Ação |
|------|------------|------|
| baseline | `migrations.integration-spec.ts` da Fase 02 falha na suíte completa (contaminação de schema entre suítes); passa isolado. Fragilidade pré-existente do repo base. | Fora de escopo. SI-03.8 garante que os testes da Fase 03 sejam robustos a ordem. |
| SI-03.1 | Agente gerou migration com timestamp inválido (10 dígitos) e deixou o banco em estado inconsistente; relatório dizia "PASS" mas `migration:run` falhava. | Corrigido: timestamp real (`1782433349864`) via revert cirúrgico; 3 migrations aplicam limpas. |

---

## Log de commits da fase (rastreabilidade)

| Commit | Conteúdo |
|--------|----------|
| `docs(phase-03)` | playbook + research-input (material de apoio) |
| `docs(phase-03)` | decisões técnicas (research) com versões confirmadas |
| `docs(phase-03)` | context, validation clean e library-refs (planejamento) |
| `docs(phase-03)` | plano executável com SIs e technical specs (plan-build) |
| `feat(phase-03)` | SI-03.0 infraestrutura (redis, minio, video-worker, ffmpeg, env) |
| `feat(phase-03)` | SI-03.1 entidade Video, migration e repository |
| `feat(phase-03)` | SI-03.1 registra VideosModule e entidade no app e test data-source |
