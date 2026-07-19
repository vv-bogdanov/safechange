export type Currency = "EUR" | "USD";

export interface PaymentRequest {
  amount: number;
  currency: Currency;
}

export interface RetryPaymentRequest extends PaymentRequest {
  operationToken: string;
}

export interface RefundRequest {
  paymentId: string;
  amount: number;
}

export interface PaymentReceipt extends PaymentRequest {
  paymentId: string;
}

export interface RefundReceipt {
  refundId: string;
  paymentId: string;
  amount: number;
}

export interface GatewayChargeRequest extends PaymentRequest {
  idempotencyKey?: string;
}

export interface PaymentGateway {
  charge(input: GatewayChargeRequest): Promise<PaymentReceipt>;
  refund(input: RefundRequest): Promise<RefundReceipt>;
}

export interface StoredOperation extends RetryPaymentRequest {
  receipt: PaymentReceipt;
}

export interface OperationStore {
  get(operationToken: string): Promise<StoredOperation | undefined>;
  save(operation: StoredOperation): Promise<void>;
}

export class PaymentConflictError extends Error {
  constructor(operationToken: string) {
    super(`Operation ${operationToken} was already used with different payment details`);
    this.name = "PaymentConflictError";
  }
}

export class PaymentService {
  constructor(
    private readonly gateway: PaymentGateway,
    private readonly store: OperationStore,
  ) {}

  async pay(input: PaymentRequest): Promise<PaymentReceipt> {
    assertAmount(input.amount);
    return await this.gateway.charge(input);
  }

  async retryPayment(input: RetryPaymentRequest): Promise<PaymentReceipt> {
    assertAmount(input.amount);
    assertOperationToken(input.operationToken);

    const receipt = await this.gateway.charge({
      amount: input.amount,
      currency: input.currency,
    });
    await this.store.save({ ...input, receipt });
    return receipt;
  }

  async refund(input: RefundRequest): Promise<RefundReceipt> {
    assertAmount(input.amount);
    if (!input.paymentId.trim()) throw new Error("paymentId must not be empty");
    return await this.gateway.refund(input);
  }
}

function assertAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("amount must be a positive integer in minor currency units");
  }
}

function assertOperationToken(operationToken: string): void {
  if (!operationToken.trim()) throw new Error("operationToken must not be empty");
}
