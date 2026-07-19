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
export declare class PaymentConflictError extends Error {
  constructor(operationToken: string);
}
export declare class PaymentService {
  private readonly gateway;
  private readonly store;
  constructor(gateway: PaymentGateway, store: OperationStore);
  pay(input: PaymentRequest): Promise<PaymentReceipt>;
  retryPayment(input: RetryPaymentRequest): Promise<PaymentReceipt>;
  refund(input: RefundRequest): Promise<RefundReceipt>;
}
