import { HttpTestingController } from '@angular/common/http/testing';
import { PaymentBoxesResponse } from '../cashbox.models';

/** A shop with only the main box: the selector stays hidden, nothing changes for the cashier. */
export const MAIN_ONLY_BOXES: PaymentBoxesResponse = {
  defaultBoxId: 'box-main',
  mainBox: { _id: 'box-main', name: 'الخزنة الرئيسية' },
  deviceId: null,
  data: [{ _id: 'box-main', name: 'الخزنة الرئيسية', type: 'cash', isMain: true, shiftsEnabled: false, isDefault: true, openShift: null, needsShift: false }],
};

/**
 * Stage 19: every screen that takes or pays out money shows the payment-box selector, which asks for the list of
 * boxes once a user is signed in. Specs that call http.verify() answer it first (the main box only).
 */
export function flushPaymentBoxes(http: HttpTestingController, response: PaymentBoxesResponse = MAIN_ONLY_BOXES): void {
  http.match((request) => request.url.endsWith('cashbox/payment-boxes')).forEach((request) => request.flush(response));
}
