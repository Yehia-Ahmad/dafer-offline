import { whatsappLink } from './order-actions';

/** The values the placeholders of the confirmation message stand for. */
export interface WhatsappVars {
  name: string;
  number: string;
  total: number;
  /** The zone's estimated delivery time; empty for a pickup order. */
  deliveryTime: string;
}

/** 230 → "230", 230.5 → "230.5", 230.25 → "230.25". */
const amount = (value: number): string => String(Math.round((Number(value) + Number.EPSILON) * 100) / 100);

/**
 * Fills the shop's confirmation template: {الاسم} {رقم الطلب} {الإجمالي} {مدة التوصيل}. Every occurrence is replaced; anything else in
 * braces stays as typed. An empty delivery time (pickup) becomes "—".
 */
export function fillWhatsappTemplate(template: string, vars: WhatsappVars): string {
  const values: Record<string, string> = {
    'الاسم': vars.name,
    'رقم الطلب': vars.number,
    'الإجمالي': amount(vars.total),
    'مدة التوصيل': vars.deliveryTime.trim() || '—',
  };
  return template.replace(/\{([^{}]+)\}/g, (match, key: string) => (Object.prototype.hasOwnProperty.call(values, key.trim()) ? values[key.trim()] : match));
}

/** `https://wa.me/<customer phone>?text=<filled template>` (opened in a new tab; no WhatsApp API). */
export function whatsappConfirmLink(phone: string, template: string, vars: WhatsappVars): string {
  return `${whatsappLink(phone)}?text=${encodeURIComponent(fillWhatsappTemplate(template, vars))}`;
}
