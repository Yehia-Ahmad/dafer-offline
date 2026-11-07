import { AbstractControl, ValidationErrors } from '@angular/forms';

/**
 * Stage 21 review: a unit price has at most 2 decimals (the server refuses more with 400 PRICE_PRECISION). A price like
 * 10.005 would make a line total, the refund of one unit and the VAT disagree by a piaster.
 */
export const hasMoneyPrecision = (value: unknown): boolean => {
  if (value === null || value === undefined || value === '') return true;
  const number = Number(value);
  if (!Number.isFinite(number)) return true; // other validators report a non-number
  return Number.isInteger(Number((number * 100).toFixed(6)));
};

/** Reactive-forms validator: { decimals: true } when the value has more than 2 decimals. */
export const twoDecimalsValidator = (control: AbstractControl): ValidationErrors | null =>
  hasMoneyPrecision(control.value) ? null : { decimals: true };
