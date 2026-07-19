import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const oracleRoot = dirname(fileURLToPath(import.meta.url));
const baselineRoot = resolve(oracleRoot, "../../scenarios/double-charge/baseline");
const workspace = process.argv[2] ? resolve(process.argv[2]) : undefined;

async function evaluate(root) {
  const checks = [];
  const visible = run("npm", ["test"], root, 120_000);
  checks.push({
    id: "visible-checks",
    category: "visible",
    passed: visible.status === 0,
    detail: visible.status === 0 ? "npm test passed" : commandFailure(visible),
  });

  if (visible.status === 0) {
    const moduleUrl = pathToFileURL(join(root, "dist/src/payment-service.js")).href;
    const paymentModule = await import(`${moduleUrl}?evaluation=${Date.now()}`);
    await runBehaviorChecks(checks, paymentModule);
  } else {
    for (const [id, category] of behaviorCheckDefinitions) {
      checks.push({ id, category, passed: false, detail: "not evaluated after visible failure" });
    }
  }

  await runScopeChecks(checks, root);

  const categoryPassed = (category) =>
    checks.filter((check) => check.category === category).every((check) => check.passed);
  const summary = {
    visible: categoryPassed("visible"),
    acceptance: categoryPassed("acceptance"),
    preservation: categoryPassed("preservation"),
    scope: categoryPassed("scope"),
  };

  return {
    schemaVersion: 1,
    scenario: "double-charge",
    checks,
    summary,
    passed: Object.values(summary).every(Boolean),
  };
}

const behaviorCheckDefinitions = [
  ["sequential-retry", "acceptance"],
  ["concurrent-retry", "acceptance"],
  ["retry-after-restart", "acceptance"],
  ["recovery-after-failed-save", "acceptance"],
  ["amount-currency-conflict", "acceptance"],
  ["normal-payment", "preservation"],
  ["refund", "preservation"],
];

async function runBehaviorChecks(checks, paymentModule) {
  const { PaymentConflictError, PaymentService } = paymentModule;

  await check(checks, "sequential-retry", "acceptance", async () => {
    const gateway = new PersistentGateway();
    const store = new PersistentStore();
    const service = new PaymentService(gateway, store);
    const input = payment("sequential");
    const first = await service.retryPayment(input);
    const second = await service.retryPayment(input);
    assert(first.paymentId === second.paymentId, "retry returned a different payment");
    assert(gateway.chargeEffects === 1, `expected 1 charge effect, got ${gateway.chargeEffects}`);
  });

  await check(checks, "concurrent-retry", "acceptance", async () => {
    const gateway = new PersistentGateway();
    const store = new PersistentStore();
    const service = new PaymentService(gateway, store);
    const [first, second] = await Promise.all([
      service.retryPayment(payment("concurrent")),
      service.retryPayment(payment("concurrent")),
    ]);
    assert(first.paymentId === second.paymentId, "concurrent retries returned different payments");
    assert(gateway.chargeEffects === 1, `expected 1 charge effect, got ${gateway.chargeEffects}`);
  });

  await check(checks, "retry-after-restart", "acceptance", async () => {
    const gateway = new PersistentGateway();
    const store = new PersistentStore();
    const first = await new PaymentService(gateway, store).retryPayment(payment("restart"));
    const second = await new PaymentService(gateway, store).retryPayment(payment("restart"));
    assert(first.paymentId === second.paymentId, "restart retry returned a different payment");
    assert(gateway.chargeEffects === 1, `expected 1 charge effect, got ${gateway.chargeEffects}`);
  });

  await check(checks, "recovery-after-failed-save", "acceptance", async () => {
    const gateway = new PersistentGateway();
    const store = new PersistentStore(1);
    await assertRejects(
      () => new PaymentService(gateway, store).retryPayment(payment("failed-save")),
      "first save should fail",
    );
    const recovered = await new PaymentService(gateway, store).retryPayment(payment("failed-save"));
    assert(recovered.paymentId === "payment-1", "recovery returned a different payment");
    assert(gateway.chargeEffects === 1, `expected 1 charge effect, got ${gateway.chargeEffects}`);
  });

  await check(checks, "amount-currency-conflict", "acceptance", async () => {
    const gateway = new PersistentGateway();
    const service = new PaymentService(gateway, new PersistentStore());
    await service.retryPayment(payment("conflict"));
    const error = await captureRejection(() =>
      service.retryPayment({ operationToken: "conflict", amount: 1100, currency: "EUR" }),
    );
    assert(error, "conflicting retry was accepted");
    assert(
      error instanceof PaymentConflictError || error.name === "PaymentConflictError",
      `expected PaymentConflictError, got ${error.name || typeof error}`,
    );
    assert(gateway.chargeEffects === 1, `expected 1 charge effect, got ${gateway.chargeEffects}`);
  });

  await check(checks, "normal-payment", "preservation", async () => {
    const gateway = new PersistentGateway();
    const service = new PaymentService(gateway, new PersistentStore());
    const first = await service.pay({ amount: 800, currency: "USD" });
    const second = await service.pay({ amount: 800, currency: "USD" });
    assert(first.paymentId !== second.paymentId, "normal payments were incorrectly deduplicated");
    assert(gateway.chargeEffects === 2, `expected 2 charge effects, got ${gateway.chargeEffects}`);
  });

  await check(checks, "refund", "preservation", async () => {
    const gateway = new PersistentGateway();
    const service = new PaymentService(gateway, new PersistentStore());
    const refund = await service.refund({ paymentId: "payment-7", amount: 300 });
    assert(refund.paymentId === "payment-7", "refund changed the payment id");
    assert(refund.amount === 300, "refund changed the amount");
    assert(gateway.refundEffects === 1, `expected 1 refund effect, got ${gateway.refundEffects}`);
  });
}

async function runScopeChecks(checks, root) {
  await check(checks, "public-api", "scope", async () => {
    const expected = await readFile(join(oracleRoot, "expected-api.d.ts"), "utf8");
    const actual = await readFile(join(root, "dist/src/payment-service.d.ts"), "utf8");
    assert(normalizePublicApi(actual) === normalizePublicApi(expected), "public API changed");
  });

  await check(checks, "production-dependencies", "scope", async () => {
    const baseline = JSON.parse(await readFile(join(baselineRoot, "package.json"), "utf8"));
    const candidate = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    assert(
      stableJson(candidate.dependencies ?? {}) === stableJson(baseline.dependencies ?? {}),
      "production dependencies changed",
    );
  });

  await check(checks, "forbidden-files", "scope", async () => {
    const status = run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], root);
    assert(status.status === 0, commandFailure(status));
    const files = status.stdout
      .split("\0")
      .filter(Boolean)
      .map((entry) => entry.slice(3));
    const forbidden = files.filter((file) => !/^(src|test)\//u.test(file));
    assert(forbidden.length === 0, `forbidden changed files: ${forbidden.join(", ")}`);
  });
}

class PersistentGateway {
  chargeEffects = 0;
  refundEffects = 0;
  #payments = new Map();

  async charge(input) {
    if (!input.idempotencyKey) return await this.#createPayment(input);

    const previous = this.#payments.get(input.idempotencyKey);
    if (previous) {
      if (previous.amount !== input.amount || previous.currency !== input.currency) {
        const error = new Error("idempotency key conflict");
        error.name = "PaymentConflictError";
        throw error;
      }
      return await previous.receipt;
    }

    const receipt = this.#createPayment(input);
    this.#payments.set(input.idempotencyKey, { ...input, receipt });
    return await receipt;
  }

  async refund(input) {
    this.refundEffects += 1;
    return { refundId: `refund-${this.refundEffects}`, ...input };
  }

  async #createPayment(input) {
    await new Promise((resolveDelay) => setImmediate(resolveDelay));
    this.chargeEffects += 1;
    return {
      paymentId: `payment-${this.chargeEffects}`,
      amount: input.amount,
      currency: input.currency,
    };
  }
}

class PersistentStore {
  #operations = new Map();

  constructor(failedSaves = 0) {
    this.failedSaves = failedSaves;
  }

  async get(operationToken) {
    return this.#operations.get(operationToken);
  }

  async save(operation) {
    if (this.failedSaves > 0) {
      this.failedSaves -= 1;
      throw new Error("simulated persistent-store failure");
    }
    this.#operations.set(operation.operationToken, operation);
  }
}

function payment(operationToken) {
  return { operationToken, amount: 1000, currency: "USD" };
}

async function check(checks, id, category, operation) {
  try {
    await operation();
    checks.push({ id, category, passed: true, detail: "passed" });
  } catch (error) {
    checks.push({
      id,
      category,
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertRejects(operation, message) {
  assert(await captureRejection(operation), message);
}

async function captureRejection(operation) {
  try {
    await operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

function normalizePublicApi(value) {
  return value
    .split("\n")
    .filter((line) => !/^\s*(?:private\b|#private;)/u.test(line))
    .join("\n")
    .trim()
    .replace(/\s+/gu, " ");
}

function stableJson(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

function run(command, args, cwd, timeout = 30_000) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout,
    env: {
      ...process.env,
      CHANGE_SAFELY_SENTRY_DSN: "",
      NO_UPDATE_NOTIFIER: "1",
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function commandFailure(result) {
  const detail = result.error || result.stderr || result.stdout || `exit status ${result.status}`;
  return detail.trim().slice(0, 1000);
}

if (!workspace) {
  process.stderr.write("Usage: node evaluate.mjs <workspace>\n");
  process.exit(2);
}

try {
  const result = await evaluate(workspace);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, scenario: "double-charge", technicalError: message })}\n`,
  );
  process.exitCode = 1;
}
