import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import type {
  GstSummaryRow,
  ItemwiseSummaryRow,
  PaymentSummaryRow,
  SaleRegisterRow,
  ShopProfile,
} from "../types";
import {
  DOCUMENT_TYPE_LABELS,
  downloadFriendlyTimestamp,
  formatDateTime,
  formatGstRate,
  formatPaymentModeLabel,
  quantityMillisToString,
} from "./format";

interface ExportSheet {
  name: string;
  columns: { header: string; key: string; width: number }[];
  rows: Record<string, string | number | null>[];
}

function toRupees(paise: number) {
  return Number((paise / 100).toFixed(2));
}

async function writeWorkbook(fileStem: string, sheets: ExportSheet[]) {
  const { default: ExcelJS } = await import("exceljs");
  const targetPath = await save({
    title: "Export report",
    defaultPath: `${fileStem}_${downloadFriendlyTimestamp()}.xlsx`,
    filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }],
  });

  if (!targetPath) {
    return false;
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Acksync CRM";
  workbook.created = new Date();

  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sheet.name);
    worksheet.columns = sheet.columns;
    worksheet.addRows(sheet.rows);
    worksheet.getRow(1).font = { bold: true, color: { argb: "FF7D4718" } };
    worksheet.views = [{ state: "frozen", ySplit: 1 }];
  }

  const rawBuffer = await workbook.xlsx.writeBuffer();
  const bytes = rawBuffer instanceof Uint8Array ? rawBuffer : new Uint8Array(rawBuffer);
  await invoke("write_binary_file", {
    path: targetPath,
    bytes: Array.from(bytes),
  });

  return true;
}

export async function exportSalesRegister(
  shop: ShopProfile,
  sales: SaleRegisterRow[],
  dateFrom: string,
  dateTo: string,
) {
  const sheets: ExportSheet[] = [
    {
      name: "Sale Register",
      columns: [
        { header: "Shop", key: "shop", width: 22 },
        { header: "From", key: "from", width: 12 },
        { header: "To", key: "to", width: 12 },
        { header: "Bill Number", key: "billNumber", width: 18 },
        { header: "Customer", key: "customerName", width: 18 },
        { header: "Document", key: "documentType", width: 14 },
        { header: "Sale Time", key: "saleTimestamp", width: 22 },
        { header: "Payment", key: "paymentMode", width: 12 },
        { header: "Taxable", key: "subtotal", width: 12 },
        { header: "GST", key: "tax", width: 12 },
        { header: "Grand Total", key: "grandTotal", width: 14 },
        { header: "Status", key: "status", width: 12 },
      ],
      rows: sales.map((sale) => ({
        shop: shop.shopName,
        from: dateFrom,
        to: dateTo,
        billNumber: sale.billNumber,
        customerName: sale.customerName ?? "",
        documentType: DOCUMENT_TYPE_LABELS[sale.documentType],
        saleTimestamp: formatDateTime(sale.saleTimestamp),
        paymentMode: formatPaymentModeLabel(sale.paymentMode),
        subtotal: toRupees(sale.subtotalPaise),
        tax: toRupees(sale.taxTotalPaise),
        grandTotal: toRupees(sale.grandTotalPaise),
        status: sale.status,
      })),
    },
  ];

  return writeWorkbook("sale_register", sheets);
}

export async function exportGstSummary(
  shop: ShopProfile,
  summary: GstSummaryRow[],
  dateFrom: string,
  dateTo: string,
) {
  return writeWorkbook("gst_summary", [
    {
      name: "GST Summary",
      columns: [
        { header: "Shop", key: "shop", width: 22 },
        { header: "From", key: "from", width: 12 },
        { header: "To", key: "to", width: 12 },
        { header: "GST Rate", key: "gstRate", width: 10 },
        { header: "Taxable Value", key: "taxable", width: 16 },
        { header: "Tax Amount", key: "tax", width: 14 },
        { header: "Gross Value", key: "gross", width: 14 },
      ],
      rows: summary.map((row) => ({
        shop: shop.shopName,
        from: dateFrom,
        to: dateTo,
        gstRate: formatGstRate(row.gstRate),
        taxable: toRupees(row.taxablePaise),
        tax: toRupees(row.taxPaise),
        gross: toRupees(row.grossPaise),
      })),
    },
  ]);
}

export async function exportPaymentSummary(
  shop: ShopProfile,
  summary: PaymentSummaryRow[],
  dateFrom: string,
  dateTo: string,
) {
  return writeWorkbook("payment_summary", [
    {
      name: "Payment Summary",
      columns: [
        { header: "Shop", key: "shop", width: 22 },
        { header: "From", key: "from", width: 12 },
        { header: "To", key: "to", width: 12 },
        { header: "Payment Mode", key: "paymentMode", width: 14 },
        { header: "Sales Count", key: "saleCount", width: 12 },
        { header: "Total", key: "total", width: 14 },
      ],
      rows: summary.map((row) => ({
        shop: shop.shopName,
        from: dateFrom,
        to: dateTo,
        paymentMode: formatPaymentModeLabel(row.paymentMode),
        saleCount: row.saleCount,
        total: toRupees(row.totalPaise),
      })),
    },
  ]);
}

export async function exportItemwiseSummary(
  shop: ShopProfile,
  summary: ItemwiseSummaryRow[],
  dateFrom: string,
  dateTo: string,
) {
  return writeWorkbook("itemwise_summary", [
    {
      name: "Itemwise Summary",
      columns: [
        { header: "Shop", key: "shop", width: 22 },
        { header: "From", key: "from", width: 12 },
        { header: "To", key: "to", width: 12 },
        { header: "Category", key: "categoryName", width: 18 },
        { header: "Item", key: "itemName", width: 20 },
        { header: "Unit", key: "unit", width: 12 },
        { header: "Quantity", key: "quantity", width: 12 },
        { header: "Gross Value", key: "gross", width: 14 },
      ],
      rows: summary.map((row) => ({
        shop: shop.shopName,
        from: dateFrom,
        to: dateTo,
        categoryName: row.categoryName,
        itemName: row.itemName,
        unit: row.unit,
        quantity: quantityMillisToString(row.quantityMillis),
        gross: toRupees(row.grossPaise),
      })),
    },
  ]);
}
