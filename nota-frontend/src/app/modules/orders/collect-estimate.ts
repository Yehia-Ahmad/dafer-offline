import { OrderDetail } from './orders.models';

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * "Delivered with returns": the amount the courier should collect when the customer sends some lines back.
 * It follows the server's credit-sale return (nota-backend creditSale.controller.js): the refused lines' value, plus, with
 * prices EXCLUDING VAT, their VAT share (cumulative proportion by taxable value); a partial return keeps the delivery fee.
 * An estimate for the screen only: the server works out the real invoice balance and collects exactly that unless the user
 * types another amount.
 * @param order    the dispatched order (lines with their snapshot prices and VAT)
 * @param returned productId -> quantity sent back
 * @param invoiceRemaining the invoice's remaining amount when known (defaults to the order total)
 */
export function estimateCollect(order: Pick<OrderDetail, 'items' | 'total' | 'vatIncluded' | 'vatRate'>, returned: Record<string, number>, invoiceRemaining?: number): number {
  const remaining = invoiceRemaining ?? order.total;
  let returnedValue = 0;
  let returnedTaxable = 0;
  let taxable = 0;
  let linesVat = 0;
  for (const line of order.items) {
    const qty = Math.min(Math.max(0, Math.floor(returned[line.productId] || 0)), line.qty);
    const value = round2(line.unitPrice * qty);
    returnedValue = round2(returnedValue + value);
    linesVat = round2(linesVat + (line.vat || 0));
    if (!line.vatExempt) {
      taxable = round2(taxable + line.unitPrice * line.qty);
      returnedTaxable = round2(returnedTaxable + value);
    }
  }
  const vatShare = order.vatRate !== undefined && order.vatIncluded === false && taxable > 0 ? round2((linesVat * returnedTaxable) / taxable) : 0;
  return Math.max(0, round2(remaining - returnedValue - vatShare));
}

/** True when every unit of every line is sent back: that is a refusal (the refuse button), not "delivered with returns". */
export function returnsEverything(order: Pick<OrderDetail, 'items'>, returned: Record<string, number>): boolean {
  return order.items.every((line) => Math.min(Math.max(0, Math.floor(returned[line.productId] || 0)), line.qty) === line.qty);
}
