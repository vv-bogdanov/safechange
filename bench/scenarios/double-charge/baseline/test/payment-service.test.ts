import assert from "node:assert/strict";
import test from "node:test";

import type {
  GatewayChargeRequest,
  OperationStore,
  PaymentGateway,
  PaymentReceipt,
  RefundReceipt,
  RefundRequest,
  StoredOperation,
} from "../src/payment-service.js";
import { PaymentService } from "../src/payment-service.js";

class MemoryStore implements OperationStore {
  readonly operations = new Map<string, StoredOperation>();

  async get(operationToken: string): Promise<StoredOperation | undefined> {
    return this.operations.get(operationToken);
  }

  async save(operation: StoredOperation): Promise<void> {
    this.operations.set(operation.operationToken, operation);
  }
}

class RecordingGateway implements PaymentGateway {
  readonly charges: GatewayChargeRequest[] = [];
  readonly refunds: RefundRequest[] = [];

  async charge(input: GatewayChargeRequest): Promise<PaymentReceipt> {
    this.charges.push(input);
    return { paymentId: `payment-${this.charges.length}`, ...input };
  }

  async refund(input: RefundRequest): Promise<RefundReceipt> {
    this.refunds.push(input);
    return { refundId: `refund-${this.refunds.length}`, ...input };
  }
}

test("creates a normal payment", async () => {
  const gateway = new RecordingGateway();
  const service = new PaymentService(gateway, new MemoryStore());

  const receipt = await service.pay({ amount: 1200, currency: "USD" });

  assert.deepEqual(receipt, { paymentId: "payment-1", amount: 1200, currency: "USD" });
  assert.equal(gateway.charges.length, 1);
});

test("records one retry operation", async () => {
  const gateway = new RecordingGateway();
  const store = new MemoryStore();
  const service = new PaymentService(gateway, store);

  const receipt = await service.retryPayment({
    operationToken: "checkout-42",
    amount: 2500,
    currency: "EUR",
  });

  assert.equal(receipt.paymentId, "payment-1");
  assert.equal((await store.get("checkout-42"))?.receipt.paymentId, receipt.paymentId);
});

test("preserves refunds", async () => {
  const gateway = new RecordingGateway();
  const service = new PaymentService(gateway, new MemoryStore());

  const refund = await service.refund({ paymentId: "payment-9", amount: 500 });

  assert.deepEqual(refund, { refundId: "refund-1", paymentId: "payment-9", amount: 500 });
});
