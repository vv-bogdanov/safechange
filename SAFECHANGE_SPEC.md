# SafeChange — техническое задание для coding-агента

**Статус:** принятое исходное ТЗ для PoC и MVP; сохраняется как design record

**Проект:** SafeChange  
**Трек:** OpenAI Build Week — Developer Tools  
**Основной стек:** TypeScript / Node.js  
**Основной интерфейс:** CLI  
**AI runtime:** Codex App Server через локальный `stdio` transport

---

## 1. Контекст проекта

SafeChange создаётся для OpenAI Build Week. Проект относится к категории **Developer Tools**, куда входят инструменты для testing, DevOps, agentic workflows и security.

Хакатон оценивает проекты по четырём равнозначным направлениям:

1. технологическая реализация и реальное использование Codex;
2. целостность и работоспособность продукта;
3. потенциальный практический эффект;
4. качество и новизна идеи.

Для submission нужен работающий проект, репозиторий с понятным запуском, публичное демо-видео продолжительностью менее трёх минут и способ протестировать developer tool без его пересборки с нуля. Дедлайн — **21 июля 2026 года, 17:00 PT**, то есть **22 июля 2026 года, 07:00 по Бангкоку**.

Цель команды — не просто показать технический эксперимент, а сделать небольшой, законченный и убедительный инструмент, который демонстрирует новый способ работы с coding-агентами.

### Почему выбран SafeChange

Современный coding-агент часто выполняет весь цикл в одном контексте:

```text
понять задачу
→ выбрать первое правдоподобное решение
→ изменить код
→ изменить или добавить тесты
→ самостоятельно оценить результат
```

Такой процесс имеет системные слабости:

- первая идея может быть не лучшей и создаёт anchoring;
- планирование часто недостаточно отделено от реализации;
- агент может не заметить недостающие проверки до изменения кода;
- тесты могут быть подогнаны под выбранную реализацию;
- область изменения может незаметно расшириться;
- автор изменения склонен подтверждать собственное решение;
- «тесты прошли» не означает, что выполнен исходный контракт;
- длинная сессия загрязняется логами, ошибочными гипотезами и промежуточными попытками;
- Git rollback возвращает исходный код, но не обязательно внешнее состояние.

SafeChange должен уменьшить эти риски с помощью структурированного процесса, а не обещать абсолютную невозможность поломки.

---

## 2. Суть продукта

SafeChange — orchestration- и verification-слой вокруг Codex для безопасного внесения изменений в существующий репозиторий.

Пользователь формулирует намерение обычным языком, например:

> Добавь автоматические повторы платежа при временном сбое провайдера, но не допускай двойного списания и не меняй публичный API.

SafeChange:

1. исследует репозиторий;
2. формализует задачу и защищаемые свойства;
3. независимо рассматривает несколько подходов;
4. выбирает минимально достаточный безопасный план;
5. сначала создаёт недостающую страховочную сетку;
6. реализует один выбранный план в отдельной Git-ветке;
7. запускает объективные проверки;
8. независимо сопоставляет фактический результат с исходной задачей;
9. выдаёт готовую ветку и отчёт либо останавливается с конкретной причиной.

### Краткий product pitch

> **SafeChange explores multiple approaches before touching code, builds the missing safety net, implements the safest minimal plan, and independently verifies the actual change.**

### Основная формула

```text
COMPARE BEFORE CODING
→ TEST BEFORE IMPLEMENTATION
→ VERIFY AGAINST THE ORIGINAL CONTRACT
```

---

## 3. Целевая аудитория

Основная аудитория MVP:

- разработчики, использующие Codex для изменений в существующих проектах;
- команды, которым важны регрессии, scope control и объяснимость решений;
- DevOps-инженеры, использующие агентов для изменения конфигурации и инфраструктурного кода;
- владельцы критичных частей продукта: платежи, auth, permissions, данные, интеграции.

MVP оптимизируется под **TypeScript / Node.js repositories**, но архитектура не должна искусственно связывать orchestration с конкретным test framework.

---

## 4. Цели MVP

SafeChange MVP должен доказать следующие продуктовые гипотезы.

### 4.1. Несколько независимых планов полезнее первого ответа

Пользователь задаёт количество планов `N`. Значение по умолчанию — 3; разумный диапазон MVP — от 1 до 5.

Каждый planner должен предложить не косметическую вариацию, а самостоятельный подход и затем превратить его в конкретный план по текущему репозиторию.

### 4.2. Контекст можно сохранять без загрязнения ролей

Общее понимание задачи должно сохраняться через fork канонической Codex-сессии, но промежуточные рассуждения одного исполнителя не должны автоматически переходить другому.

### 4.3. Проверки должны появляться до реализации

SafeChange должен сначала определить, каких доказательств не хватает для выбранного изменения, и создать защищаемый safety harness до реализации production-кода.

### 4.4. Реализация должна соответствовать выбранному scope

Фактические изменения должны сравниваться с планом. Неожиданная dependency, migration, protected-file change или расширение затронутой области должны приводить к остановке или перепланированию.

### 4.5. Итог должен проверяться независимо

Verifier должен оценивать изменение относительно исходного Change Contract и фактических результатов команд, не наследуя transcript Implementer.

### 4.6. Пользователь должен получить законченный артефакт

Успешный запуск заканчивается:

- отдельной Git-веткой;
- понятной историей коммитов;
- добавленными проверками;
- реализованным изменением;
- verification report;
- явным остаточным риском и ограничениями rollback.

---

## 5. Не-цели MVP

Следующие возможности сознательно исключаются до доказательства основного workflow:

- web UI;
- GitHub App;
- MCP integrations;
- production deployment;
- выполнение `terraform apply`, `kubectl apply` и других production writes;
- реальный canary rollout;
- автоматический rollback внешних систем;
- управление Git worktrees;
- реализация нескольких competing plans;
- универсальный policy language;
- поддержка всех языков и package managers;
- полноценная CI/CD platform;
- доказательство отсутствия любых возможных регрессий;
- сложный multi-agent framework или workflow engine;
- длительные agent debates и рекурсивные brainstorm trees.

Не добавлять эти возможности «на будущее», пока не завершён и не продемонстрирован основной вертикальный сценарий.

---

## 6. Основные принципы

### 6.1. KISS и YAGNI

Выбирать самое простое решение, которое полностью поддерживает утверждённый workflow. Не создавать общие abstraction layers без реального второго use case.

### 6.2. No evidence — no change

Если для значимого требования или защищаемого свойства нет достаточной проверки, SafeChange должен сначала создать проверку либо честно остановиться.

### 6.3. Самый простой допустимый план, а не самый короткий план

KISS применяется после исключения планов, которые не выполняют контракт, недостаточно проверяемы или имеют неприемлемый recovery path.

### 6.4. Один writer

Параллельность разрешена для read-only planning. Изменения рабочей директории выполняются строго последовательно одним write-актором за раз.

### 6.5. Fail closed

При неизвестном состоянии, изменившемся baseline, неоднозначном результате или выходе за scope система останавливается, а не продолжает на предположениях.

### 6.6. Threads передают контекст; artifacts передают обязательства

Fork помогает роли понимать исходную задачу. Но межролевой контракт всегда выражается schema-validated artifact, а не скрытой историей разговора.

### 6.7. Источник истины — не мнение модели

Источник истины:

```text
Git state
+ validated artifacts
+ deterministic command results
```

LLM анализирует и объясняет результаты, но не подменяет exit codes, Git diff и содержимое файлов.

### 6.8. Независимость проверки

Verifier не должен наследовать reasoning или самооценку Implementer.

### 6.9. Честная граница rollback

MVP гарантирует возможность вернуться к исходному **tracked source code** через baseline branch/commit. Он не утверждает, что откатывает локальные БД, Docker volumes, очереди, внешние API или production state.

---

## 7. Канонический workflow

```text
PREFLIGHT
  ↓
SCRATCH DISCOVERY (D0)
  ↓
VALIDATED EVIDENCE ARTIFACT
  ↓
CANONICAL CONTRACT THREAD (C0)
  ↓
PLANNERS × N
  ↓
ELIGIBILITY FILTER + JUDGE
  ↓
BASELINE REVALIDATION
  ↓
CREATE SAFECHANGE BRANCH
  ↓
TEST AUTHOR → PROTECTED SAFETY HARNESS
  ↓
TEST COMMIT (T1)
  ↓
IMPLEMENTER
  ↓
IMPLEMENTATION COMMIT (I1)
  ↓
DETERMINISTIC VERIFICATION
  ↓
INDEPENDENT VERIFIER
  ↓
REPORT / VERIFIED BRANCH / EXPLICIT BLOCK
```

### 7.1. Preflight

До дорогостоящей работы SafeChange проверяет, что:

- запуск происходит в Git repository;
- определены текущая ветка и baseline commit;
- нет незакоммиченных tracked/staged изменений;
- нет незавершённого merge/rebase;
- рабочее состояние пригодно для безопасного запуска;
- доступен Codex App Server;
- требования среды не противоречат безопасному режиму MVP.

SafeChange не должен автоматически делать `stash`, `reset --hard`, `clean`, коммитить пользовательские изменения или удалять файлы.

Ignored-файлы, включая локальную конфигурацию и зависимости, остаются в текущем checkout. SafeChange не должен копировать `.env`, публиковать его содержимое или включать секреты в prompts/reports.

### 7.2. Scratch Discovery — `D0`

Discovery выполняется в новой read-only сессии.

Его задача:

- понять релевантную часть проекта;
- найти существующие execution paths;
- определить доступные test/build/lint/validation команды;
- найти текущие тесты и пробелы;
- зафиксировать ограничения из repository instructions;
- выявить неизвестные факторы;
- собрать проверяемые ссылки на файлы, символы и команды.

`D0` считается исследовательским и потенциально шумным. Он может содержать неверные промежуточные гипотезы, поэтому **не является родителем всех следующих ролей**.

Результат `D0` — компактный `Evidence Artifact`, содержащий подтверждённые факты, assumptions, unknowns и evidence references.

### 7.3. Canonical Contract — `C0`

`C0` создаётся как новая чистая сессия, а не как продолжение Discovery.

Она получает:

- исходное намерение пользователя;
- validated evidence;
- критичные repository constraints.

`C0` при необходимости выборочно перепроверяет факты и создаёт канонический Change Contract:

- goal;
- acceptance criteria;
- protected invariants;
- non-goals;
- allowed scope;
- forbidden or approval-required changes;
- known evidence gaps;
- risk flags;
- unresolved unknowns.

Завершённый turn `C0` становится immutable checkpoint, от которого fork-аются независимые роли.

В `C0` не должны попадать raw logs, planner debates, implementation attempts или длинные stack traces.

### 7.4. Независимые planners

Создаётся `N` fork-ов от канонического checkpoint `C0`.

Каждый planner:

1. формулирует самостоятельный high-level approach;
2. проверяет его по реальному репозиторию;
3. разворачивает в detailed plan;
4. может признать свой подход непригодным.

Стандартные lenses для `N = 3`:

#### Minimal-change lens

- минимальный diff;
- существующие abstractions;
- отсутствие спекулятивной архитектуры;
- отсутствие необязательных dependencies.

#### Reversible-change lens

- backward compatibility;
- сохранение старого пути, когда это оправдано;
- дешёвый rollback;
- постепенное переключение.

#### Risk-first lens

- минимальный operational blast radius;
- изоляция опасных effects;
- сильная проверяемость;
- явные stop/recovery conditions.

Для другого `N` допускаются дополнительные или пользовательские lenses, но архитектура MVP не должна превращаться в отдельную платформу brainstorming.

Каждый planner возвращает самостоятельный `Detailed Plan Artifact`, включающий:

- approach и rationale;
- acceptance coverage;
- предполагаемые компоненты и file scope;
- порядок изменения;
- необходимые safety tests;
- существующие команды проверки;
- dependencies и migrations;
- risks, assumptions и unknowns;
- recovery strategy;
- причины, по которым план может быть отклонён.

Планы не видят transcripts друг друга.

### 7.5. Eligibility filter и Judge

Сначала обычный код и формальные правила исключают планы, которые:

- не покрывают acceptance criteria;
- явно нарушают protected invariants;
- не имеют verification strategy;
- не имеют реалистичного source/recovery path;
- требуют необъяснённого расширения scope;
- скрывают critical unknowns;
- требуют необоснованной новой dependency или migration;
- невозможно достаточно проверить в доступной среде.

После этого отдельный Judge fork-ается от `C0` и получает только:

- допустимые Plan Artifacts;
- результаты формальных gates.

Judge сравнивает планы по:

- полноте выполнения цели;
- blast radius;
- обратимости;
- testability;
- сложности;
- новым dependencies;
- operational risk;
- ожидаемому diff.

Не использовать псевдоточную систему рейтинга. Итог должен содержать конкретное объяснение:

- почему выбран победитель;
- почему отвергнуты альтернативы;
- какие компромиссы остаются;
- требуется ли human decision.

### 7.6. Revalidate baseline

Перед первым write SafeChange повторно проверяет:

- baseline commit;
- Git status;
- relevant manifests;
- repository instruction sources;
- protected environment-file fingerprints, если они отслеживаются без чтения секретов.

Если исходное состояние изменилось, артефакты считаются устаревшими и run останавливается со статусом `BASELINE_CHANGED`.

### 7.7. Создание ветки

Только после завершения read-only planning SafeChange создаёт отдельную ветку от baseline.

Работа продолжается в текущем checkout, чтобы сохранить уже настроенную локальную среду, `.env`, dependencies, IDE и локальные сервисы.

SafeChange не управляет worktrees в MVP. Пользователь или Codex App может запустить SafeChange внутри уже созданного worktree, но ядро продукта не должно создавать и настраивать его самостоятельно.

### 7.8. Test Author и safety harness

Test Author fork-ается от `C0` и получает:

- Change Contract;
- selected plan;
- evidence gaps;
- разрешённый test scope.

Он не получает transcript Implementer и не должен подгонять проверки под будущую реализацию.

Задача Test Author — создать минимально достаточную страховочную сетку для выбранного изменения.

В зависимости от типа задачи:

- bug fix: regression test должен воспроизводить проблему на baseline;
- feature: acceptance check должен демонстрировать отсутствие требуемого поведения;
- refactoring: characterization tests фиксируют текущее поведение и проходят на baseline;
- DevOps/configuration: используются validation, dry run, rendered diff, policy checks или health checks.

Если достаточную проверку невозможно создать в доступной среде, SafeChange должен вернуть `INSUFFICIENT_VERIFICATION_ENVIRONMENT`, а не генерировать бессмысленный mock ради формального успеха.

После проверки safety harness создаётся отдельный commit `T1`.

Тесты и assertions, определённые как protected, фиксируются для дальнейшей проверки.

### 7.9. Implementer

Implementer fork-ается от `C0`, а не от selected Planner.

Он получает только формальные входы:

- Change Contract;
- selected plan;
- Judge decision;
- test commit;
- allowed scope;
- текущее состояние Git.

Так Detailed Plan остаётся самодостаточным и не зависит от скрытого transcript Planner.

Implementer может добавлять новые тесты и fixtures, но не может:

- удалять protected tests;
- ослаблять protected assertions;
- добавлять `skip`/`only` для обхода проверки;
- изменять protected fixtures так, чтобы тест потерял смысл;
- молча расширять scope.

Если реализация требует выйти за утверждённую область, SafeChange возвращает `REPLAN_REQUIRED`.

После реализации создаётся отдельный commit `I1`.

### 7.10. Deterministic verification

Обычный TypeScript-код, а не модель, запускает и фиксирует:

- targeted tests;
- full test suite, когда она доступна и оправдана;
- typecheck;
- lint;
- build;
- project-owned validation commands;
- Git diff и changed paths;
- изменения package manifests и lockfiles;
- появление migrations;
- изменения protected files и instruction sources;
- состояние protected safety tests.

SafeChange должен сравнивать baseline, `T1` и `I1`, чтобы отделить safety harness от реализации.

LLM не может объявить проверку успешной без подтверждённых command results.

### 7.11. Independent Verifier

Verifier fork-ается от `C0`, а не от Implementer, Judge или Test Author.

Он получает:

- Change Contract;
- selected plan;
- Judge constraints;
- baseline commit;
- test commit;
- implementation commit;
- actual diff;
- deterministic command results;
- residual unknowns.

Он не получает transcript Implementer, его самооценку и объяснения, почему код должен быть правильным.

Verifier отвечает на три вопроса:

1. Выполнен ли исходный Change Contract?
2. Сохранены ли заявленные protected invariants в пределах доступных доказательств?
3. Соответствует ли фактический diff выбранному плану и разрешённому scope?

Если verifier находит локальный дефект в рамках утверждённого плана, допускается один ограниченный repair loop через `resume` того же Implementer. После исправления создаётся новый Verifier fork от `C0`, который проверяет изменение заново.

Если требуется изменение scope, выполняется replan, а не локальный repair.

---

## 8. Правила управления сессиями

SafeChange должен различать `new thread`, `fork` и `resume`.

### Новый thread

Использовать, когда предыдущий контекст потенциально загрязнён или может навязать ошибочную гипотезу:

- Scratch Discovery `D0`;
- Canonical Contract `C0`;
- возможный future cold audit.

### Fork от `C0`

Использовать, когда нужны общие факты и контракт, но требуется независимая роль:

- каждый Planner;
- Judge;
- Test Author;
- Implementer;
- Verifier.

### Resume

Использовать только когда тот же актор продолжает ту же гипотезу и scope:

- Planner уточняет собственный план;
- Test Author исправляет собственный некорректный harness;
- Implementer исправляет локальную ошибку в рамках выбранного плана.

### Запрещённые lineage

Не строить следующие цепочки:

```text
Planner → Implementer
Implementer → Verifier
Judge → Implementer
Test Author → Implementer
Planner A → Planner B
```

Между этими ролями передаются artifacts, а не transcripts.

### Prompt/KV caching

Общий `C0` checkpoint и одинаковый prefix planner forks должны благоприятствовать prompt caching. Однако cache hit не является гарантией и не должен влиять на корректность workflow.

Контекстный граф проектируется ради качества, независимости и управляемости. Cached token usage и latency следует измерять как оптимизацию.

---

## 9. Архитектура продукта

### 9.1. Основные компоненты

```text
SafeChange TypeScript CLI
│
├── Workflow Orchestrator
├── Codex Runtime Client
├── Context Graph Registry
├── Artifact Store
├── Git Controller
├── Deterministic Runner
└── Report Generator
```

### Workflow Orchestrator

Управляет утверждёнными фазами, переходами и статусами. Не использовать отдельный state-machine framework, пока обычная последовательность TypeScript-операций остаётся понятной.

### Codex Runtime Client

Тонкий клиент к `codex app-server` через локальный `stdio` JSON-RPC transport.

Нужные концептуальные операции:

- start thread;
- start turn;
- fork thread до завершённого checkpoint;
- resume role thread;
- interrupt turn;
- дождаться результата и событий;
- получить schema-constrained output.

Не строить универсальный App Server SDK и не поддерживать одновременно несколько Codex backends.

Codex version должна быть зафиксирована. Protocol types и JSON Schema следует генерировать из той же установленной версии App Server, а не поддерживать вручную.

### Context Graph Registry

Хранит связь:

```text
role
thread id
session id
parent thread/checkpoint
turn id
status
```

Он нужен для трассируемости, а не для хранения бизнес-артефактов.

### Artifact Store

Хранит schema-validated результаты фаз:

- evidence;
- contract;
- plans;
- decision;
- verification plan/harness metadata;
- deterministic results;
- verifier report.

Каждый артефакт должен быть связан с:

- run id;
- baseline commit;
- contract version;
- role;
- hashes входных artifacts;
- evidence references;
- assumptions и unknowns.

### Git Controller

Отвечает только за безопасные и объяснимые операции:

- проверка состояния;
- фиксация baseline;
- создание SafeChange branch;
- получение diff;
- проверка changed paths;
- создание двух основных commits;
- отказ от destructive cleanup.

### Deterministic Runner

Запускает утверждённые команды проекта, фиксирует exit code/stdout/stderr и не принимает интерактивные подтверждения.

Repository-controlled commands должны выполняться в ограниченном окружении без production credentials и без network access по умолчанию.

### Report Generator

Создаёт компактный человекочитаемый отчёт:

- исходная задача;
- рассмотренные планы;
- выбор и причины;
- созданные проверки;
- фактические изменения;
- результаты команд;
- остаточные риски;
- граница rollback;
- итоговый статус.

### 9.2. Codex App Server

Использовать App Server, потому что проекту необходимы:

- `thread/fork` до конкретного завершённого turn;
- сохранённые session trees;
- streaming lifecycle events;
- `outputSchema` на уровне turn;
- явные sandbox policies;
- version-specific generated protocol types.

Для MVP использовать стабильный `stdio` transport. Не использовать experimental WebSocket transport.

Каждая роль получает sandbox явно, а не полагается на неявное наследование:

```text
Discovery      read-only, network off
Contract       read-only, network off
Planners       read-only, network off
Judge          read-only, network off
Test Author    workspace write, network off
Implementer    workspace write, network off
Verifier       read-only, network off
```

Не использовать API, выполняющие команды вне sandbox, если они не нужны для явно инициированного пользовательского действия.

### 9.3. CLI и Skill

Ядро продукта — самостоятельный CLI.

Codex Skill добавляется после того, как CLI стабильно выполняет основной workflow. Skill должен быть тонкой точкой входа:

- принять намерение пользователя;
- запустить CLI;
- показать итоговый отчёт;
- помочь разобрать `BLOCKED`, `REPLAN_REQUIRED` или `HUMAN_DECISION_REQUIRED`.

Не помещать основную orchestration-логику в `SKILL.md`.

---

## 10. Git и рабочая среда

### 10.1. Текущий checkout и отдельная ветка

MVP работает в текущем checkout и создаёт отдельную SafeChange branch перед первым write.

Это сохраняет существующую локальную среду:

- `.env` и `.env.local`;
- installed dependencies;
- IDE configuration;
- Docker Compose и локальные services;
- уже настроенные credentials для тестовых сред.

### 10.2. История изменения

Минимальная целевая история:

```text
B0  baseline commit
 │
 T1  safety harness commit
 │
 I1  implementation commit
```

`T1` должен позволять отдельно увидеть, какие проверки были добавлены до реализации.

### 10.3. Fingerprint и invalidation

До и после read-only фаз SafeChange должен обнаруживать изменение baseline:

- HEAD;
- tracked Git state;
- relevant manifests;
- instruction sources;
- protected configuration fingerprints без раскрытия содержимого.

Любое несовпадение инвалидирует результаты планирования.

### 10.4. Ограничение rollback

Гарантия MVP:

> Пользователь может отказаться от SafeChange branch и вернуться к baseline tracked source code.

Не гарантируется автоматический возврат:

- локальной или удалённой БД;
- Docker volumes;
- очередей;
- generated ignored files;
- внешних API side effects;
- production infrastructure.

Поэтому MVP запрещает production writes и destructive migrations.

---

## 11. Структурированные артефакты

Thread history полезна модели, но не должна быть единственным хранилищем состояния.

Минимальный persistent run state:

```text
.safechange/runs/<run-id>/
├── state.json
├── evidence.json
├── contract.json
├── plans/
├── decision.json
├── verification.json
└── report.md
```

Точная внутренняя структура остаётся на усмотрение реализации, но система должна уметь:

- определить последнюю успешно завершённую фазу;
- связать artifacts с baseline и contract version;
- не повторять завершённую дорогую фазу без необходимости;
- объяснить происхождение решения;
- восстановить человекочитаемый отчёт после прерывания процесса.

Не использовать внешнюю БД для MVP.

---

## 12. Финальные статусы

Система должна различать как минимум:

### `VERIFIED`

Контракт выполнен в пределах заявленных доказательств; фактический diff допустим; детерминированные проверки прошли.

### `BLOCKED`

Среда, требования или доказательства недостаточны для безопасного продолжения.

### `BASELINE_CHANGED`

Репозиторий или критичные instructions/configuration изменились после анализа.

### `REPLAN_REQUIRED`

Реализация требует выйти за выбранный scope или исходный план оказался неприменим.

### `HUMAN_DECISION_REQUIRED`

Требуется осознанное разрешение, например для:

- новой production dependency;
- public API change;
- schema/data migration;
- новых permissions или secrets;
- необратимого действия;
- изменения protected invariant.

### `FAILED`

Команды или проверки завершились ошибкой, которая не была безопасно исправлена в разрешённом repair loop.

Каждый статус должен содержать конкретную причину и рекомендуемое следующее действие.

---

## 13. Golden demo scenario

Для хакатона нужен один контролируемый TypeScript demo repository. Он служит проверкой продукта, но не должен быть зашит в общую архитектуру.

Рекомендуемый сценарий:

> Добавить автоматический retry платежной операции при временном timeout, сохранив публичный API и исключив двойное списание.

Ожидаемые competing approaches:

1. наивный retry вокруг текущего вызова — минимальный, но потенциально опасный;
2. retry с idempotency mechanism в существующем adapter — умеренный и обратимый;
3. очередь/outbox или более крупная архитектурная перестройка — надёжная, но чрезмерная для задачи.

SafeChange должен:

- получить существенно разные планы;
- отклонить или понизить небезопасный minimal plan;
- отклонить чрезмерный YAGNI-вариант;
- выбрать минимально достаточный idempotency-aware plan;
- добавить tests для timeout/retry/duplicate effect до реализации;
- реализовать выбранное изменение;
- показать два отдельных commits;
- доказать выполнение через реальные command results;
- выдать короткий отчёт, понятный в трёхминутном видео.

Дополнительный негативный demo может намеренно заставить Implementer изменить protected test или добавить новую dependency, чтобы показать автоматический gate.

---

## 14. Acceptance criteria MVP

MVP считается готовым, когда на golden path он демонстрирует следующее:

1. CLI принимает задачу и количество планов.
2. Scratch Discovery и Canonical Contract разделены.
3. `N` planners fork-аются от одного `C0` checkpoint.
4. При `N = 3` получаются материально разные подходы.
5. Plan artifacts имеют одинаковую валидируемую форму.
6. Недопустимые планы исключаются до LLM Judge.
7. Judge выдаёт объяснимый выбор без псевдоточного score.
8. Baseline повторно проверяется перед первым write.
9. Создаётся отдельная Git branch.
10. Test Author создаёт meaningful safety harness до implementation.
11. Safety harness фиксируется отдельным commit.
12. Implementer не наследует planner transcript.
13. Protected tests нельзя незаметно ослабить.
14. Implementation фиксируется отдельным commit.
15. Тесты, typecheck/build и Git diff проверяются детерминированно.
16. Verifier не наследует Implementer transcript.
17. Неожиданный scope expansion приводит к остановке.
18. Пользователь получает runnable branch и понятный report.
19. Проект можно установить и протестировать судьям без пересборки с нуля.
20. Полный основной сценарий можно убедительно показать менее чем за три минуты.

---

## 15. Подход к разработке

Разработка должна идти вертикальными работающими срезами, а не по компонентам «на будущее».

### Сначала доказать главное

Первый работающий срез должен проверить только центральную гипотезу:

```text
canonical context
→ independent planners
→ plan comparison
```

Он может работать read-only и не изменять репозиторий.

### Затем замкнуть один end-to-end path

Добавить:

```text
selected plan
→ safety harness
→ implementation
→ deterministic verification
→ independent verifier
```

Только для одного подготовленного TypeScript demo repository.

### После этого повышать надёжность

Улучшать:

- structured errors;
- interrupted-run recovery;
- artifact validation;
- baseline invalidation;
- protected test checks;
- CLI experience;
- installation and demo packaging.

### И только затем расширять поверхность

Codex Skill, второй DevOps dry-run example и более гибкие lenses добавляются после работающего golden path.

На каждом этапе должна сохраняться запускаемая версия проекта. Не строить одновременно все будущие возможности.

---

## 16. Критические архитектурные инварианты

Coding-агент не должен менять следующие решения без явного согласования:

1. Основной язык — TypeScript.
2. Основной продукт — CLI.
3. AI runtime — Codex App Server через `stdio`.
4. Scratch Discovery и Canonical Contract — разные root threads.
5. Все decision roles fork-аются от `C0`.
6. Implementer не fork-ается от Planner.
7. Verifier не fork-ается от Implementer.
8. Между ролями передаются schema-validated artifacts.
9. Git/artifacts/command results являются источником истины.
10. Параллельны только read-only planners; writers последовательны.
11. До реализации создаётся protected safety harness.
12. MVP создаёт одну implementation branch и реализует один plan.
13. SafeChange не выполняет production deployment или destructive external actions.
14. Worktree management не входит в MVP.
15. Основной workflow не должен зависеть от скрытого transcript или cache hit.

Если обнаружена причина изменить инвариант, coding-агент должен сначала описать проблему, минимальную альтернативу и последствия, не внося архитектурную перестройку молча.

---

## 17. Definition of done для проекта

Проект готов к submission, когда:

- основной golden demo стабильно работает повторяемо;
- CLI имеет понятную установку и help;
- README позволяет запустить demo без знания внутренней архитектуры;
- есть sample task и ожидаемый результат;
- failures объяснимы и не оставляют неясное состояние;
- нет production credentials и необратимых операций;
- repository history показывает реальное использование Codex;
- сохранён `/feedback` Codex Session ID основной разработки;
- подготовлено видео менее трёх минут;
- документация явно показывает, где используются Codex, GPT-5.6, thread forking и independent verification;
- продукт выглядит как законченный developer tool, а не набор несвязанных scripts.

---

## 18. Официальные источники

- OpenAI Build Week overview and requirements: https://openai.devpost.com/
- Codex App Server: https://developers.openai.com/codex/app-server
- Codex subagents and context management: https://developers.openai.com/codex/subagents
- Codex skills: https://developers.openai.com/codex/build-skills
- Codex best practices: https://developers.openai.com/codex/learn/best-practices
