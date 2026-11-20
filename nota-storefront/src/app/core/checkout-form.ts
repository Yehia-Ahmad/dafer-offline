import { isEgyptianMobile } from './format';
import { AR } from './i18n/ar';
import { Fulfillment, OrderRequest, PaymentMethod } from './models';

export interface CheckoutForm {
  name: string;
  phone: string;
  fulfillment: Fulfillment;
  zoneId: string;
  address: string;
  landmark: string;
  notes: string;
  /** '' = type the address, otherwise the id of a saved address (signed-in customers only). */
  addressId: string;
  paymentMethod: PaymentMethod;
  /** Online Stage 7A: the "عرفتنا منين؟" answer ('' = not answered). */
  heardFrom?: string;
}

export type FormErrors = Partial<Record<'name' | 'phone' | 'zone' | 'address' | 'items', string>>;

/** Client-side checks that mirror the server's (the server still decides). A saved address brings name, phone and address with it. */
export const validateCheckout = (form: CheckoutForm, { signedIn, itemCount }: { signedIn: boolean; itemCount: number }): FormErrors => {
  const errors: FormErrors = {};
  if (itemCount < 1) errors.items = AR.checkout.emptyCart;
  const saved = signedIn && !!form.addressId;
  if (!saved) {
    if (!form.name.trim()) errors.name = AR.checkout.required;
    if (!form.phone.trim()) errors.phone = AR.checkout.required;
    else if (!isEgyptianMobile(form.phone)) errors.phone = AR.checkout.invalidPhone;
  }
  if (form.fulfillment === 'delivery') {
    if (!form.zoneId) errors.zone = AR.checkout.required;
    if (!saved && !form.address.trim()) errors.address = AR.checkout.required;
  }
  return errors;
};

/** The street and the landmark go to the server as one address (it has no landmark field). */
export const joinAddress = (address: string, landmark: string): string =>
  [address.trim(), landmark.trim() ? `${AR.checkout.landmark}: ${landmark.trim()}` : ''].filter(Boolean).join(' - ').slice(0, 500);

/** The quote request: ids and quantities, how, where and how it is paid; no contact is needed to price it. */
export const quoteRequest = (form: CheckoutForm, items: OrderRequest['items'], signedIn: boolean): OrderRequest => ({
  items,
  fulfillment: form.fulfillment,
  paymentMethod: form.paymentMethod,
  ...(form.fulfillment === 'delivery' ? { zoneId: form.zoneId } : {}),
  ...(signedIn && form.addressId ? { addressId: form.addressId } : {}),
});

/** The order request: the quote plus the contact (or the saved address). The idempotency key is added by CheckoutService. */
export const orderRequest = (form: CheckoutForm, items: OrderRequest['items'], signedIn: boolean): OrderRequest => {
  const base = { ...quoteRequest(form, items, signedIn), ...(form.heardFrom ? { heardFrom: form.heardFrom } : {}) };
  if (signedIn && form.addressId) return { ...base, contact: { name: '', phone: '', notes: form.notes.trim() } };
  return {
    ...base,
    contact: {
      name: form.name.trim(),
      phone: form.phone.trim(),
      ...(form.fulfillment === 'delivery' ? { address: joinAddress(form.address, form.landmark) } : {}),
      notes: form.notes.trim(),
    },
  };
};
