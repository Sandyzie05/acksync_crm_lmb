import {
  DOCUMENT_TYPE_LABELS,
  formatCurrencyFromPaise,
  formatDateTime,
  formatGstRate,
  formatPaymentModeLabel,
  quantityMillisToDisplay,
} from "./format";
import type { PrinterProfile, SaleDetails, ShopProfile } from "../types";

const THERMAL_WIDTH = 42;

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function toReceiptMoney(paise: number) {
  return (paise / 100).toFixed(2);
}

function centerText(value: string, width = THERMAL_WIDTH) {
  const trimmed = value.trim();
  if (trimmed.length >= width) {
    return trimmed.slice(0, width);
  }

  const leftPadding = Math.floor((width - trimmed.length) / 2);
  return `${" ".repeat(leftPadding)}${trimmed}`;
}

function rightPair(label: string, value: string, width = THERMAL_WIDTH) {
  const safeLabel = label.slice(0, width);
  const safeValue = value.slice(0, width);
  const spacing = Math.max(1, width - safeLabel.length - safeValue.length);
  return `${safeLabel}${" ".repeat(spacing)}${safeValue}`;
}

function padCell(value: string, width: number, align: "left" | "right" = "left") {
  const safeValue = value.length > width ? value.slice(0, width) : value;
  return align === "right" ? safeValue.padStart(width, " ") : safeValue.padEnd(width, " ");
}

function receiptDateParts(value: string) {
  const date = new Date(value);
  return {
    date: new Intl.DateTimeFormat("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(date),
    time: new Intl.DateTimeFormat("en-IN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }).format(date),
  };
}

const SMALL_NUMBER_WORDS = [
  "Zero",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];

const TENS_WORDS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function twoDigitWords(value: number): string {
  if (value < 20) {
    return SMALL_NUMBER_WORDS[value];
  }

  const tens = Math.floor(value / 10);
  const ones = value % 10;
  return ones === 0 ? TENS_WORDS[tens] : `${TENS_WORDS[tens]} ${SMALL_NUMBER_WORDS[ones]}`;
}

function numberToIndianWords(value: number): string {
  if (value === 0) {
    return "Zero";
  }

  const parts: string[] = [];
  let remaining = value;
  const crore = Math.floor(remaining / 10000000);
  if (crore > 0) {
    parts.push(`${numberToIndianWords(crore)} Crore`);
    remaining %= 10000000;
  }
  const lakh = Math.floor(remaining / 100000);
  if (lakh > 0) {
    parts.push(`${numberToIndianWords(lakh)} Lakh`);
    remaining %= 100000;
  }
  const thousand = Math.floor(remaining / 1000);
  if (thousand > 0) {
    parts.push(`${numberToIndianWords(thousand)} Thousand`);
    remaining %= 1000;
  }
  const hundred = Math.floor(remaining / 100);
  if (hundred > 0) {
    parts.push(`${SMALL_NUMBER_WORDS[hundred]} Hundred`);
    remaining %= 100;
  }
  if (remaining > 0) {
    parts.push(twoDigitWords(remaining));
  }

  return parts.join(" ");
}

function wrapReceiptText(value: string, width = THERMAL_WIDTH) {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (!current) {
      current = word;
    } else if (`${current} ${word}`.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines;
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
      ${
        sale.customerGstin
          ? `<div><strong>Buyer GSTIN</strong><span>${escapeHtml(sale.customerGstin)}</span></div>`
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

export function buildThermalReceiptText(shop: ShopProfile, sale: SaleDetails) {
  const separator = "-".repeat(THERMAL_WIDTH);
  const wideSeparator = "=".repeat(THERMAL_WIDTH);
  const { date, time } = receiptDateParts(sale.saleTimestamp);
  const taxRows = groupTaxRows(sale).filter(([gstRate]) => gstRate > 0);
  const amountInWords = `${numberToIndianWords(Math.round(sale.grandTotalPaise / 100))} Only`;
  const lines: string[] = [
    centerText(shop.shopName.toUpperCase()),
    ...wrapReceiptText(shop.address || "S.R.C.B Road, Fancy Bazar, Guwahati", THERMAL_WIDTH).map((line) =>
      centerText(line),
    ),
    centerText(shop.phone ? `PH - ${shop.phone}` : "PH - 0361 2542213"),
    centerText(shop.gstin ? `GSTIN - ${shop.gstin}` : "GSTIN -"),
    centerText(DOCUMENT_TYPE_LABELS[sale.documentType]),
    separator,
    rightPair(`Memo# ${sale.billNumber}`, `${time}  ${date}`),
    sale.customerName ? `Customer: ${sale.customerName}`.slice(0, THERMAL_WIDTH) : "Customer: Walk-in",
    ...(sale.customerGstin ? [`GSTIN: ${sale.customerGstin}`.slice(0, THERMAL_WIDTH)] : []),
    centerText(`Order# ${sale.id}`),
    separator,
    `${padCell("Sr Product", 18)}${padCell("Qty", 8, "right")}${padCell("Rate", 8, "right")}${padCell("Amount", 8, "right")}`,
    separator,
  ];

  sale.lines.forEach((line, index) => {
    const quantity = quantityMillisToDisplay(line.quantityMillis, line.unit).replace("piece", "Pcs").replace("pc", "Pcs");
    lines.push(
      `${padCell(`${index + 1} ${line.itemName.toUpperCase()}`, 18)}${padCell(quantity, 8, "right")}${padCell(
        toReceiptMoney(line.unitPricePaise),
        8,
        "right",
      )}${padCell(toReceiptMoney(line.lineTotalPaise), 8, "right")}`,
    );
  });

  lines.push(
    separator,
    rightPair("Sub Total", toReceiptMoney(sale.subtotalPaise)),
    wideSeparator,
    rightPair(`Total Qty: ${quantityMillisToDisplay(sale.lines.reduce((sum, line) => sum + line.quantityMillis, 0), "piece")}`, `Amt: ${toReceiptMoney(sale.grandTotalPaise)}`),
    ...wrapReceiptText(`(INR ${amountInWords})`, THERMAL_WIDTH),
    rightPair("Tender:", toReceiptMoney(sale.grandTotalPaise)),
    rightPair(`Pay Mode: ${formatPaymentModeLabel(sale.paymentMode)}:`, toReceiptMoney(sale.grandTotalPaise)),
    separator,
    rightPair("Item Value", toReceiptMoney(sale.subtotalPaise)),
  );

  for (const [gstRate, totals] of taxRows) {
    const halfRate = gstRate / 2;
    lines.push(
      rightPair(`Output Cgst @ ${halfRate}%`, toReceiptMoney(Math.round(totals.tax / 2))),
      rightPair(`Output Sgst @ ${halfRate}%`, toReceiptMoney(totals.tax - Math.round(totals.tax / 2))),
    );
  }

  lines.push(separator, "", centerText((shop.footerNote || "THANK YOU, VISIT AGAIN").toUpperCase()), "", "");
  return lines.join("\n");
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
