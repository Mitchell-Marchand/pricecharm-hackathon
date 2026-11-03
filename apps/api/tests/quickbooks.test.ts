import test from 'node:test';
import assert from 'node:assert/strict';
import { invoiceLabel, invoiceText, type Invoice } from '../src/integrations/quickbooks.js';

test('an invoice from QuickBooks is written out with its work and prices, never the customer', () => {
  const invoice = {
    Id: '130',
    DocNumber: '1042',
    TxnDate: '2026-06-03',
    TotalAmt: 412.5,
    CurrencyRef: { value: 'USD' },
    CustomerRef: { value: '9', name: 'Jane Customer' },
    BillAddr: { Line1: '12 Elm St' },
    Line: [
      {
        DetailType: 'SalesItemLineDetail',
        Amount: 320,
        Description: 'Driveway and front walk, about 900 sq ft',
        SalesItemLineDetail: {
          ItemRef: { value: '1', name: 'Driveway cleaning' },
          Qty: 1,
          UnitPrice: 320,
        },
      },
      {
        DetailType: 'SalesItemLineDetail',
        Amount: 90,
        SalesItemLineDetail: {
          ItemRef: { value: '2', name: 'Sealer' },
          Qty: 2,
          UnitPrice: 45,
          ServiceDate: '2026-06-04',
        },
      },
      {
        DetailType: 'GroupLineDetail',
        Amount: 40,
        GroupLineDetail: {
          GroupItemRef: { name: 'Gutter bundle' },
          Quantity: 1,
          Line: [
            {
              DetailType: 'SalesItemLineDetail',
              Amount: 40,
              SalesItemLineDetail: { ItemRef: { value: '1', name: 'Downspout flush' } },
            },
          ],
        },
      },
      { DetailType: 'SubTotalLineDetail', Amount: 450 },
      {
        DetailType: 'DiscountLineDetail',
        Amount: 45,
        DiscountLineDetail: { PercentBased: true, DiscountPercent: 10 },
      },
    ],
    TxnTaxDetail: { TotalTax: 7.5 },
    CustomerMemo: { value: 'Thanks, Jane!' },
    PrivateNote: 'Steep driveway, took longer',
  } as Invoice;
  const types = new Map([
    ['1', 'Service'],
    ['2', 'NonInventory'],
  ]);
  assert.equal(
    invoiceText(invoice, types),
    [
      'Invoice 1042, dated 2026-06-03, in USD.',
      'Lines:',
      '- Driveway cleaning (a service): Driveway and front walk, about 900 sq ft. 1 × 320.00 = 320.00',
      '- Sealer (a product or material), done 2026-06-04. 2 × 45.00 = 90.00',
      '- Gutter bundle, 1 of them. 40.00',
      '  - Downspout flush (a service). 40.00',
      'Discount: 10% = 45.00',
      'Tax: 7.50',
      'Total before tax: 405.00',
      'Message to the customer: Thanks, Jane!',
      "The owner's own note: Steep driveway, took longer",
    ].join('\n'),
  );
  assert.doesNotMatch(invoiceText(invoice, types), /Elm St|Jane Customer/);
  assert.equal(invoiceLabel(invoice), 'QuickBooks invoice 1042, Jun 3, 2026');
  assert.equal(
    invoiceLabel({ ...invoice, DocNumber: undefined, TxnDate: undefined }),
    'QuickBooks invoice',
  );
});
