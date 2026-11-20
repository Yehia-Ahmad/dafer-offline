// The Arabic help, in reading order (the brief's section list). One file per section.
import { HelpSection } from '../../help.models';
import { ACCOUNTS } from './accounts';
import { CAMPAIGNS } from './campaigns';
import { LEADS } from './leads';
import { MARKETING_RESULTS } from './marketing-results';
import { META_CONNECTION } from './meta-connection';
import { META_PUBLISH } from './meta-publish';
import { AUDIT } from './audit';
import { CASHBOX } from './cashbox';
import { CLOSING } from './closing';
import { COURIERS } from './couriers';
import { CREDIT_SALES } from './credit-sales';
import { CUSTOMERS } from './customers';
import { EXPENSES } from './expenses';
import { GLOSSARY } from './glossary';
import { HOME } from './home';
import { INVOICE_HISTORY } from './invoice-history';
import { MANUAL_ENTRY } from './manual-entry';
import { MOBILE_APP } from './mobile-app';
import { OPENING } from './opening';
import { ORDERS } from './orders';
import { PRINTING } from './printing';
import { PRODUCTS } from './products';
import { PROFIT_REPORT } from './profit-report';
import { PURCHASES } from './purchases';
import { REPORTS } from './reports';
import { RETURNS } from './returns';
import { SELLING } from './selling';
import { SHOP_PROFILE } from './shop-profile';
import { START } from './start';
import { STOREFRONT } from './storefront';
import { SUPPLIERS } from './suppliers';
import { SUPPORT } from './support';
import { USERS } from './users';
import { VAT } from './vat';
import { WEBSITE_CUSTOMERS } from './website-customers';
import { WEBSITE_SETTINGS } from './website-settings';

export const HELP_SECTIONS_AR: readonly HelpSection[] = [
  START,
  HOME,
  SELLING,
  CREDIT_SALES,
  INVOICE_HISTORY,
  RETURNS,
  CUSTOMERS,
  PRODUCTS,
  PROFIT_REPORT,
  PURCHASES,
  SUPPLIERS,
  CASHBOX,
  EXPENSES,
  ACCOUNTS,
  MANUAL_ENTRY,
  OPENING,
  CLOSING,
  VAT,
  REPORTS,
  WEBSITE_SETTINGS,
  ORDERS,
  COURIERS,
  WEBSITE_CUSTOMERS,
  CAMPAIGNS,
  MARKETING_RESULTS,
  META_CONNECTION,
  META_PUBLISH,
  LEADS,
  STOREFRONT,
  USERS,
  SHOP_PROFILE,
  AUDIT,
  PRINTING,
  MOBILE_APP,
  GLOSSARY,
  SUPPORT,
];
