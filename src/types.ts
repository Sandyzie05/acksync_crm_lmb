export type AppView = "home" | "billing" | "admin" | "reports" | "settings";

export type PaymentMode = string;
export type DocumentType = "receipt" | "gst_invoice";
export type SaleStatus = "completed" | "voided" | "reissued";
export type PrinterProfileType = "receipt" | "gst_invoice";

export interface ShopProfile {
  shopName: string;
  address: string;
  gstin: string;
  phone: string;
  receiptPrefix: string;
  invoicePrefix: string;
  nextReceiptNumber: number;
  nextInvoiceNumber: number;
  footerNote: string;
}

export interface AdminSettings {
  adminName: string;
  lastBackupAt: string | null;
}

export interface Category {
  id: number;
  name: string;
  displayOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Item {
  id: number;
  categoryId: number;
  categoryName: string;
  name: string;
  unit: string;
  unitPricePaise: number;
  gstRate: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PrinterProfile {
  id: number;
  profileType: PrinterProfileType;
  printerName: string;
  updatedAt: string;
}

export interface PaymentOption {
  id: number;
  name: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: number;
  action: string;
  entityType: string;
  entityId: string | null;
  detail: string;
  createdAt: string;
}

export interface SaleRegisterRow {
  id: number;
  billNumber: string;
  documentType: DocumentType;
  saleTimestamp: string;
  customerName: string | null;
  paymentMode: PaymentMode;
  subtotalPaise: number;
  taxTotalPaise: number;
  grandTotalPaise: number;
  status: SaleStatus;
  notes: string | null;
  reissueOfSaleId: number | null;
  voidedBySaleId: number | null;
}

export interface SaleLine {
  id: number;
  saleId: number;
  itemId: number | null;
  itemName: string;
  categoryName: string;
  unit: string;
  quantityMillis: number;
  unitPricePaise: number;
  gstRate: number;
  lineSubtotalPaise: number;
  lineTaxPaise: number;
  lineTotalPaise: number;
}

export interface SaleDetails extends SaleRegisterRow {
  lines: SaleLine[];
}

export interface DraftLine {
  draftId: number;
  itemId: number;
  itemName: string;
  categoryId: number;
  categoryName: string;
  unit: string;
  quantityMillis: number;
  unitPricePaise: number;
  gstRate: number;
  lineSubtotalPaise: number;
  lineTaxPaise: number;
  lineTotalPaise: number;
}

export interface DashboardMetrics {
  todaySalesCount: number;
  todayGrossPaise: number;
  todayTaxPaise: number;
  activeItems: number;
  activeCategories: number;
  pendingPrinterProfiles: number;
}

export interface GstSummaryRow {
  gstRate: number;
  taxablePaise: number;
  taxPaise: number;
  grossPaise: number;
}

export interface PaymentSummaryRow {
  paymentMode: PaymentMode;
  saleCount: number;
  totalPaise: number;
}

export interface ItemwiseSummaryRow {
  itemName: string;
  categoryName: string;
  unit: string;
  quantityMillis: number;
  grossPaise: number;
}

export interface SaleDraftInput {
  documentType: DocumentType;
  paymentMode: PaymentMode;
  customerName: string;
  notes: string;
  lines: DraftLine[];
  reissueOfSaleId?: number | null;
}

export interface AppSnapshot {
  shopProfile: ShopProfile;
  adminSettings: AdminSettings;
  categories: Category[];
  items: Item[];
  paymentOptions: PaymentOption[];
  printerProfiles: PrinterProfile[];
  dashboardMetrics: DashboardMetrics;
  recentSales: SaleRegisterRow[];
  auditTrail: AuditEntry[];
}

export interface RuntimeInfo {
  platform: string;
  appConfigDir: string;
  databasePath: string;
  tempDir: string;
}

export interface BillingTotals {
  subtotalPaise: number;
  taxPaise: number;
  grandTotalPaise: number;
}
