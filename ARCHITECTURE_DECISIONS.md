# SafeChange — зафиксированные архитектурные решения

**Статус:** действующие архитектурные инварианты MVP.

Этот документ сохраняет уже принятые решения и причины их выбора. Он нужен, чтобы coding-агент не повторял исходное исследование и не менял направление без новой фактической причины.

## AD-01. Продукт: orchestration и verification, а не новый coding agent

**Решение:** SafeChange управляет процессом вокруг Codex: contract, competing plans, safety harness, implementation и independent verification.

**Почему:** ценность проекта находится в безопасной организации изменения, а не в повторении возможностей Codex по написанию кода.

## AD-02. Основной интерфейс — CLI

**Решение:** строить standalone TypeScript CLI; Codex Skill добавить как тонкую точку входа после стабилизации CLI.

**Почему:** CLI естественен для developer/DevOps workflow, быстро строится, легко демонстрируется и не требует UI debugging.

## AD-03. TypeScript / Node.js

**Решение:** ядро проекта писать на TypeScript.

**Почему:** целевой пользовательский стек, удобное тестирование и packaging, хорошее соответствие локальному developer tooling.

## AD-04. Codex App Server вместо SDK и прямого `codex exec`

**Решение:** использовать `codex app-server` через `stdio` JSON-RPC.

**Почему:** SafeChange требует точного `thread/fork` до checkpoint, session trees, per-turn output schemas и явных sandbox policies. Прямой CLI требует слишком много process/protocol glue, а публичная поверхность SDK не является основой для требуемого fork graph.

**Ограничение:** реализовать тонкий runtime client, а не универсальный SDK.

## AD-05. Зафиксированная версия протокола

**Решение:** pin Codex version и генерировать TypeScript/JSON Schema protocol artifacts из этой версии.

**Почему:** App Server развивается; version-specific generated types уменьшают расхождения и скрытые поломки.

## AD-06. `stdio`, не WebSocket

**Решение:** использовать локальный `stdio` transport.

**Почему:** это стабильный, минимальный и безопасный вариант для локального CLI. WebSocket transport не нужен MVP.

## AD-07. Два root contexts

**Решение:** Scratch Discovery `D0` и Canonical Contract `C0` — разные новые threads.

**Почему:** Discovery содержит шум, промежуточные гипотезы и потенциальные ошибки. Если fork-ать все роли от него, одна ошибка становится общей для всего дерева.

## AD-08. `C0` — единственный канонический fork point

**Решение:** Planners, Judge, Test Author, Implementer и Verifier fork-аются от завершённого checkpoint `C0`.

**Почему:** роли получают одинаковое понимание задачи, но сохраняют независимую последующую историю.

## AD-09. Implementer не наследует Planner transcript

**Решение:** Implementer fork-ается от `C0` и получает selected plan как validated artifact.

**Почему:** подробный план должен быть самодостаточным. Наследование transcript усиливает confirmation bias и скрывает неявные assumptions.

## AD-10. Verifier не наследует Implementer transcript

**Решение:** Verifier fork-ается от `C0` и получает contract, plan, actual diff и deterministic results.

**Почему:** проверять нужно исходную задачу, а не продолжать объяснение автора реализации.

## AD-11. `N` независимых plans, одна реализация

**Решение:** `N` настраивается, default 3, разумный MVP limit 5. Каждый Planner формирует approach и detailed plan под своей lens. Реализуется только победивший plan.

**Почему:** это даёт разнообразие решений без тройной стоимости и конфликтов нескольких implementations.

## AD-12. Нет отдельного Approach Generator в стандартном workflow

**Решение:** high-level approach и detailed plan создаются внутри каждого независимого Planner.

**Почему:** единый idea generator становится bottleneck разнообразия и добавляет лишний узел. Широкий ideation mode можно добавить позже.

## AD-13. Формальные gates до LLM Judge

**Решение:** сначала исключать планы по обязательным критериям, затем сравнивать допустимые планы через Judge.

**Почему:** Judge не должен единолично решать вопросы, которые проверяются формально. Не использовать псевдоточные numerical scores.

## AD-14. Safety harness до реализации

**Решение:** отдельный Test Author создаёт protected tests/validation до production-code change; затем создаётся отдельный commit.

**Почему:** тесты должны проверять контракт, а не быть подогнаны под уже написанное решение.

## AD-15. Один write actor

**Решение:** planners могут работать параллельно; Test Author и Implementer работают последовательно.

**Почему:** параллельная запись в один checkout создаёт конфликты, нестабильное состояние и сложную координацию.

## AD-16. Deterministic runner вне LLM

**Решение:** test/typecheck/lint/build/Git checks выполняет обычный код.

**Почему:** утверждение модели не заменяет реальные exit codes и diff.

## AD-17. Текущий checkout + отдельная branch

**Решение:** SafeChange работает в текущем checkout и создаёт branch перед первым write; worktrees не управляются ядром MVP.

**Почему:** сохраняется настроенная среда, `.env`, dependencies и локальные services. Worktree setup добавляет лишние проблемы с ignored files, ports, volumes и dependencies.

## AD-18. Чистый tracked baseline

**Решение:** dirty tracked/staged state блокирует запуск; SafeChange не делает автоматический stash/reset/clean.

**Почему:** инструмент безопасности не должен самовольно управлять пользовательскими незакоммиченными изменениями.

## AD-19. Два основных commits

**Решение:** `T1` содержит safety harness, `I1` — implementation.

**Почему:** это делает test-first sequence наблюдаемой и позволяет отдельно проверять тесты и код.

## AD-20. Ограниченная гарантия rollback

**Решение:** MVP гарантирует возврат tracked source code к baseline, но не внешнего состояния.

**Почему:** branch не откатывает БД, volumes, очереди и внешние APIs. Поэтому production writes исключены.

## AD-21. Persisted run state без БД

**Решение:** сохранять state и artifacts в `.safechange/runs/<run-id>/`.

**Почему:** workflow длинный и может прерываться; обычных JSON/Markdown достаточно для MVP.

## AD-22. Cache — оптимизация, не зависимость

**Решение:** одинаковый `C0` prefix и fork graph должны помогать prompt caching, но workflow обязан быть корректным без cache hit.

**Почему:** cache routing не является логической гарантией.

## AD-23. Skill после CLI

**Решение:** сначала закончить CLI, затем добавить repo/user skill, а plugin рассматривать только как способ распространения.

**Почему:** workflow и детерминированная логика принадлежат приложению; skill не должен заменять runtime.

## AD-24. Golden path прежде универсальности

**Решение:** сначала один контролируемый TypeScript payment/retry demo, затем robustness и только после этого расширение.

**Почему:** цель хакатона — законченный runnable product; широкая незавершённая поддержка хуже одного убедительного сценария.
