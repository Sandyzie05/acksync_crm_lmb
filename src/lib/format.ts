import type { BillingTotals, DraftLine } from "../types";

export const UNIT_OPTIONS = [
  "piece",
  "kg",
  "litre",
  "packet",
  "box",
  "tray",
  "custom",
] as const;

export const GST_OPTIONS = [5, 18] as const;

export const PAYMENT_MODE_LABELS = {
  cash: "Cash",
  upi: "UPI",
  cheque: "Cheque",
} as const;

export const DOCUMENT_TYPE_LABELS = {
  receipt: "Receipt",
  gst_invoice: "GST Invoice",
} as const;

export const PRINTER_PROFILE_LABELS = {
  receipt: "Receipt Printer",
  gst_invoice: "GST Invoice Printer",
} as const;

export function formatCurrencyFromPaise(paise: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(paise / 100);
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function quantityStringToMillis(rawValue: string): number {
  const parsed = Number.parseFloat(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }

  return Math.round(parsed * 1000);
}

export function quantityMillisToString(quantityMillis: number): string {
  const raw = quantityMillis / 1000;
  const rounded = raw % 1 === 0 ? raw.toFixed(0) : raw.toFixed(3);
  return rounded.replace(/\.?0+$/, "");
}

export function quantityMillisToDisplay(quantityMillis: number, unit: string): string {
  const amount = quantityMillisToString(quantityMillis);

  if (unit === "piece" && !amount.includes(".")) {
    return `${amount} pc`;
  }

  return `${amount} ${unit}`;
}

export function padCounter(value: number): string {
  return `${value}`.padStart(5, "0");
}

export function toInclusiveBreakdown(
  unitPricePaise: number,
  quantityMillis: number,
  gstRate: number,
) {
  const lineTotalPaise = Math.round((unitPricePaise * quantityMillis) / 1000);
  const lineSubtotalPaise = Math.round((lineTotalPaise * 100) / (100 + gstRate));
  const lineTaxPaise = lineTotalPaise - lineSubtotalPaise;

  return {
    lineSubtotalPaise,
    lineTaxPaise,
    lineTotalPaise,
  };
}

export function recalculateDraftLine(line: DraftLine, quantityMillis: number): DraftLine {
  const safeQuantity = Math.max(quantityMillis, 0);
  const totals = toInclusiveBreakdown(line.unitPricePaise, safeQuantity, line.gstRate);

  return {
    ...line,
    quantityMillis: safeQuantity,
    ...totals,
  };
}

export function sumDraftTotals(lines: DraftLine[]): BillingTotals {
  return lines.reduce<BillingTotals>(
    (totals, line) => ({
      subtotalPaise: totals.subtotalPaise + line.lineSubtotalPaise,
      taxPaise: totals.taxPaise + line.lineTaxPaise,
      grandTotalPaise: totals.grandTotalPaise + line.lineTotalPaise,
    }),
    { subtotalPaise: 0, taxPaise: 0, grandTotalPaise: 0 },
  );
}

export function downloadFriendlyTimestamp() {
  const value = new Date();
  const parts = [
    value.getFullYear(),
    `${value.getMonth() + 1}`.padStart(2, "0"),
    `${value.getDate()}`.padStart(2, "0"),
    `${value.getHours()}`.padStart(2, "0"),
    `${value.getMinutes()}`.padStart(2, "0"),
  ];

  return `${parts[0]}-${parts[1]}-${parts[2]}_${parts[3]}-${parts[4]}`;
}

export function toInputPrice(paise: number): string {
  return (paise / 100).toFixed(2);
}

export function fromInputPrice(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return Math.round(parsed * 100);
}
