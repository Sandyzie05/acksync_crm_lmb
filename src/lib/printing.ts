import {
  DOCUMENT_TYPE_LABELS,
  formatCurrencyFromPaise,
  formatDateTime,
  formatGstRate,
  formatPaymentModeLabel,
  quantityMillisToDisplay,
} from "./format";
import type { PrinterProfile, SaleDetails, ShopProfile } from "../types";

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function groupTaxRows(sale: SaleDetails) {
  const grouped = new Map<number, { taxable: number; tax: number; gross: number }>();

  for (const line of sale.lines) {
    const current = grouped.get(line.gstRate) ?? { taxable: 0, tax: 0, gross: 0 };
    current.taxable += line.lineSubtotalPaise;
    current.tax += line.lineTaxPaise;
    current.gross += line.lineTotalPaise;
    grouped.set(line.gstRate, current);
  }

  return [...grouped.entries()].sort((left, right) => left[0] - right[0]);
}

function buildSharedHeader(shop: ShopProfile, sale: SaleDetails, title: string) {
  return `
    <header class="print-header">
      <div class="brand-mark"></div>
      <div class="title-stack">
        <h1>${escapeHtml(shop.shopName)}</h1>
        <p>${escapeHtml(title)}</p>
      </div>
      <div class="meta-chip">${escapeHtml(sale.billNumber)}</div>
    </header>
    <section class="shop-strip">
      <div>
        <strong>Address</strong>
        <span>${escapeHtml(shop.address || "Counter Address Not Set")}</span>
      </div>
      <div>
        <strong>Phone</strong>
        <span>${escapeHtml(shop.phone || "-")}</span>
      </div>
      <div>
        <strong>GSTIN</strong>
        <span>${escapeHtml(shop.gstin || "-")}</span>
      </div>
      <div>
        <strong>Payment</strong>
        <span>${formatPaymentModeLabel(sale.paymentMode)}</span>
      </div>
      ${
        sale.customerName
          ? `<div><strong>Customer</strong><span>${escapeHtml(sale.customerName)}</span></div>`
          : ""
      }
      <div>
        <strong>Time</strong>
        <span>${formatDateTime(sale.saleTimestamp)}</span>
      </div>
      <div>
        <strong>Document</strong>
        <span>${DOCUMENT_TYPE_LABELS[sale.documentType]}</span>
      </div>
    </section>
  `;
}

function buildReceiptHtml(shop: ShopProfile, sale: SaleDetails, printerName?: string) {
  const taxRows = groupTaxRows(sale)
    .map(
      ([gstRate, totals]) => `
        <tr>
          <td>${formatGstRate(gstRate)}</td>
          <td>${formatCurrencyFromPaise(totals.taxable)}</td>
          <td>${formatCurrencyFromPaise(totals.tax)}</td>
        </tr>
      `,
    )
    .join("");

  const lineRows = sale.lines
    .map(
      (line) => `
        <tr>
          <td>
            <div class="item-name">${escapeHtml(line.itemName)}</div>
            <div class="item-meta">${escapeHtml(line.categoryName)} • ${formatGstRate(line.gstRate)} GST</div>
          </td>
          <td>${escapeHtml(quantityMillisToDisplay(line.quantityMillis, line.unit))}</td>
          <td>${formatCurrencyFromPaise(line.unitPricePaise)}</td>
          <td>${formatCurrencyFromPaise(line.lineTotalPaise)}</td>
        </tr>
      `,
    )
    .join("");

  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <title>${escapeHtml(sale.billNumber)}</title>
        <style>
          ${sharedStyles()}
          body { max-width: 88mm; margin: 0 auto; }
          .totals-grid strong { font-size: 1rem; }
        </style>
      </head>
      <body>
        ${buildSharedHeader(shop, sale, "Customer Receipt")}
        ${printerBanner(printerName)}
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Qty</th>
              <th>Rate</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>${lineRows}</tbody>
        </table>
        <section class="totals-grid">
          <div><span>Taxable</span><strong>${formatCurrencyFromPaise(sale.subtotalPaise)}</strong></div>
          <div><span>GST</span><strong>${formatCurrencyFromPaise(sale.taxTotalPaise)}</strong></div>
          <div><span>Grand Total</span><strong>${formatCurrencyFromPaise(sale.grandTotalPaise)}</strong></div>
        </section>
        <section class="tax-panel">
          <h2>GST Split</h2>
          <table>
            <thead>
              <tr><th>Rate</th><th>Taxable</th><th>Tax</th></tr>
            </thead>
            <tbody>${taxRows}</tbody>
          </table>
        </section>
        <footer class="print-footer">
          <p>${escapeHtml(shop.footerNote)}</p>
        </footer>
      </body>
    </html>
  `;
}

function buildInvoiceHtml(shop: ShopProfile, sale: SaleDetails, printerName?: string) {
  const taxRows = groupTaxRows(sale)
    .map(
      ([gstRate, totals]) => `
        <tr>
          <td>${formatGstRate(gstRate)}</td>
          <td>${formatCurrencyFromPaise(totals.taxable)}</td>
          <td>${formatCurrencyFromPaise(totals.tax)}</td>
          <td>${formatCurrencyFromPaise(totals.gross)}</td>
        </tr>
      `,
    )
    .join("");

  const lineRows = sale.lines
    .map(
      (line, index) => `
        <tr>
          <td>${index + 1}</td>
          <td>${escapeHtml(line.itemName)}</td>
          <td>${escapeHtml(line.categoryName)}</td>
          <td>${escapeHtml(quantityMillisToDisplay(line.quantityMillis, line.unit))}</td>
          <td>${formatCurrencyFromPaise(line.unitPricePaise)}</td>
          <td>${formatGstRate(line.gstRate)}</td>
          <td>${formatCurrencyFromPaise(line.lineSubtotalPaise)}</td>
          <td>${formatCurrencyFromPaise(line.lineTaxPaise)}</td>
          <td>${formatCurrencyFromPaise(line.lineTotalPaise)}</td>
        </tr>
      `,
    )
    .join("");

  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <title>${escapeHtml(sale.billNumber)}</title>
        <style>
          ${sharedStyles()}
          body { max-width: 210mm; margin: 0 auto; }
          .invoice-grid {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 1rem;
          }
          .invoice-grid article {
            border: 1px solid rgba(98, 74, 43, 0.16);
            border-radius: 1rem;
            padding: 0.9rem;
            background: rgba(255, 250, 243, 0.92);
          }
        </style>
      </head>
      <body>
        ${buildSharedHeader(shop, sale, "GST Invoice")}
        ${printerBanner(printerName)}
        <section class="invoice-grid">
          <article><strong>Invoice No.</strong><span>${escapeHtml(sale.billNumber)}</span></article>
          <article><strong>Sale Time</strong><span>${formatDateTime(sale.saleTimestamp)}</span></article>
          <article><strong>Payment Mode</strong><span>${formatPaymentModeLabel(sale.paymentMode)}</span></article>
        </section>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Item</th>
              <th>Category</th>
              <th>Quantity</th>
              <th>Rate</th>
              <th>GST</th>
              <th>Taxable</th>
              <th>Tax</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>${lineRows}</tbody>
        </table>
        <section class="totals-grid">
          <div><span>Taxable Total</span><strong>${formatCurrencyFromPaise(sale.subtotalPaise)}</strong></div>
          <div><span>GST Total</span><strong>${formatCurrencyFromPaise(sale.taxTotalPaise)}</strong></div>
          <div><span>Invoice Total</span><strong>${formatCurrencyFromPaise(sale.grandTotalPaise)}</strong></div>
        </section>
        <section class="tax-panel">
          <h2>Tax Summary</h2>
          <table>
            <thead>
              <tr><th>GST Rate</th><th>Taxable Value</th><th>Tax Amount</th><th>Gross Value</th></tr>
            </thead>
            <tbody>${taxRows}</tbody>
          </table>
        </section>
        <footer class="print-footer">
          <p>${escapeHtml(shop.footerNote)}</p>
          <p>For shop use only. Keep this invoice for GST reporting and daily closing.</p>
        </footer>
      </body>
    </html>
  `;
}

function printerBanner(printerName?: string) {
  if (!printerName) {
    return "";
  }

  return `<div class="printer-banner">Configured printer: ${escapeHtml(printerName)}</div>`;
}

function sharedStyles() {
  return `
    :root {
      color-scheme: light;
      font-family: "Aptos", "Segoe UI", sans-serif;
      color: #2a1a13;
      background: #fffaf2;
    }
    body {
      padding: 1.5rem;
      background:
        radial-gradient(circle at top right, rgba(203, 125, 54, 0.12), transparent 28%),
        linear-gradient(180deg, #fffaf2 0%, #fff4e2 100%);
    }
    .print-header {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1rem;
      padding-bottom: 1rem;
      border-bottom: 2px solid rgba(98, 74, 43, 0.18);
    }
    .brand-mark {
      width: 1rem;
      align-self: stretch;
      border-radius: 999px;
      background: linear-gradient(180deg, #d86e28 0%, #8c4314 100%);
    }
    .title-stack {
      flex: 1;
    }
    .title-stack h1 {
      margin: 0;
      font: 700 1.55rem/1.1 "Georgia", serif;
      letter-spacing: 0.02em;
    }
    .title-stack p {
      margin: 0.35rem 0 0;
      color: #815f42;
      font-size: 0.92rem;
    }
    .meta-chip {
      padding: 0.75rem 1rem;
      border-radius: 999px;
      background: rgba(140, 67, 20, 0.1);
      font-weight: 700;
      letter-spacing: 0.04em;
    }
    .shop-strip {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
      gap: 0.8rem;
      margin-bottom: 1rem;
    }
    .shop-strip div {
      padding: 0.8rem 0.9rem;
      border-radius: 1rem;
      background: rgba(255, 255, 255, 0.85);
      border: 1px solid rgba(98, 74, 43, 0.1);
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }
    .shop-strip strong {
      color: #80552f;
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .printer-banner {
      margin: 0 0 1rem;
      padding: 0.65rem 0.9rem;
      border-radius: 0.9rem;
      background: rgba(247, 205, 84, 0.18);
      color: #66491f;
      font-size: 0.85rem;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 1rem;
      background: rgba(255, 255, 255, 0.88);
      border-radius: 1rem;
      overflow: hidden;
    }
    th, td {
      padding: 0.7rem 0.75rem;
      border-bottom: 1px solid rgba(98, 74, 43, 0.1);
      text-align: left;
      vertical-align: top;
      font-size: 0.92rem;
    }
    th {
      color: #80552f;
      background: rgba(243, 222, 187, 0.4);
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .item-name {
      font-weight: 700;
    }
    .item-meta {
      color: #876241;
      font-size: 0.78rem;
      margin-top: 0.2rem;
    }
    .totals-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 0.75rem;
      margin-bottom: 1rem;
    }
    .totals-grid div {
      padding: 0.95rem 1rem;
      border-radius: 1rem;
      background: rgba(255, 255, 255, 0.88);
      border: 1px solid rgba(98, 74, 43, 0.12);
      display: flex;
      flex-direction: column;
      gap: 0.3rem;
    }
    .totals-grid span {
      color: #876241;
      font-size: 0.82rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .tax-panel h2 {
      margin: 0 0 0.6rem;
      font: 700 1rem/1.2 "Georgia", serif;
    }
    .print-footer {
      margin-top: 1rem;
      padding-top: 0.9rem;
      border-top: 1px dashed rgba(98, 74, 43, 0.22);
      color: #78573c;
      text-align: center;
      font-size: 0.85rem;
    }
    @media print {
      body { padding: 0.5rem; background: #ffffff; }
      .printer-banner { display: none; }
    }
  `;
}

export function buildSalePrintHtml(
  shop: ShopProfile,
  sale: SaleDetails,
  requestedDocument: "receipt" | "gst_invoice",
  printerProfiles: PrinterProfile[],
) {
  const printerName =
    printerProfiles.find((profile) => profile.profileType === requestedDocument)?.printerName ?? "";

  return requestedDocument === "receipt"
    ? buildReceiptHtml(shop, sale, printerName)
    : buildInvoiceHtml(shop, sale, printerName);
}

export function printHtmlDocument(title: string, html: string) {
  const printWindow = window.open("", "_blank", "width=900,height=1000");

  if (!printWindow) {
    throw new Error("The print window could not be opened.");
  }

  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.document.title = title;
  printWindow.focus();

  const triggerPrint = () => {
    printWindow.print();
    printWindow.onafterprint = () => printWindow.close();
  };

  if (printWindow.document.readyState === "complete") {
    triggerPrint();
  } else {
    printWindow.onload = triggerPrint;
  }
}
