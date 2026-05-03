import Database from "@tauri-apps/plugin-sql";
import type {
  AdminSettings,
  AppSnapshot,
  AuditEntry,
  Category,
  DashboardMetrics,
  DraftLine,
  GstSummaryRow,
  Item,
  ItemwiseSummaryRow,
  PaymentSummaryRow,
  PrinterProfile,
  PrinterProfileType,
  SaleDetails,
  SaleDraftInput,
  SaleLine,
  SaleRegisterRow,
  ShopProfile,
} from "../types";
import { PRINTING_ENABLED } from "./features";

let databasePromise: Promise<Database> | null = null;
const DESKTOP_RUNTIME_MESSAGE =
  "Desktop runtime is not available. Run the app with `npm run tauri dev` or use the packaged desktop build.";

interface SqlShopProfileRow {
  shop_name: string;
  address: string;
  gstin: string;
  phone: string;
  receipt_prefix: string;
  invoice_prefix: string;
  next_receipt_number: number;
  next_invoice_number: number;
  footer_note: string;
}

interface SqlAdminRow {
  admin_name: string;
  last_backup_at: string | null;
}

interface SqlCategoryRow {
  id: number;
  name: string;
  display_order: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

interface SqlItemRow {
  id: number;
  category_id: number;
  category_name: string;
  name: string;
  unit: string;
  unit_price_paise: number;
  gst_rate: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

interface SqlPrinterProfileRow {
  id: number;
  profile_type: PrinterProfileType;
  printer_name: string;
  updated_at: string;
}

interface SqlAuditRow {
  id: number;
  action: string;
  entity_type: string;
  entity_id: string | null;
  detail: string;
  created_at: string;
}

interface SqlSaleRow {
  id: number;
  bill_number: string;
  document_type: "receipt" | "gst_invoice";
  sale_timestamp: string;
  payment_mode: "cash" | "upi" | "cheque";
  subtotal_paise: number;
  tax_total_paise: number;
  grand_total_paise: number;
  status: "completed" | "voided" | "reissued";
  notes: string | null;
  reissue_of_sale_id: number | null;
  voided_by_sale_id: number | null;
}

interface SqlSaleLineRow {
  id: number;
  sale_id: number;
  item_id: number | null;
  item_name: string;
  category_name: string;
  unit: string;
  quantity_millis: number;
  unit_price_paise: number;
  gst_rate: number;
  line_subtotal_paise: number;
  line_tax_paise: number;
  line_total_paise: number;
}

function mapShopProfile(row: SqlShopProfileRow): ShopProfile {
  return {
    shopName: row.shop_name,
    address: row.address,
    gstin: row.gstin,
    phone: row.phone,
    receiptPrefix: row.receipt_prefix,
    invoicePrefix: row.invoice_prefix,
    nextReceiptNumber: row.next_receipt_number,
    nextInvoiceNumber: row.next_invoice_number,
    footerNote: row.footer_note,
  };
}

function mapAdminSettings(row: SqlAdminRow): AdminSettings {
  return {
    adminName: row.admin_name,
    lastBackupAt: row.last_backup_at,
  };
}

function mapCategory(row: SqlCategoryRow): Category {
  return {
    id: row.id,
    name: row.name,
    displayOrder: row.display_order,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapItem(row: SqlItemRow): Item {
  return {
    id: row.id,
    categoryId: row.category_id,
    categoryName: row.category_name,
    name: row.name,
    unit: row.unit,
    unitPricePaise: row.unit_price_paise,
    gstRate: row.gst_rate,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPrinterProfile(row: SqlPrinterProfileRow): PrinterProfile {
  return {
    id: row.id,
    profileType: row.profile_type,
    printerName: row.printer_name,
    updatedAt: row.updated_at,
  };
}

function mapAuditEntry(row: SqlAuditRow): AuditEntry {
  return {
    id: row.id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

function mapSaleRow(row: SqlSaleRow): SaleRegisterRow {
  return {
    id: row.id,
    billNumber: row.bill_number,
    documentType: row.document_type,
    saleTimestamp: row.sale_timestamp,
    paymentMode: row.payment_mode,
    subtotalPaise: row.subtotal_paise,
    taxTotalPaise: row.tax_total_paise,
    grandTotalPaise: row.grand_total_paise,
    status: row.status,
    notes: row.notes,
    reissueOfSaleId: row.reissue_of_sale_id,
    voidedBySaleId: row.voided_by_sale_id,
  };
}

function mapSaleLine(row: SqlSaleLineRow): SaleLine {
  return {
    id: row.id,
    saleId: row.sale_id,
    itemId: row.item_id,
    itemName: row.item_name,
    categoryName: row.category_name,
    unit: row.unit,
    quantityMillis: row.quantity_millis,
    unitPricePaise: row.unit_price_paise,
    gstRate: row.gst_rate,
    lineSubtotalPaise: row.line_subtotal_paise,
    lineTaxPaise: row.line_tax_paise,
    lineTotalPaise: row.line_total_paise,
  };
}

async function initialiseDatabase(db: Database) {
  await db.execute("PRAGMA foreign_keys = ON");
  /* Mitigate "database is locked" under concurrent pool connections (see completeSale). */
  await db.execute("PRAGMA busy_timeout = 10000");
  await db.execute("PRAGMA journal_mode = WAL");

  const schemaStatements = [
    `CREATE TABLE IF NOT EXISTS shop_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      shop_name TEXT NOT NULL,
      address TEXT NOT NULL DEFAULT '',
      gstin TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      receipt_prefix TEXT NOT NULL DEFAULT 'RC',
      invoice_prefix TEXT NOT NULL DEFAULT 'GST',
      next_receipt_number INTEGER NOT NULL DEFAULT 1,
      next_invoice_number INTEGER NOT NULL DEFAULT 1,
      footer_note TEXT NOT NULL DEFAULT 'Thank you for visiting.'
    )`,
    `CREATE TABLE IF NOT EXISTS admin_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      admin_name TEXT NOT NULL DEFAULT 'Admin',
      last_backup_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      display_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      unit TEXT NOT NULL,
      unit_price_paise INTEGER NOT NULL,
      gst_rate INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(category_id, name),
      FOREIGN KEY(category_id) REFERENCES categories(id)
    )`,
    `CREATE TABLE IF NOT EXISTS printer_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_type TEXT NOT NULL UNIQUE,
      printer_name TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_number TEXT NOT NULL UNIQUE,
      document_type TEXT NOT NULL,
      sale_timestamp TEXT NOT NULL,
      payment_mode TEXT NOT NULL,
      subtotal_paise INTEGER NOT NULL,
      tax_total_paise INTEGER NOT NULL,
      grand_total_paise INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      notes TEXT,
      reissue_of_sale_id INTEGER,
      voided_by_sale_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(reissue_of_sale_id) REFERENCES sales(id),
      FOREIGN KEY(voided_by_sale_id) REFERENCES sales(id)
    )`,
    `CREATE TABLE IF NOT EXISTS sale_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL,
      item_id INTEGER,
      item_name TEXT NOT NULL,
      category_name TEXT NOT NULL,
      unit TEXT NOT NULL,
      quantity_millis INTEGER NOT NULL,
      unit_price_paise INTEGER NOT NULL,
      gst_rate INTEGER NOT NULL,
      line_subtotal_paise INTEGER NOT NULL,
      line_tax_paise INTEGER NOT NULL,
      line_total_paise INTEGER NOT NULL,
      FOREIGN KEY(sale_id) REFERENCES sales(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS audit_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  ];

  for (const statement of schemaStatements) {
    await db.execute(statement);
  }

  await db.execute(
    `INSERT OR IGNORE INTO shop_profile (
      id, shop_name, address, gstin, phone, receipt_prefix, invoice_prefix, next_receipt_number, next_invoice_number, footer_note
    ) VALUES (1, 'Laxmi Misthan Bhandhar', '', '', '', 'RC', 'GST', 1, 1, 'Thank you for visiting.')`,
  );

  await db.execute(
    `UPDATE shop_profile SET shop_name = 'Laxmi Misthan Bhandhar' WHERE id = 1 AND shop_name = 'LMB Sweet Shop'`,
  );

  await db.execute(`INSERT OR IGNORE INTO admin_settings (id, admin_name, last_backup_at) VALUES (1, 'Admin', NULL)`);
}

async function getDb() {
  const runtime = globalThis as typeof globalThis & {
    __TAURI_INTERNALS__?: unknown;
  };

  if (typeof runtime.__TAURI_INTERNALS__ === "undefined") {
    throw new Error(DESKTOP_RUNTIME_MESSAGE);
  }

  if (!databasePromise) {
    databasePromise = Database.load("sqlite:lmb_touch_crm.db")
      .then(async (db) => {
        await initialiseDatabase(db);
        return db;
      })
      .catch((error) => {
        databasePromise = null;
        throw error;
      });
  }

  return databasePromise;
}

async function recordAudit(
  db: Database,
  action: string,
  entityType: string,
  entityId: string | number | null,
  detail: string,
) {
  await db.execute(
    `INSERT INTO audit_entries (action, entity_type, entity_id, detail)
     VALUES ($1, $2, $3, $4)`,
    [action, entityType, entityId?.toString() ?? null, detail],
  );
}

export async function loadShopProfile() {
  const db = await getDb();
  const rows = await db.select<SqlShopProfileRow[]>(
    `SELECT shop_name, address, gstin, phone, receipt_prefix, invoice_prefix, next_receipt_number, next_invoice_number, footer_note
     FROM shop_profile WHERE id = 1`,
  );

  return mapShopProfile(rows[0]);
}

export async function saveShopProfile(profile: ShopProfile) {
  const db = await getDb();
  await db.execute(
    `UPDATE shop_profile
     SET shop_name = $1, address = $2, gstin = $3, phone = $4, receipt_prefix = $5,
         invoice_prefix = $6, footer_note = $7
     WHERE id = 1`,
    [
      profile.shopName.trim(),
      profile.address.trim(),
      profile.gstin.trim(),
      profile.phone.trim(),
      profile.receiptPrefix.trim().toUpperCase(),
      profile.invoicePrefix.trim().toUpperCase(),
      profile.footerNote.trim(),
    ],
  );
  await recordAudit(db, "shop_profile_updated", "shop_profile", 1, "Shop profile saved.");
}

export async function loadAdminSettings() {
  const db = await getDb();
  const rows = await db.select<SqlAdminRow[]>(
    `SELECT admin_name, last_backup_at FROM admin_settings WHERE id = 1`,
  );

  return mapAdminSettings(rows[0]);
}

export async function saveAdminSettings(settings: AdminSettings) {
  const db = await getDb();
  await db.execute(
    `UPDATE admin_settings SET admin_name = $1 WHERE id = 1`,
    [settings.adminName.trim()],
  );
  await recordAudit(db, "admin_settings_updated", "admin_settings", 1, "Admin settings updated.");
}

export async function markBackupCompleted() {
  const db = await getDb();
  await db.execute(`UPDATE admin_settings SET last_backup_at = CURRENT_TIMESTAMP WHERE id = 1`);
  await recordAudit(db, "database_backup_created", "admin_settings", 1, "Database backup created.");
}

export async function listCategories(includeInactive = true) {
  const db = await getDb();
  const filter = includeInactive ? "" : "WHERE is_active = 1";
  const rows = await db.select<SqlCategoryRow[]>(
    `SELECT id, name, display_order, is_active, created_at, updated_at
     FROM categories
     ${filter}
     ORDER BY is_active DESC, display_order ASC, name ASC`,
  );

  return rows.map(mapCategory);
}

export async function saveCategory(input: {
  id?: number | null;
  name: string;
  displayOrder: number;
  isActive: boolean;
}) {
  const db = await getDb();
  const normalizedName = input.name.trim().replace(/\s+/g, " ");

  if (!normalizedName) {
    throw new Error("Category name is required.");
  }

  const duplicateRows = await db.select<{ id: number }[]>(
    `SELECT id FROM categories WHERE lower(trim(name)) = lower(trim($1)) AND ($2 IS NULL OR id != $2) LIMIT 1`,
    [normalizedName, input.id ?? null],
  );
  if (duplicateRows.length > 0) {
    throw new Error(`Category "${normalizedName}" already exists.`);
  }

  if (input.id) {
    await db.execute(
      `UPDATE categories
       SET name = $1, display_order = $2, is_active = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [normalizedName, input.displayOrder, input.isActive ? 1 : 0, input.id],
    );
    await recordAudit(db, "category_updated", "category", input.id, `Category "${normalizedName}" updated.`);
    return input.id;
  }

  const result = await db.execute(
    `INSERT INTO categories (name, display_order, is_active)
     VALUES ($1, $2, $3)`,
    [normalizedName, input.displayOrder, input.isActive ? 1 : 0],
  );

  await recordAudit(
    db,
    "category_created",
    "category",
    result.lastInsertId ?? null,
    `Category "${normalizedName}" created.`,
  );

  return result.lastInsertId ?? null;
}

export async function setCategoryActive(categoryId: number, isActive: boolean) {
  const db = await getDb();
  await db.execute(
    `UPDATE categories SET is_active = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [isActive ? 1 : 0, categoryId],
  );
  await recordAudit(
    db,
    isActive ? "category_enabled" : "category_disabled",
    "category",
    categoryId,
    isActive ? "Category enabled." : "Category disabled.",
  );
}

export async function listItems(includeInactive = true) {
  const db = await getDb();
  const filter = includeInactive ? "" : "WHERE items.is_active = 1 AND categories.is_active = 1";
  const rows = await db.select<SqlItemRow[]>(
    `SELECT
       items.id,
       items.category_id,
       categories.name AS category_name,
       items.name,
       items.unit,
       items.unit_price_paise,
       items.gst_rate,
       items.is_active,
       items.created_at,
       items.updated_at
     FROM items
     JOIN categories ON categories.id = items.category_id
     ${filter}
     ORDER BY items.is_active DESC, categories.display_order ASC, categories.name ASC, items.name ASC`,
  );

  return rows.map(mapItem);
}

export async function saveItem(input: {
  id?: number | null;
  categoryId: number;
  name: string;
  unit: string;
  unitPricePaise: number;
  gstRate: number;
  isActive: boolean;
}) {
  const db = await getDb();
  const normalizedName = input.name.trim().replace(/\s+/g, " ");
  const normalizedUnit = input.unit.trim().replace(/\s+/g, " ");

  if (!normalizedName) {
    throw new Error("Item name is required.");
  }
  if (!normalizedUnit) {
    throw new Error("Item unit is required.");
  }
  if (input.unitPricePaise <= 0) {
    throw new Error("Item rate must be greater than zero.");
  }

  const duplicateRows = await db.select<{ id: number }[]>(
    `SELECT id
     FROM items
     WHERE category_id = $1
       AND lower(trim(name)) = lower(trim($2))
       AND ($3 IS NULL OR id != $3)
     LIMIT 1`,
    [input.categoryId, normalizedName, input.id ?? null],
  );
  if (duplicateRows.length > 0) {
    throw new Error(`Item "${normalizedName}" already exists in this category.`);
  }

  if (input.id) {
    const previousRows = await db.select<
      { unit_price_paise: number; name: string; gst_rate: number }[]
    >(`SELECT unit_price_paise, name, gst_rate FROM items WHERE id = $1`, [input.id]);

    await db.execute(
      `UPDATE items
       SET category_id = $1, name = $2, unit = $3, unit_price_paise = $4, gst_rate = $5,
           is_active = $6, updated_at = CURRENT_TIMESTAMP
       WHERE id = $7`,
      [
        input.categoryId,
        normalizedName,
        normalizedUnit,
        input.unitPricePaise,
        input.gstRate,
        input.isActive ? 1 : 0,
        input.id,
      ],
    );

    const previous = previousRows[0];
    if (previous && previous.unit_price_paise !== input.unitPricePaise) {
      await recordAudit(
        db,
        "item_rate_changed",
        "item",
        input.id,
        `Rate updated for "${normalizedName}" from ${previous.unit_price_paise} paise to ${input.unitPricePaise} paise.`,
      );
    } else {
      await recordAudit(db, "item_updated", "item", input.id, `Item "${normalizedName}" updated.`);
    }

    return input.id;
  }

  const result = await db.execute(
    `INSERT INTO items (category_id, name, unit, unit_price_paise, gst_rate, is_active)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.categoryId,
      normalizedName,
      normalizedUnit,
      input.unitPricePaise,
      input.gstRate,
      input.isActive ? 1 : 0,
    ],
  );
  await recordAudit(
    db,
    "item_created",
    "item",
    result.lastInsertId ?? null,
    `Item "${normalizedName}" created.`,
  );
  return result.lastInsertId ?? null;
}

export async function setItemActive(itemId: number, isActive: boolean) {
  const db = await getDb();
  await db.execute(
    `UPDATE items SET is_active = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [isActive ? 1 : 0, itemId],
  );
  await recordAudit(
    db,
    isActive ? "item_enabled" : "item_disabled",
    "item",
    itemId,
    isActive ? "Item enabled." : "Item disabled.",
  );
}

export async function listPrinterProfiles() {
  const db = await getDb();
  const rows = await db.select<SqlPrinterProfileRow[]>(
    `SELECT id, profile_type, printer_name, updated_at
     FROM printer_profiles
     ORDER BY profile_type ASC`,
  );

  return rows.map(mapPrinterProfile);
}

export async function savePrinterProfile(profileType: PrinterProfileType, printerName: string) {
  const db = await getDb();
  await db.execute(
    `INSERT INTO printer_profiles (profile_type, printer_name, updated_at)
     VALUES ($1, $2, CURRENT_TIMESTAMP)
     ON CONFLICT(profile_type) DO UPDATE SET printer_name = excluded.printer_name, updated_at = CURRENT_TIMESTAMP`,
    [profileType, printerName],
  );
  await recordAudit(
    db,
    "printer_profile_updated",
    "printer_profile",
    profileType,
    `${profileType} printer set to "${printerName}".`,
  );
}

export async function clearPrinterProfile(profileType: PrinterProfileType) {
  const db = await getDb();
  await db.execute(`DELETE FROM printer_profiles WHERE profile_type = $1`, [profileType]);
  await recordAudit(db, "printer_profile_cleared", "printer_profile", profileType, "Printer profile removed.");
}

export async function getDashboardMetrics(): Promise<DashboardMetrics> {
  const db = await getDb();
  const [salesRow] = await db.select<
    { today_sales_count: number; today_gross_paise: number; today_tax_paise: number }[]
  >(
    `SELECT
       COUNT(*) AS today_sales_count,
       COALESCE(SUM(grand_total_paise), 0) AS today_gross_paise,
       COALESCE(SUM(tax_total_paise), 0) AS today_tax_paise
     FROM sales
     WHERE status != 'voided' AND date(sale_timestamp, 'localtime') = date('now', 'localtime')`,
  );

  const [catalogRow] = await db.select<
    { active_items: number; active_categories: number; printer_profiles?: number }[]
  >(
    `SELECT
       (SELECT COUNT(*) FROM items WHERE is_active = 1) AS active_items,
       (SELECT COUNT(*) FROM categories WHERE is_active = 1) AS active_categories
       ${PRINTING_ENABLED ? ", (SELECT COUNT(*) FROM printer_profiles) AS printer_profiles" : ""}`,
  );

  return {
    todaySalesCount: salesRow?.today_sales_count ?? 0,
    todayGrossPaise: salesRow?.today_gross_paise ?? 0,
    todayTaxPaise: salesRow?.today_tax_paise ?? 0,
    activeItems: catalogRow?.active_items ?? 0,
    activeCategories: catalogRow?.active_categories ?? 0,
    pendingPrinterProfiles: PRINTING_ENABLED ? Math.max(0, 2 - (catalogRow?.printer_profiles ?? 0)) : 0,
  };
}

export async function listSales(dateFrom?: string, dateTo?: string) {
  const db = await getDb();
  const params: unknown[] = [];
  const clauses: string[] = [];

  if (dateFrom) {
    params.push(dateFrom);
    clauses.push(`date(sale_timestamp) >= date($${params.length})`);
  }
  if (dateTo) {
    params.push(dateTo);
    clauses.push(`date(sale_timestamp) <= date($${params.length})`);
  }

  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const rows = await db.select<SqlSaleRow[]>(
    `SELECT
       id,
       bill_number,
       document_type,
       sale_timestamp,
       payment_mode,
       subtotal_paise,
       tax_total_paise,
       grand_total_paise,
       status,
       notes,
       reissue_of_sale_id,
       voided_by_sale_id
     FROM sales
     ${whereClause}
     ORDER BY sale_timestamp DESC, id DESC`,
    params,
  );

  return rows.map(mapSaleRow);
}

export async function listRecentSales(limit = 8) {
  const db = await getDb();
  const rows = await db.select<SqlSaleRow[]>(
    `SELECT
       id,
       bill_number,
       document_type,
       sale_timestamp,
       payment_mode,
       subtotal_paise,
       tax_total_paise,
       grand_total_paise,
       status,
       notes,
       reissue_of_sale_id,
       voided_by_sale_id
     FROM sales
     ORDER BY sale_timestamp DESC, id DESC
     LIMIT $1`,
    [limit],
  );

  return rows.map(mapSaleRow);
}

export async function getSaleDetails(saleId: number): Promise<SaleDetails | null> {
  const db = await getDb();
  const [sale] = await db.select<SqlSaleRow[]>(
    `SELECT
       id,
       bill_number,
       document_type,
       sale_timestamp,
       payment_mode,
       subtotal_paise,
       tax_total_paise,
       grand_total_paise,
       status,
       notes,
       reissue_of_sale_id,
       voided_by_sale_id
     FROM sales
     WHERE id = $1`,
    [saleId],
  );

  if (!sale) {
    return null;
  }

  const lines = await db.select<SqlSaleLineRow[]>(
    `SELECT
       id,
       sale_id,
       item_id,
       item_name,
       category_name,
       unit,
       quantity_millis,
       unit_price_paise,
       gst_rate,
       line_subtotal_paise,
       line_tax_paise,
       line_total_paise
     FROM sale_lines
     WHERE sale_id = $1
     ORDER BY id ASC`,
    [saleId],
  );

  return {
    ...mapSaleRow(sale),
    lines: lines.map(mapSaleLine),
  };
}

export async function completeSale(input: SaleDraftInput) {
  const db = await getDb();

  if (input.lines.length === 0) {
    throw new Error("Add at least one item before saving the bill.");
  }

  const subtotalPaise = input.lines.reduce((sum, line) => sum + line.lineSubtotalPaise, 0);
  const taxTotalPaise = input.lines.reduce((sum, line) => sum + line.lineTaxPaise, 0);
  const grandTotalPaise = input.lines.reduce((sum, line) => sum + line.lineTotalPaise, 0);

  /*
   * Do not use BEGIN/COMMIT across multiple plugin-sql invocations: sqlx uses a connection pool,
   * so each execute/select may use a different connection. A leftover open transaction on one
   * connection causes SQLite "database is locked" for other pooled connections.
   * Each statement below runs in its own autocommit transaction (acceptable for single-user POS).
   */
  const [profileRow] = await db.select<SqlShopProfileRow[]>(
    `SELECT shop_name, address, gstin, phone, receipt_prefix, invoice_prefix, next_receipt_number, next_invoice_number, footer_note
     FROM shop_profile WHERE id = 1`,
  );

  const profile = mapShopProfile(profileRow);
  const isReceipt = input.documentType === "receipt";

  let billNumber: string;
  let voidedLedgerBillNumber = "";

  if (input.reissueOfSaleId) {
    const [prior] = await db.select<Pick<SqlSaleRow, "id" | "bill_number" | "document_type" | "status">[]>(
      `SELECT id, bill_number, document_type, status FROM sales WHERE id = $1`,
      [input.reissueOfSaleId],
    );

    if (!prior) {
      throw new Error("The original sale could not be found for reissue.");
    }
    if (prior.status !== "completed") {
      throw new Error("Only completed bills can be reissued.");
    }
    if (prior.document_type !== input.documentType) {
      throw new Error("Document type must match the bill being reissued.");
    }

    billNumber = prior.bill_number;
    voidedLedgerBillNumber = `${prior.bill_number}-VOID-${prior.id}`;
    await db.execute(`UPDATE sales SET bill_number = $1 WHERE id = $2`, [voidedLedgerBillNumber, prior.id]);
  } else {
    billNumber = `${isReceipt ? profile.receiptPrefix : profile.invoicePrefix}-${String(
      isReceipt ? profile.nextReceiptNumber : profile.nextInvoiceNumber,
    ).padStart(5, "0")}`;

    if (isReceipt) {
      await db.execute(`UPDATE shop_profile SET next_receipt_number = next_receipt_number + 1 WHERE id = 1`);
    } else {
      await db.execute(`UPDATE shop_profile SET next_invoice_number = next_invoice_number + 1 WHERE id = 1`);
    }
  }

  const insertSaleResult = await db.execute(
    `INSERT INTO sales (
       bill_number, document_type, sale_timestamp, payment_mode,
       subtotal_paise, tax_total_paise, grand_total_paise, status, notes, reissue_of_sale_id
     ) VALUES ($1, $2, CURRENT_TIMESTAMP, $3, $4, $5, $6, $7, $8, $9)`,
    [
      billNumber,
      input.documentType,
      input.paymentMode,
      subtotalPaise,
      taxTotalPaise,
      grandTotalPaise,
      input.reissueOfSaleId ? "reissued" : "completed",
      input.notes.trim() || null,
      input.reissueOfSaleId ?? null,
    ],
  );

  const saleId = insertSaleResult.lastInsertId;
  if (!saleId) {
    throw new Error("Could not create the sale record.");
  }

  for (const line of input.lines) {
    await db.execute(
      `INSERT INTO sale_lines (
         sale_id, item_id, item_name, category_name, unit, quantity_millis,
         unit_price_paise, gst_rate, line_subtotal_paise, line_tax_paise, line_total_paise
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        saleId,
        line.itemId,
        line.itemName,
        line.categoryName,
        line.unit,
        line.quantityMillis,
        line.unitPricePaise,
        line.gstRate,
        line.lineSubtotalPaise,
        line.lineTaxPaise,
        line.lineTotalPaise,
      ],
    );
  }

  if (input.reissueOfSaleId) {
    await db.execute(
      `UPDATE sales
       SET status = 'voided', voided_by_sale_id = $1
       WHERE id = $2`,
      [saleId, input.reissueOfSaleId],
    );
    await recordAudit(
      db,
      "sale_reissued",
      "sale",
      input.reissueOfSaleId,
      `Sale ${input.reissueOfSaleId} voided (ledger ${voidedLedgerBillNumber}); replacement keeps ${billNumber}.`,
    );
  } else {
    await recordAudit(db, "sale_completed", "sale", saleId, `Sale ${billNumber} completed.`);
  }

  return saleId;
}

export async function listAuditEntries(limit = 25) {
  const db = await getDb();
  const rows = await db.select<SqlAuditRow[]>(
    `SELECT id, action, entity_type, entity_id, detail, created_at
     FROM audit_entries
     ORDER BY created_at DESC, id DESC
     LIMIT $1`,
    [limit],
  );

  return rows.map(mapAuditEntry);
}

export async function getGstSummary(dateFrom: string, dateTo: string): Promise<GstSummaryRow[]> {
  const db = await getDb();
  const rows = await db.select<
    { gst_rate: number; taxable_paise: number; tax_paise: number; gross_paise: number }[]
  >(
    `SELECT
       sale_lines.gst_rate AS gst_rate,
       COALESCE(SUM(sale_lines.line_subtotal_paise), 0) AS taxable_paise,
       COALESCE(SUM(sale_lines.line_tax_paise), 0) AS tax_paise,
       COALESCE(SUM(sale_lines.line_total_paise), 0) AS gross_paise
     FROM sale_lines
     JOIN sales ON sales.id = sale_lines.sale_id
     WHERE sales.status != 'voided'
       AND date(sales.sale_timestamp) BETWEEN date($1) AND date($2)
     GROUP BY sale_lines.gst_rate
     ORDER BY sale_lines.gst_rate ASC`,
    [dateFrom, dateTo],
  );

  return rows.map((row) => ({
    gstRate: row.gst_rate,
    taxablePaise: row.taxable_paise,
    taxPaise: row.tax_paise,
    grossPaise: row.gross_paise,
  }));
}

export async function getPaymentSummary(
  dateFrom: string,
  dateTo: string,
): Promise<PaymentSummaryRow[]> {
  const db = await getDb();
  const rows = await db.select<
    { payment_mode: PaymentSummaryRow["paymentMode"]; sale_count: number; total_paise: number }[]
  >(
    `SELECT
       payment_mode,
       COUNT(*) AS sale_count,
       COALESCE(SUM(grand_total_paise), 0) AS total_paise
     FROM sales
     WHERE status != 'voided'
       AND date(sale_timestamp) BETWEEN date($1) AND date($2)
     GROUP BY payment_mode
     ORDER BY total_paise DESC`,
    [dateFrom, dateTo],
  );

  return rows.map((row) => ({
    paymentMode: row.payment_mode,
    saleCount: row.sale_count,
    totalPaise: row.total_paise,
  }));
}

export async function getItemwiseSummary(
  dateFrom: string,
  dateTo: string,
): Promise<ItemwiseSummaryRow[]> {
  const db = await getDb();
  const rows = await db.select<
    {
      item_name: string;
      category_name: string;
      unit: string;
      quantity_millis: number;
      gross_paise: number;
    }[]
  >(
    `SELECT
       sale_lines.item_name,
       sale_lines.category_name,
       sale_lines.unit,
       COALESCE(SUM(sale_lines.quantity_millis), 0) AS quantity_millis,
       COALESCE(SUM(sale_lines.line_total_paise), 0) AS gross_paise
     FROM sale_lines
     JOIN sales ON sales.id = sale_lines.sale_id
     WHERE sales.status != 'voided'
       AND date(sales.sale_timestamp) BETWEEN date($1) AND date($2)
     GROUP BY sale_lines.item_name, sale_lines.category_name, sale_lines.unit
     ORDER BY gross_paise DESC, sale_lines.item_name ASC`,
    [dateFrom, dateTo],
  );

  return rows.map((row) => ({
    itemName: row.item_name,
    categoryName: row.category_name,
    unit: row.unit,
    quantityMillis: row.quantity_millis,
    grossPaise: row.gross_paise,
  }));
}

export async function loadAppSnapshot(): Promise<AppSnapshot> {
  const [
    shopProfile,
    adminSettings,
    categories,
    items,
    printerProfiles,
    dashboardMetrics,
    recentSales,
    auditTrail,
  ] = await Promise.all([
    loadShopProfile(),
    loadAdminSettings(),
    listCategories(true),
    listItems(true),
    PRINTING_ENABLED ? listPrinterProfiles() : Promise.resolve([]),
    getDashboardMetrics(),
    listRecentSales(8),
    listAuditEntries(12),
  ]);

  return {
    shopProfile,
    adminSettings,
    categories,
    items,
    printerProfiles,
    dashboardMetrics,
    recentSales,
    auditTrail,
  };
}

export function toDraftLinesFromSale(sale: SaleDetails): DraftLine[] {
  return sale.lines.map((line, index) => ({
    draftId: Number(`${sale.id}${index + 1}`),
    itemId: line.itemId ?? 0,
    itemName: line.itemName,
    categoryId: 0,
    categoryName: line.categoryName,
    unit: line.unit,
    quantityMillis: line.quantityMillis,
    unitPricePaise: line.unitPricePaise,
    gstRate: line.gstRate,
    lineSubtotalPaise: line.lineSubtotalPaise,
    lineTaxPaise: line.lineTaxPaise,
    lineTotalPaise: line.lineTotalPaise,
  }));
}
