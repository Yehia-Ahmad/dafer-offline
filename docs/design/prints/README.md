# Nota print designs

Source files from the Nota design canvas ("المطبوعات" page). They are design references, not runtime code.
Each file is one document. `PrHeader` and `PrFooter` are shared components, imported with
`<dc-import name="PrHeader" …>`; their props are the attributes. `{{…}}` and `<sc-for>` are the canvas
template syntax: read them as "repeat this row for each item". Inline styles and the `<helmet><style>` block
are the visual spec (colors, sizes, borders, spacing). The sample data is the shop from nota-test-data.xlsx.

| File | Document | Paper | Number |
|---|---|---|---|
| PrCashReceipt | cash sale receipt | 80mm | INV |
| PrPaymentReceipt | customer payment receipt | 80mm | RC |
| PrReturnReceipt | return receipt | 80mm | RT |
| PrShiftClose | shift close report | 80mm | SH |
| PrCashInvoice | cash sale invoice | A4 | INV |
| PrCreditInvoice | credit sale invoice + debt acknowledgment | A4 | CR |
| PrPurchaseInvoice | purchase invoice | A4 | PO |
| PrReceiptVoucher | receipt voucher | A5 | RC |
| PrPaymentVoucher | payment voucher | A5 | PV |
| PrCustomerStatement | customer statement + aging | A4 | — |
| PrSupplierStatement | supplier statement | A4 | — |
| PrStockList | stock count sheet | A4 | ST |
| PrProfitReport | profit report | A4 | — |
| PrFinancials | income statement + balance sheet | A4 | — |
| PrTrialBalance | trial balance | A4 | — |
| PrJournalEntry | journal entry | A4 | JE |
| PrHeader / PrFooter | shared header / footer | — | — |

Brand: primary #0E4D45, text #142321, muted #4A5856, table header #EEF3F1, borders #9A9A9A, font Alexandria.
In the app use the design-system tokens for these colors (prints use the light theme always).
