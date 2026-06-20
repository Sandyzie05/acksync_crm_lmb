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

export const GST_OPTIONS = [0, 5, 18] as const;

export const DOCUMENT_TYPE_LABELS = {
  receipt: "Receipt",
  manual_receipt: "Manual Receipt",
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

export function formatIndianDate(value: string): string {
  const [year, month, day] = value.slice(0, 10).split("-");

  if (!year || !month || !day) {
    return value;
  }

  return `${day}/${month}/${year}`;
}

export function isoDateToIndianInput(value: string): string {
  return formatIndianDate(value);
}

export function indianDateInputToIso(value: string): string | null {
  const match = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);

  if (!match) {
    return null;
  }

  const [, dayPart, monthPart, yearPart] = match;
  const day = Number(dayPart);
  const month = Number(monthPart);
  const year = Number(yearPart);
  const candidate = new Date(year, month - 1, day);

  if (
    candidate.getFullYear() !== year ||
    candidate.getMonth() !== month - 1 ||
    candidate.getDate() !== day
  ) {
    return null;
  }

  return `${yearPart}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function formatGstRate(gstRate: number): string {
  return gstRate === 0 ? "NA" : `${gstRate}%`;
}

export function formatPaymentModeLabel(paymentMode: string): string {
  if (paymentMode.includes("|")) {
    return paymentMode
      .split("|")
      .map((part) => {
        const colonIdx = part.indexOf(":");
        if (colonIdx === -1) return formatSinglePaymentMode(part);
        const mode = part.slice(0, colonIdx);
        const paise = Number(part.slice(colonIdx + 1));
        const rupees = (paise / 100).toFixed(2);
        return `${formatSinglePaymentMode(mode)} ₹${rupees}`;
      })
      .join(" + ");
  }

  return formatSinglePaymentMode(paymentMode);
}

function formatSinglePaymentMode(paymentMode: string): string {
  const normalized = paymentMode.trim().toLowerCase();
  const labels: Record<string, string> = {
    "axis upi": "Axis UPI",
    cash: "Cash",
    "credit sale": "Credit sale",
    phonepe: "PhonePe",
    upi: "UPI",
    zomato: "Zomato",
  };

  if (labels[normalized]) {
    return labels[normalized];
  }

  return paymentMode
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

export function todayIsoDate(): string {
  const today = new Date();
  const year = today.getFullYear();
  const month = `${today.getMonth() + 1}`.padStart(2, "0");
  const day = `${today.getDate()}`.padStart(2, "0");

  return `${year}-${month}-${day}`;
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
  if (Number.isInteger(raw)) {
    return raw.toFixed(0);
  }

  return raw.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
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
  priceIncludesGst = true,
) {
  const lineBasePaise = Math.round((unitPricePaise * quantityMillis) / 1000);
  const lineSubtotalPaise = priceIncludesGst
    ? Math.round((lineBasePaise * 100) / (100 + gstRate))
    : lineBasePaise;
  const lineTaxPaise = priceIncludesGst
    ? lineBasePaise - lineSubtotalPaise
    : Math.round((lineSubtotalPaise * gstRate) / 100);
  const lineTotalPaise = lineSubtotalPaise + lineTaxPaise;

  return {
    lineSubtotalPaise,
    lineTaxPaise,
    lineTotalPaise,
  };
}

export function toInclusiveBreakdownFromTotal(lineTotalPaise: number, gstRate: number) {
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
  const totals = toInclusiveBreakdown(
    line.unitPricePaise,
    safeQuantity,
    line.gstRate,
    line.priceIncludesGst,
  );

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
