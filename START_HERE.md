# Начало работы coding-агента

> **Статус:** историческая точка входа, по которой был реализован MVP. Актуальная
> документация для пользователей находится в [`README.md`](./README.md), а для
> участников разработки в [`CONTRIBUTING.md`](./CONTRIBUTING.md).

Ты реализуешь **SafeChange** — TypeScript CLI для контролируемого внесения изменений с помощью Codex.

Прочитай документы в порядке:

1. [`SAFECHANGE_SPEC.md`](./SAFECHANGE_SPEC.md) — проблема, продукт, workflow и критерии готовности.
2. [`ARCHITECTURE_DECISIONS.md`](./ARCHITECTURE_DECISIONS.md) — уже принятые решения и причины.
3. [`AGENTS.md`](./AGENTS.md) — ежедневные инженерные ограничения.

## Главная задача

Построить работающий вертикальный сценарий:

```text
scratch discovery
→ clean canonical contract
→ independent plans
→ explainable selection
→ safety tests first
→ one implementation
→ deterministic checks
→ independent verification
```

## Режим работы

- Не пытайся сразу реализовать весь документ.
- Сначала создай самый маленький read-only PoC, доказывающий fork-based plan tournament.
- Затем замкни один end-to-end golden path на подготовленном TypeScript demo repository.
- После каждого шага оставляй запускаемую версию.
- Перед существенной архитектурной заменой покажи причину и минимальную альтернативу.
- Не добавляй будущие возможности до готовности golden path.

## Первый ожидаемый результат

Работающая CLI-команда, которая для одной задачи:

1. создаёт Scratch Discovery;
2. выпускает чистый Change Contract;
3. fork-ает три независимых Planner от одного checkpoint;
4. получает три валидируемых plan artifacts;
5. исключает явно недопустимые планы;
6. объяснимо выбирает один план;
7. сохраняет artifacts и выводит краткий terminal report;
8. не изменяет repository files.

Точные package structure, type organization и внутренние APIs выбери самостоятельно, сохраняя KISS и архитектурные инварианты.
