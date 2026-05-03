import { useDeferredValue, useEffect, useRef, useState, startTransition, type ReactNode } from "react";
import { confirm, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import {
  clearPrinterProfile,
  completeSale,
  markBackupCompleted,
  getDashboardMetrics,
  getGstSummary,
  getPaymentSummary,
  getSaleDetails,
  listSales,
  loadAppSnapshot,
  saveAdminSettings,
  saveCategory,
  saveItem,
  savePrinterProfile,
  saveShopProfile,
  setCategoryActive,
  setItemActive,
  toDraftLinesFromSale,
} from "./lib/db";
import {
  DOCUMENT_TYPE_LABELS,
  GST_OPTIONS,
  PAYMENT_MODE_LABELS,
  PRINTER_PROFILE_LABELS,
  UNIT_OPTIONS,
  formatCurrencyFromPaise,
  formatDateTime,
  fromInputPrice,
  quantityMillisToDisplay,
  quantityMillisToString,
  quantityStringToMillis,
  recalculateDraftLine,
  sumDraftTotals,
  toInputPrice,
  todayIsoDate,
} from "./lib/format";
import { PRINTING_ENABLED } from "./lib/features";
import { buildSalePrintHtml, printHtmlDocument } from "./lib/printing";
import { exportGstSummary, exportPaymentSummary, exportSalesRegister } from "./lib/reports";
import type {
  AdminSettings,
  AppSnapshot,
  AppView,
  Category,
  DashboardMetrics,
  DocumentType,
  DraftLine,
  GstSummaryRow,
  Item,
  PaymentMode,
  PaymentSummaryRow,
  PrinterProfile,
  PrinterProfileType,
  RuntimeInfo,
  SaleDetails,
  SaleRegisterRow,
  ShopProfile,
} from "./types";

type ToastState = {
  kind: "success" | "error" | "info";
  message: string;
} | null;

const HOME_ACTIONS: { view: AppView; label: string; eyebrow: string }[] = [
  { view: "billing", label: "Generate Receipt", eyebrow: "Counter" },
  { view: "admin", label: "Admin", eyebrow: "Catalog" },
  { view: "reports", label: "Reporting", eyebrow: "Tax & Closing" },
  {
    view: "settings",
    label: PRINTING_ENABLED ? "Printers & Data" : "Data",
    eyebrow: "Setup",
  },
];

const NAV_LABELS: Record<AppView, string> = {
  home: "Home",
  billing: "Generate Receipt",
  admin: "Admin",
  reports: "Reports",
  settings: "Settings",
};

const INITIAL_SHOP_PROFILE: ShopProfile = {
  shopName: "Laxmi Misthan Bhandhar",
  address: "",
  gstin: "",
  phone: "",
  receiptPrefix: "RC",
  invoicePrefix: "GST",
  nextReceiptNumber: 1,
  nextInvoiceNumber: 1,
  footerNote: "Thank you for visiting.",
};

const INITIAL_ADMIN_SETTINGS: AdminSettings = {
  adminName: "Admin",
  lastBackupAt: null,
};

const INITIAL_METRICS: DashboardMetrics = {
  todaySalesCount: 0,
  todayGrossPaise: 0,
  todayTaxPaise: 0,
  activeItems: 0,
  activeCategories: 0,
  pendingPrinterProfiles: PRINTING_ENABLED ? 2 : 0,
};

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  return fallback;
}

function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function isUniqueConstraintError(error: unknown) {
  const message = getErrorMessage(error, "").toLowerCase();
  return message.includes("unique") || message.includes("constraint");
}

function isDesktopRuntimeAvailable() {
  const runtime = globalThis as typeof globalThis & {
    __TAURI_INTERNALS__?: unknown;
  };

  return typeof runtime.__TAURI_INTERNALS__ !== "undefined";
}

function App() {
  const [activeView, setActiveView] = useState<AppView>("home");
  const [loading, setLoading] = useState(true);
  const [workingLabel, setWorkingLabel] = useState("Loading shop data…");
  const [toast, setToast] = useState<ToastState>(null);

  const [shopProfile, setShopProfile] = useState<ShopProfile>(INITIAL_SHOP_PROFILE);
  const [shopProfileForm, setShopProfileForm] = useState<ShopProfile>(INITIAL_SHOP_PROFILE);
  const [adminSettingsState, setAdminSettingsState] = useState<AdminSettings>(INITIAL_ADMIN_SETTINGS);
  const [adminForm, setAdminForm] = useState(INITIAL_ADMIN_SETTINGS);
  const [dashboardMetrics, setDashboardMetrics] = useState<DashboardMetrics>(INITIAL_METRICS);
  const [categories, setCategories] = useState<Category[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [printerProfiles, setPrinterProfiles] = useState<PrinterProfile[]>([]);
  const [printerOptions, setPrinterOptions] = useState<string[]>([]);
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null);

  const [categoryForm, setCategoryForm] = useState({
    id: null as number | null,
    name: "",
    displayOrder: 10,
    isActive: true,
  });
  const [itemForm, setItemForm] = useState({
    id: null as number | null,
    categoryId: "",
    name: "",
    unit: "piece",
    customUnit: "",
    unitPrice: "0.00",
    gstRate: "5",
    isActive: true,
  });
  const [printerDrafts, setPrinterDrafts] = useState<Record<PrinterProfileType, string>>({
    receipt: "",
    gst_invoice: "",
  });

  const [billingDocumentType, setBillingDocumentType] = useState<DocumentType>("receipt");
  const [paymentMode, setPaymentMode] = useState<PaymentMode>("cash");
  const [billNotes, setBillNotes] = useState("");
  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState<number | "all">("all");
  const [itemSearch, setItemSearch] = useState("");
  const [draftLines, setDraftLines] = useState<DraftLine[]>([]);
  const [selectedDraftLineId, setSelectedDraftLineId] = useState<number | null>(null);
  const [quantityEntry, setQuantityEntry] = useState("1");
  const [reissueSource, setReissueSource] = useState<SaleDetails | null>(null);

  const [reportDateFrom, setReportDateFrom] = useState(todayIsoDate());
  const [reportDateTo, setReportDateTo] = useState(todayIsoDate());
  const [reportSales, setReportSales] = useState<SaleRegisterRow[]>([]);
  const [gstSummary, setGstSummary] = useState<GstSummaryRow[]>([]);
  const [paymentSummary, setPaymentSummary] = useState<PaymentSummaryRow[]>([]);
  const [reportSearch, setReportSearch] = useState("");
  const [salePreview, setSalePreview] = useState<SaleDetails | null>(null);

  const deferredItemSearch = useDeferredValue(itemSearch.trim().toLowerCase());
  const deferredReportSearch = useDeferredValue(reportSearch.trim().toLowerCase());

  const bootstrappedRef = useRef(false);
  const prevViewRef = useRef<AppView | null>(null);

  useEffect(() => {
    const prev = prevViewRef.current;
    if (activeView === "admin" && prev !== "admin") {
      setShopProfileForm(shopProfile);
      setAdminForm(adminSettingsState);
    }
    if (activeView === "settings" && prev !== "settings") {
      setPrinterDrafts({
        receipt: printerProfiles.find((profile) => profile.profileType === "receipt")?.printerName ?? "",
        gst_invoice:
          printerProfiles.find((profile) => profile.profileType === "gst_invoice")?.printerName ?? "",
      });
    }
    prevViewRef.current = activeView;
  }, [activeView, shopProfile, adminSettingsState, printerProfiles]);

  useEffect(() => {
    if (bootstrappedRef.current) {
      return;
    }

    bootstrappedRef.current = true;
    void bootstrapApp();
  }, []);

  useEffect(() => {
    if (!toast) {
      return undefined;
    }

    const timeout = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    const firstActiveCategory = categories.find((category) => category.isActive);

    if (firstActiveCategory) {
      const currentCategoryStillValid = categories.some(
        (category) => category.id === Number(itemForm.categoryId) && category.isActive,
      );

      if (!currentCategoryStillValid) {
        setItemForm((current) => ({ ...current, categoryId: `${firstActiveCategory.id}` }));
      }
    } else if (itemForm.categoryId !== "") {
      setItemForm((current) => ({ ...current, categoryId: "" }));
    }

    if (categoryForm.id === null && categoryForm.name === "" && categoryForm.displayOrder === 10 && categories.length > 0) {
      setCategoryForm((current) => ({
        ...current,
        displayOrder: Math.max(10, categories.length * 10 + 10),
      }));
    }
  }, [
    categories,
    categoryForm.displayOrder,
    categoryForm.id,
    categoryForm.name,
    itemForm.categoryId,
  ]);

  useEffect(() => {
    if (
      selectedCategoryFilter !== "all" &&
      !categories.some((category) => category.id === selectedCategoryFilter && category.isActive)
    ) {
      setSelectedCategoryFilter("all");
    }
  }, [categories, selectedCategoryFilter]);

  const activeCategories = categories.filter((category) => category.isActive);
  const visibleItems = items.filter((item) => {
    if (!item.isActive) {
      return false;
    }

    const matchesCategory =
      selectedCategoryFilter === "all" ? true : item.categoryId === selectedCategoryFilter;

    const searchMatch =
      deferredItemSearch.length === 0
        ? true
        : `${item.name} ${item.categoryName} ${item.unit}`.toLowerCase().includes(deferredItemSearch);

    return matchesCategory && searchMatch;
  });

  const filteredReportSales = reportSales.filter((sale) => {
    if (!deferredReportSearch) {
      return true;
    }

    return `${sale.billNumber} ${sale.paymentMode} ${sale.status}`
      .toLowerCase()
      .includes(deferredReportSearch);
  });

  const selectedDraftLine = draftLines.find((line) => line.draftId === selectedDraftLineId) ?? null;
  const billingTotals = sumDraftTotals(draftLines);

  async function bootstrapApp() {
    setLoading(true);
    setWorkingLabel("Loading shop data…");

    if (!isDesktopRuntimeAvailable()) {
      setToast({
        kind: "info",
        message:
          "Desktop runtime not detected. Use `npm run tauri dev` or the packaged desktop app for local database and backup features.",
      });
      setLoading(false);
      return;
    }

    try {
      const snapshot = await loadAppSnapshot();
      const [printers, runtime] = await Promise.all([
        PRINTING_ENABLED ? safeLoadPrinters() : Promise.resolve([]),
        invoke<RuntimeInfo>("get_runtime_info"),
      ]);

      await loadReports(snapshot.shopProfile);

      startTransition(() => {
        applySnapshot(snapshot);
        setPrinterOptions(printers);
        setRuntimeInfo(runtime);
      });
    } catch (error) {
      console.error(error);
      setToast({
        kind: "error",
        message: error instanceof Error ? error.message : "The app could not be started.",
      });
    } finally {
      setLoading(false);
    }
  }

  function applySnapshot(snapshot: AppSnapshot) {
    setShopProfile(snapshot.shopProfile);
    setShopProfileForm(snapshot.shopProfile);
    setAdminSettingsState(snapshot.adminSettings);
    setAdminForm(snapshot.adminSettings);
    setDashboardMetrics(snapshot.dashboardMetrics);
    setCategories(snapshot.categories);
    setItems(snapshot.items);
    setPrinterProfiles(snapshot.printerProfiles);
    setPrinterDrafts({
      receipt:
        snapshot.printerProfiles.find((profile) => profile.profileType === "receipt")?.printerName ?? "",
      gst_invoice:
        snapshot.printerProfiles.find((profile) => profile.profileType === "gst_invoice")?.printerName ??
        "",
    });
  }

  async function refreshSnapshot(label = "Refreshing local data…") {
    setWorkingLabel(label);
    setLoading(true);

    try {
      const snapshot = await loadAppSnapshot();
      startTransition(() => applySnapshot(snapshot));
    } finally {
      setLoading(false);
    }
  }

  async function loadReports(profileOverride?: ShopProfile) {
    const [sales, gstRows, paymentRows] = await Promise.all([
      listSales(reportDateFrom, reportDateTo),
      getGstSummary(reportDateFrom, reportDateTo),
      getPaymentSummary(reportDateFrom, reportDateTo),
    ]);

    startTransition(() => {
      setReportSales(sales);
      setGstSummary(gstRows);
      setPaymentSummary(paymentRows);

      if (profileOverride) {
        setShopProfile(profileOverride);
      }
    });
  }

  async function safeLoadPrinters() {
    if (!PRINTING_ENABLED) {
      return [];
    }

    try {
      return await invoke<string[]>("list_printers");
    } catch (error) {
      console.warn("Printer discovery unavailable", error);
      return [];
    }
  }

  function resetCategoryForm() {
    setCategoryForm({
      id: null,
      name: "",
      displayOrder: Math.max(10, categories.length * 10 + 10),
      isActive: true,
    });
  }

  function resetItemForm() {
    setItemForm({
      id: null,
      categoryId: activeCategories[0] ? `${activeCategories[0].id}` : "",
      name: "",
      unit: "piece",
      customUnit: "",
      unitPrice: "0.00",
      gstRate: "5",
      isActive: true,
    });
  }

  async function handleSaveShopProfile() {
    if (!shopProfileForm.shopName.trim()) {
      setToast({ kind: "error", message: "Shop name is required." });
      return;
    }
    if (!shopProfileForm.receiptPrefix.trim()) {
      setToast({ kind: "error", message: "Receipt prefix is required." });
      return;
    }
    if (!shopProfileForm.invoicePrefix.trim()) {
      setToast({ kind: "error", message: "Invoice prefix is required." });
      return;
    }

    try {
      await saveShopProfile(shopProfileForm);
      setToast({ kind: "success", message: "Shop profile saved locally." });
      await refreshSnapshot("Saving shop profile…");
    } catch (error) {
      setToast({
        kind: "error",
        message: getErrorMessage(error, "Shop profile could not be saved."),
      });
    }
  }

  async function handleSaveAdminSettings() {
    if (!adminForm.adminName.trim()) {
      setToast({ kind: "error", message: "Admin name is required." });
      return;
    }

    try {
      await saveAdminSettings(adminForm);
      setToast({ kind: "success", message: "Admin settings updated." });
      await refreshSnapshot("Saving admin settings…");
    } catch (error) {
      setToast({
        kind: "error",
        message: getErrorMessage(error, "Admin settings could not be updated."),
      });
    }
  }

  async function handleSaveCategory() {
    const categoryName = normalizeName(categoryForm.name);

    if (!categoryName) {
      setToast({ kind: "error", message: "Category name is required." });
      return;
    }

    const duplicateCategory = categories.find(
      (category) =>
        category.id !== categoryForm.id &&
        category.name.trim().toLowerCase() === categoryName.toLowerCase(),
    );
    if (duplicateCategory) {
      setToast({ kind: "error", message: `Category "${categoryName}" already exists.` });
      return;
    }

    try {
      await saveCategory({
        ...categoryForm,
        name: categoryName,
      });
      setToast({ kind: "success", message: "Category saved." });
      resetCategoryForm();
      await refreshSnapshot("Saving category…");
    } catch (error) {
      setToast({
        kind: "error",
        message: isUniqueConstraintError(error)
          ? `Category "${categoryName}" already exists.`
          : getErrorMessage(error, "Category could not be saved."),
      });
    }
  }

  async function handleToggleCategory(category: Category) {
    const approved = await confirm(
      `${category.isActive ? "Disable" : "Enable"} ${category.name}?`,
      "Category status",
    );
    if (!approved) {
      return;
    }

    try {
      await setCategoryActive(category.id, !category.isActive);
      setToast({
        kind: "success",
        message: category.isActive ? "Category disabled." : "Category enabled.",
      });
      await refreshSnapshot("Updating category status…");
    } catch (error) {
      setToast({
        kind: "error",
        message: getErrorMessage(error, "Category status could not be updated."),
      });
    }
  }

  async function handleSaveItem() {
    const categoryId = Number(itemForm.categoryId);
    const unit = itemForm.unit === "custom" ? itemForm.customUnit.trim() : itemForm.unit;
    const itemName = normalizeName(itemForm.name);

    if (!categoryId) {
      setToast({ kind: "error", message: "Select a category before saving an item." });
      return;
    }
    if (!itemName) {
      setToast({ kind: "error", message: "Item name is required." });
      return;
    }
    if (!unit) {
      setToast({ kind: "error", message: "Choose a unit or enter a custom unit." });
      return;
    }
    if (fromInputPrice(itemForm.unitPrice) <= 0) {
      setToast({ kind: "error", message: "Enter a valid rate greater than zero." });
      return;
    }

    const duplicateItem = items.find(
      (item) =>
        item.id !== itemForm.id &&
        item.categoryId === categoryId &&
        item.name.trim().toLowerCase() === itemName.toLowerCase(),
    );
    if (duplicateItem) {
      setToast({ kind: "error", message: `Item "${itemName}" already exists in this category.` });
      return;
    }

    try {
      await saveItem({
        id: itemForm.id,
        categoryId,
        name: itemName,
        unit,
        unitPricePaise: fromInputPrice(itemForm.unitPrice),
        gstRate: Number(itemForm.gstRate),
        isActive: itemForm.isActive,
      });
      setToast({ kind: "success", message: "Item saved." });
      resetItemForm();
      await refreshSnapshot("Saving item…");
    } catch (error) {
      setToast({
        kind: "error",
        message: isUniqueConstraintError(error)
          ? `Item "${itemName}" already exists in this category.`
          : getErrorMessage(error, "Item could not be saved."),
      });
    }
  }

  async function handleToggleItem(item: Item) {
    const approved = await confirm(
      `${item.isActive ? "Disable" : "Enable"} ${item.name}?`,
      "Item status",
    );
    if (!approved) {
      return;
    }

    try {
      await setItemActive(item.id, !item.isActive);
      setToast({
        kind: "success",
        message: item.isActive ? "Item disabled." : "Item enabled.",
      });
      await refreshSnapshot("Updating item status…");
    } catch (error) {
      setToast({
        kind: "error",
        message: getErrorMessage(error, "Item status could not be updated."),
      });
    }
  }

  async function handleSavePrinterProfile(profileType: PrinterProfileType) {
    if (!PRINTING_ENABLED) {
      return;
    }

    const printerName = printerDrafts[profileType].trim();
    if (!printerName) {
      setToast({ kind: "error", message: "Choose a printer first." });
      return;
    }

    try {
      await savePrinterProfile(profileType, printerName);
      setToast({ kind: "success", message: `${PRINTER_PROFILE_LABELS[profileType]} saved.` });
      await refreshSnapshot("Saving printer profile…");
    } catch (error) {
      setToast({
        kind: "error",
        message: getErrorMessage(error, "Printer profile could not be saved."),
      });
    }
  }

  async function handleClearPrinterProfile(profileType: PrinterProfileType) {
    if (!PRINTING_ENABLED) {
      return;
    }

    const approved = await confirm(
      `Remove the ${PRINTER_PROFILE_LABELS[profileType].toLowerCase()} mapping?`,
      "Remove printer",
    );
    if (!approved) {
      return;
    }

    try {
      await clearPrinterProfile(profileType);
      setToast({ kind: "success", message: `${PRINTER_PROFILE_LABELS[profileType]} removed.` });
      await refreshSnapshot("Removing printer profile…");
    } catch (error) {
      setToast({
        kind: "error",
        message: getErrorMessage(error, "Printer profile could not be removed."),
      });
    }
  }

  async function handleTestPrinter(profileType: PrinterProfileType) {
    if (!PRINTING_ENABLED) {
      return;
    }

    const printerName = printerDrafts[profileType].trim();
    if (!printerName) {
      setToast({ kind: "error", message: "Choose a printer first." });
      return;
    }

    try {
      const result = await invoke<string>("test_printer", {
        printerName,
        profileType,
      });
      setToast({ kind: "success", message: result });
    } catch (error) {
      setToast({
        kind: "error",
        message: getErrorMessage(error, "Printer test failed."),
      });
    }
  }

  function handleQuantityKeypad(key: string) {
    if (key === "clear") {
      setQuantityEntry("");
      return;
    }

    if (key === "backspace") {
      setQuantityEntry((current) => current.slice(0, -1));
      return;
    }

    setQuantityEntry((current) => {
      if (key === "." && current.includes(".")) {
        return current;
      }
      return `${current}${key}`;
    });
  }

  function handleQuantityShortcut(value: string) {
    setQuantityEntry(value);
  }

  function handleAddItemToDraft(item: Item) {
    const quantityMillis = quantityStringToMillis(quantityEntry || "1") || 1000;
    const existingLine = draftLines.find(
      (line) =>
        line.itemId === item.id &&
        line.unitPricePaise === item.unitPricePaise &&
        line.gstRate === item.gstRate,
    );

    if (existingLine) {
      setDraftLines((current) =>
        current.map((line) =>
          line.draftId === existingLine.draftId
            ? recalculateDraftLine(line, line.quantityMillis + quantityMillis)
            : line,
        ),
      );
      setSelectedDraftLineId(existingLine.draftId);
    } else {
      const draftId = Date.now() + item.id;
      const newLine = recalculateDraftLine(
        {
          draftId,
          itemId: item.id,
          itemName: item.name,
          categoryId: item.categoryId,
          categoryName: item.categoryName,
          unit: item.unit,
          quantityMillis: 0,
          unitPricePaise: item.unitPricePaise,
          gstRate: item.gstRate,
          lineSubtotalPaise: 0,
          lineTaxPaise: 0,
          lineTotalPaise: 0,
        },
        quantityMillis,
      );
      setDraftLines((current) => [...current, newLine]);
      setSelectedDraftLineId(draftId);
    }

    setQuantityEntry("1");
  }

  function handleApplyQuantityToSelectedLine() {
    if (!selectedDraftLine) {
      setToast({ kind: "info", message: "Select a bill line before applying quantity." });
      return;
    }

    const quantityMillis = quantityStringToMillis(quantityEntry);
    if (quantityMillis <= 0) {
      setToast({ kind: "error", message: "Enter a valid quantity first." });
      return;
    }

    setDraftLines((current) =>
      current.map((line) =>
        line.draftId === selectedDraftLine.draftId
          ? recalculateDraftLine(line, quantityMillis)
          : line,
      ),
    );
  }

  async function handleDeleteSelectedLine() {
    if (!selectedDraftLine) {
      return;
    }

    const approved = await confirm(`Delete ${selectedDraftLine.itemName} from the draft bill?`, "Delete line");
    if (!approved) {
      return;
    }

    setDraftLines((current) => current.filter((line) => line.draftId !== selectedDraftLine.draftId));
    setSelectedDraftLineId(null);
    setQuantityEntry("1");
  }

  async function handleClearDraft() {
    if (draftLines.length === 0) {
      return;
    }

    const approved = await confirm("Clear the current draft bill?", "Clear bill");
    if (!approved) {
      return;
    }

    setDraftLines([]);
    setSelectedDraftLineId(null);
    setQuantityEntry("1");
    setBillNotes("");
    setReissueSource(null);
  }

  async function handleSaveSale(shouldPrint: boolean) {
    if (draftLines.length === 0) {
      setToast({ kind: "error", message: "Add items before saving a bill." });
      return;
    }

    setLoading(true);
    setWorkingLabel("Saving sale locally…");

    try {
      const saleId = await completeSale({
        documentType: billingDocumentType,
        paymentMode,
        notes: billNotes,
        lines: draftLines,
        reissueOfSaleId: reissueSource?.id ?? null,
      });
      const sale = await getSaleDetails(saleId);
      const snapshot = await loadAppSnapshot();
      await loadReports(snapshot.shopProfile);

      if (!sale) {
        throw new Error("The bill was saved, but the receipt details could not be reloaded.");
      }

      startTransition(() => {
        applySnapshot(snapshot);
        setDraftLines([]);
        setSelectedDraftLineId(null);
        setQuantityEntry("1");
        setBillNotes("");
        setReissueSource(null);
        setSalePreview(sale);
        setActiveView("reports");
      });

      let printWarning = "";
      if (PRINTING_ENABLED && shouldPrint) {
        try {
          const html = buildSalePrintHtml(shopProfile, sale, billingDocumentType, printerProfiles);
          printHtmlDocument(sale.billNumber, html);
        } catch (printError) {
          printWarning = ` Bill saved, but printing failed: ${getErrorMessage(printError, "print preview could not open.")}`;
        }
      }

      setToast({
        kind: printWarning ? "info" : "success",
        message: `${DOCUMENT_TYPE_LABELS[billingDocumentType]} ${sale.billNumber} saved successfully.${printWarning}`,
      });
    } catch (error) {
      console.error(error);
      setToast({
        kind: "error",
        message: getErrorMessage(error, "The bill could not be saved."),
      });
    } finally {
      setLoading(false);
    }
  }

  async function handlePreviewSaleDocument(
    sale: SaleRegisterRow,
    requestedDocument: DocumentType = sale.documentType,
  ) {
    if (!PRINTING_ENABLED) {
      return;
    }

    try {
      const details = await getSaleDetails(sale.id);
      if (!details) {
        setToast({ kind: "error", message: "Sale details could not be loaded." });
        return;
      }

      const html = buildSalePrintHtml(shopProfile, details, requestedDocument, printerProfiles);
      printHtmlDocument(details.billNumber, html);
    } catch (error) {
      setToast({
        kind: "error",
        message: getErrorMessage(error, "The document preview could not be opened."),
      });
    }
  }

  async function handleStartReissue(sale: SaleRegisterRow) {
    try {
      const details = await getSaleDetails(sale.id);
      if (!details) {
        setToast({ kind: "error", message: "Sale details could not be loaded." });
        return;
      }

      setDraftLines(toDraftLinesFromSale(details));
      setSelectedDraftLineId(null);
      setQuantityEntry("1");
      setPaymentMode(details.paymentMode);
      setBillingDocumentType(details.documentType);
      setBillNotes(details.notes ?? "");
      setReissueSource(details);
      setActiveView("billing");
      setToast({
        kind: "info",
        message: `Reissue mode started for ${details.billNumber}. Save the corrected bill to void the old entry.`,
      });
    } catch (error) {
      setToast({
        kind: "error",
        message: getErrorMessage(error, "The bill could not be loaded for reissue."),
      });
    }
  }

  async function handleRefreshReports() {
    if (reportDateFrom > reportDateTo) {
      setToast({ kind: "error", message: "The report start date must be before the end date." });
      return;
    }

    setLoading(true);
    setWorkingLabel("Refreshing reports…");
    try {
      await loadReports();
    } catch (error) {
      setToast({
        kind: "error",
        message: getErrorMessage(error, "Reports could not be refreshed."),
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleExportSales() {
    if (reportDateFrom > reportDateTo) {
      setToast({ kind: "error", message: "The report start date must be before the end date." });
      return;
    }

    try {
      const exported = await exportSalesRegister(shopProfile, filteredReportSales, reportDateFrom, reportDateTo);
      if (exported) {
        setToast({ kind: "success", message: "Sale register exported." });
      }
    } catch (error) {
      setToast({
        kind: "error",
        message: getErrorMessage(error, "Sale register export failed."),
      });
    }
  }

  async function handleExportGst() {
    if (reportDateFrom > reportDateTo) {
      setToast({ kind: "error", message: "The report start date must be before the end date." });
      return;
    }

    try {
      const exported = await exportGstSummary(shopProfile, gstSummary, reportDateFrom, reportDateTo);
      if (exported) {
        setToast({ kind: "success", message: "GST summary exported." });
      }
    } catch (error) {
      setToast({
        kind: "error",
        message: getErrorMessage(error, "GST summary export failed."),
      });
    }
  }

  async function handleExportPayments() {
    if (reportDateFrom > reportDateTo) {
      setToast({ kind: "error", message: "The report start date must be before the end date." });
      return;
    }

    try {
      const exported = await exportPaymentSummary(shopProfile, paymentSummary, reportDateFrom, reportDateTo);
      if (exported) {
        setToast({ kind: "success", message: "Payment summary exported." });
      }
    } catch (error) {
      setToast({
        kind: "error",
        message: getErrorMessage(error, "Payment summary export failed."),
      });
    }
  }

  async function handleBackupDatabase() {
    const targetPath = await save({
      title: "Save database backup",
      defaultPath: `lmb_touch_crm_backup_${todayIsoDate()}.db`,
      filters: [{ name: "SQLite Database", extensions: ["db"] }],
    });

    if (!targetPath) {
      return;
    }

    setLoading(true);
    setWorkingLabel("Creating database backup…");
    try {
      const result = await invoke<string>("backup_database", { destinationPath: targetPath });
      await markBackupCompleted();
      setToast({ kind: "success", message: result });
      await refreshSnapshot("Refreshing backup status…");
    } catch (error) {
      setToast({
        kind: "error",
        message: getErrorMessage(error, "Backup failed."),
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleRefreshRuntime() {
    try {
      const [runtime, printers, metrics] = await Promise.all([
        invoke<RuntimeInfo>("get_runtime_info"),
        PRINTING_ENABLED ? safeLoadPrinters() : Promise.resolve([]),
        getDashboardMetrics(),
      ]);

      startTransition(() => {
        setRuntimeInfo(runtime);
        setPrinterOptions(printers);
        setDashboardMetrics(metrics);
      });
    } catch (error) {
      setToast({
        kind: "error",
        message: getErrorMessage(error, "Runtime details could not be refreshed."),
      });
    }
  }

  const renderView = () => {
    switch (activeView) {
      case "billing":
        return renderBillingView();
      case "admin":
        return renderAdminView();
      case "reports":
        return renderReportsView();
      case "settings":
        return renderSettingsView();
      case "home":
      default:
        return renderHomeView();
    }
  };

  function renderHomeView() {
    return (
      <section className="home-view">
        <section className="poster-banner">
          <div>
            <span className="eyebrow">Touch Counter</span>
            <h1>{shopProfile.shopName}</h1>
          </div>
          <div className="poster-side">
            <span className="poster-stat">{dashboardMetrics.todaySalesCount}</span>
            <span>sales today</span>
            <strong>{formatCurrencyFromPaise(dashboardMetrics.todayGrossPaise)}</strong>
          </div>
        </section>

        <section className="action-grid">
          {HOME_ACTIONS.map((action) => (
            <button
              key={action.view}
              className="action-panel"
              type="button"
              onClick={() => setActiveView(action.view)}
            >
              <span className="eyebrow">{action.eyebrow}</span>
              <strong>{action.label}</strong>
            </button>
          ))}
        </section>
      </section>
    );
  }

  function renderBillingView() {
    return (
      <section className="billing-shell">
        <div className="billing-main-row">
          <aside className="sidebar-panel">
            <PanelHeader title="Categories" subtitle="Tap a category to narrow the menu." />
            <div className="category-list">
              <button
                type="button"
                className={`category-chip ${selectedCategoryFilter === "all" ? "selected" : ""}`}
                onClick={() => setSelectedCategoryFilter("all")}
              >
                All Items
              </button>
              {activeCategories.map((category) => (
                <button
                  type="button"
                  key={category.id}
                  className={`category-chip ${selectedCategoryFilter === category.id ? "selected" : ""}`}
                  onClick={() => setSelectedCategoryFilter(category.id)}
                >
                  {category.name}
                </button>
              ))}
            </div>

            <section className="mini-panel">
              <label className="field-label" htmlFor="item-search">
                Search item
              </label>
              <input
                id="item-search"
                className="touch-input"
                value={itemSearch}
                onChange={(event) => setItemSearch(event.currentTarget.value)}
                placeholder="e.g. Kaju Katli"
              />
            </section>

            <section className="mini-panel">
              <PanelHeader title="Billing Mode" subtitle="Choose how this bill should be saved." />
              <div className="segmented">
                {(["receipt", "gst_invoice"] as DocumentType[]).map((documentType) => (
                  <button
                    key={documentType}
                    type="button"
                    className={billingDocumentType === documentType ? "selected" : ""}
                    onClick={() => setBillingDocumentType(documentType)}
                  >
                    {DOCUMENT_TYPE_LABELS[documentType]}
                  </button>
                ))}
              </div>
              {reissueSource ? (
                <p className="helper-banner">
                  Reissuing <strong>{reissueSource.billNumber}</strong>. Saving voids the old bill.
                </p>
              ) : null}
            </section>
          </aside>

          <section className="workspace-panel">
            <PanelHeader
              title="Menu Items"
              subtitle="Tap to add — quantity bar is below."
              action={
                <button type="button" className="ghost-button" onClick={() => setActiveView("admin")}>
                  Manage menu
                </button>
              }
            />
            <div className="item-grid">
              {visibleItems.length === 0 ? (
                <div className="empty-state large">
                  {items.length === 0
                    ? "No items yet. Add categories and items from Admin."
                    : "No items match the current category or search."}
                </div>
              ) : (
                visibleItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="item-tile"
                    onClick={() => handleAddItemToDraft(item)}
                  >
                    <span className="eyebrow">{item.categoryName}</span>
                    <strong>{item.name}</strong>
                    <p>{item.unit} • {item.gstRate}% GST</p>
                    <span className="item-price">{formatCurrencyFromPaise(item.unitPricePaise)}</span>
                  </button>
                ))
              )}
            </div>
          </section>

          <aside className="bill-panel">
          <PanelHeader
            title="Current Bill"
            subtitle={`${draftLines.length} line${draftLines.length === 1 ? "" : "s"} · ${DOCUMENT_TYPE_LABELS[billingDocumentType]}`}
            action={
              <button type="button" className="ghost-button danger" onClick={() => void handleClearDraft()}>
                Clear all
              </button>
            }
          />

          <div className="draft-lines">
            {draftLines.length === 0 ? (
              <div className="empty-state draft-empty-hint">
                Tap menu items to add lines. Tap a line to select it — change qty on the bar below.
              </div>
            ) : (
              draftLines.map((line) => (
                <button
                  key={line.draftId}
                  type="button"
                  className={`draft-line ${selectedDraftLineId === line.draftId ? "selected" : ""}`}
                  onClick={() => {
                    setSelectedDraftLineId(line.draftId);
                    setQuantityEntry(quantityMillisToString(line.quantityMillis));
                  }}
                >
                  <div className="draft-line-main">
                    <strong>{line.itemName}</strong>
                    <span className="draft-line-meta">
                      {quantityMillisToDisplay(line.quantityMillis, line.unit)} · {line.gstRate}% GST
                    </span>
                  </div>
                  <span className="draft-line-total">{formatCurrencyFromPaise(line.lineTotalPaise)}</span>
                </button>
              ))
            )}
          </div>

          <section className="bill-payment-block">
            <span className="field-label">Payment</span>
            <div className="segmented bill-payment-segmented">
              {(["cash", "upi", "cheque"] as PaymentMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={paymentMode === mode ? "selected" : ""}
                  onClick={() => setPaymentMode(mode)}
                >
                  {PAYMENT_MODE_LABELS[mode]}
                </button>
              ))}
            </div>
            <label className="field-label bill-notes-label" htmlFor="bill-notes">
              Note (optional)
            </label>
            <textarea
              id="bill-notes"
              className="touch-textarea bill-notes"
              value={billNotes}
              onChange={(event) => setBillNotes(event.currentTarget.value)}
              placeholder="Short note"
              rows={2}
            />
          </section>

          <section className="totals-panel bill-totals">
            <div><span>Taxable</span><strong>{formatCurrencyFromPaise(billingTotals.subtotalPaise)}</strong></div>
            <div><span>GST</span><strong>{formatCurrencyFromPaise(billingTotals.taxPaise)}</strong></div>
            <div><span>Grand Total</span><strong>{formatCurrencyFromPaise(billingTotals.grandTotalPaise)}</strong></div>
          </section>

          <div className="checkout-actions">
            <button type="button" className="primary-button checkout-save" onClick={() => void handleSaveSale(false)}>
              Save Bill
            </button>
            {PRINTING_ENABLED ? (
              <button type="button" className="secondary-button checkout-save" onClick={() => void handleSaveSale(true)}>
                Save & Print
              </button>
            ) : null}
          </div>
        </aside>
        </div>

        <div className="billing-quantity-dock" role="region" aria-label="Quantity entry">
          <div className="quantity-dock-left">
            <span className="field-label">Quantity</span>
            <div className="quantity-display quantity-display-dock" aria-live="polite">
              {quantityEntry || "0"}
            </div>
            <div className="shortcut-row shortcut-row-dock">
              {["1", "2", "3"].map((value) => (
                <button key={value} type="button" className="shortcut-button touch-chip" onClick={() => handleQuantityShortcut(value)}>
                  {value}×
                </button>
              ))}
              <button type="button" className="shortcut-button touch-chip" onClick={() => handleQuantityShortcut("0.250")}>
                250g
              </button>
              <button type="button" className="shortcut-button touch-chip" onClick={() => handleQuantityShortcut("0.500")}>
                500g
              </button>
            </div>
            <p className="quantity-dock-hint">
              {selectedDraftLine ? (
                <>
                  Editing <strong>{selectedDraftLine.itemName}</strong> — tap Apply quantity
                </>
              ) : (
                <>Select a line on the right to edit qty, or set qty before tapping items.</>
              )}
            </p>
          </div>

          <div className="quantity-dock-keypad">
            <div className="keypad-grid keypad-grid-dock">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0"].map((key) => (
                <button key={key} type="button" className="keypad-button touch-key" onClick={() => handleQuantityKeypad(key)}>
                  {key}
                </button>
              ))}
              <button type="button" className="keypad-button touch-key wide" onClick={() => handleQuantityKeypad("backspace")}>
                ⌫
              </button>
              <button type="button" className="keypad-button touch-key wide subtle" onClick={() => handleQuantityKeypad("clear")}>
                Clear
              </button>
            </div>
          </div>

          <div className="quantity-dock-actions">
            <button type="button" className="primary-button dock-apply-btn" onClick={handleApplyQuantityToSelectedLine}>
              Apply quantity
            </button>
            <button type="button" className="ghost-button danger dock-remove-btn" onClick={() => void handleDeleteSelectedLine()}>
              Remove line
            </button>
          </div>
        </div>
      </section>
    );
  }

  function renderAdminView() {
    return (
      <section className="view-stack admin-layout">
        <div className="two-column admin-forms-row">
          <section className="panel">
            <PanelHeader title="Shop Profile" subtitle="Used on receipts and GST invoices." />
            <div className="form-grid">
              <LabeledField label="Shop Name">
                <input
                  className="touch-input"
                  value={shopProfileForm.shopName}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setShopProfileForm((current) => ({ ...current, shopName: value }));
                  }}
                />
              </LabeledField>
              <LabeledField label="Phone">
                <input
                  className="touch-input"
                  value={shopProfileForm.phone}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setShopProfileForm((current) => ({ ...current, phone: value }));
                  }}
                />
              </LabeledField>
              <LabeledField label="GSTIN">
                <input
                  className="touch-input"
                  value={shopProfileForm.gstin}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setShopProfileForm((current) => ({ ...current, gstin: value }));
                  }}
                />
              </LabeledField>
              <LabeledField label="Receipt Prefix">
                <input
                  className="touch-input"
                  value={shopProfileForm.receiptPrefix}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setShopProfileForm((current) => ({ ...current, receiptPrefix: value }));
                  }}
                />
              </LabeledField>
              <LabeledField label="Invoice Prefix">
                <input
                  className="touch-input"
                  value={shopProfileForm.invoicePrefix}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setShopProfileForm((current) => ({ ...current, invoicePrefix: value }));
                  }}
                />
              </LabeledField>
              <LabeledField label="Address" wide>
                <textarea
                  className="touch-textarea tall"
                  value={shopProfileForm.address}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setShopProfileForm((current) => ({ ...current, address: value }));
                  }}
                />
              </LabeledField>
              <LabeledField label="Footer Note" wide>
                <textarea
                  className="touch-textarea tall"
                  value={shopProfileForm.footerNote}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setShopProfileForm((current) => ({ ...current, footerNote: value }));
                  }}
                />
              </LabeledField>
            </div>
            <div className="action-row">
              <button type="button" className="primary-button" onClick={() => void handleSaveShopProfile()}>
                Save Shop Profile
              </button>
            </div>
          </section>

          <section className="panel">
            <PanelHeader title="Admin Access" subtitle="Change the local admin name." />
            <div className="form-grid">
              <LabeledField label="Admin Name">
                <input
                  className="touch-input"
                  value={adminForm.adminName}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setAdminForm((current) => ({ ...current, adminName: value }));
                  }}
                />
              </LabeledField>
              <LabeledField label="Last Backup">
                <input className="touch-input" value={adminSettingsState.lastBackupAt ? formatDateTime(adminSettingsState.lastBackupAt) : "No backup yet"} disabled />
              </LabeledField>
            </div>
            <div className="action-row">
              <button type="button" className="primary-button" onClick={() => void handleSaveAdminSettings()}>
                Save Admin Settings
              </button>
            </div>
          </section>
        </div>

        <div className="catalog-split">
          <section className="panel flex-fill">
            <PanelHeader title="Categories" subtitle="Add and organize the menu groups used at the counter." />
            <div className="form-grid compact">
              <LabeledField label="Category Name">
                <input
                  className="touch-input"
                  value={categoryForm.name}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setCategoryForm((current) => ({ ...current, name: value }));
                  }}
                />
              </LabeledField>
              <LabeledField label="Display Order">
                <input
                  className="touch-input"
                  inputMode="numeric"
                  value={`${categoryForm.displayOrder}`}
                  onChange={(event) => {
                    const value = Number(event.currentTarget.value) || 0;
                    setCategoryForm((current) => ({
                      ...current,
                      displayOrder: value,
                    }));
                  }}
                />
              </LabeledField>
            </div>
            <div className="toggle-row">
              <label>
                <input
                  type="checkbox"
                  checked={categoryForm.isActive}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setCategoryForm((current) => ({ ...current, isActive: checked }));
                  }}
                />
                Active
              </label>
            </div>
            <div className="action-row">
              <button type="button" className="primary-button" onClick={() => void handleSaveCategory()}>
                {categoryForm.id ? "Update Category" : "Add Category"}
              </button>
              <button type="button" className="ghost-button" onClick={resetCategoryForm}>
                Reset
              </button>
            </div>

            <div className="table-shell">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Order</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {categories.length === 0 ? (
                    <EmptyTableRow columns={4} message="No categories yet." />
                  ) : (
                    categories.map((category) => (
                      <tr key={category.id}>
                        <td>{category.name}</td>
                        <td>{category.displayOrder}</td>
                        <td>{category.isActive ? "Active" : "Disabled"}</td>
                        <td className="table-actions">
                          <button
                            type="button"
                            className="ghost-button small"
                            onClick={() =>
                              setCategoryForm({
                                id: category.id,
                                name: category.name,
                                displayOrder: category.displayOrder,
                                isActive: category.isActive,
                              })
                            }
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="ghost-button small danger"
                            onClick={() => void handleToggleCategory(category)}
                          >
                            {category.isActive ? "Disable" : "Enable"}
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel flex-fill">
            <div className="form-grid compact">
              <LabeledField label="Category">
                <select
                  className="touch-input"
                  value={itemForm.categoryId}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setItemForm((current) => ({ ...current, categoryId: value }));
                  }}
                >
                  <option value="">Select category</option>
                  {activeCategories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </LabeledField>
              <LabeledField label="Item Name">
                <input
                  className="touch-input"
                  value={itemForm.name}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setItemForm((current) => ({ ...current, name: value }));
                  }}
                />
              </LabeledField>
              <LabeledField label="Unit">
                <select
                  className="touch-input"
                  value={itemForm.unit}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setItemForm((current) => ({ ...current, unit: value }));
                  }}
                >
                  {UNIT_OPTIONS.map((unit) => (
                    <option key={unit} value={unit}>
                      {unit}
                    </option>
                  ))}
                </select>
              </LabeledField>
              {itemForm.unit === "custom" ? (
                <LabeledField label="Custom Unit">
                  <input
                    className="touch-input"
                    value={itemForm.customUnit}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setItemForm((current) => ({ ...current, customUnit: value }));
                    }}
                  />
                </LabeledField>
              ) : null}
              <LabeledField label="Rate (incl. GST)">
                <input
                  className="touch-input"
                  inputMode="decimal"
                  value={itemForm.unitPrice}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setItemForm((current) => ({ ...current, unitPrice: value }));
                  }}
                />
              </LabeledField>
              <LabeledField label="GST Rate">
                <select
                  className="touch-input"
                  value={itemForm.gstRate}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setItemForm((current) => ({ ...current, gstRate: value }));
                  }}
                >
                  {GST_OPTIONS.map((gstRate) => (
                    <option key={gstRate} value={gstRate}>
                      {gstRate}%
                    </option>
                  ))}
                </select>
              </LabeledField>
            </div>
            <div className="toggle-row">
              <label>
                <input
                  type="checkbox"
                  checked={itemForm.isActive}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setItemForm((current) => ({ ...current, isActive: checked }));
                  }}
                />
                Active
              </label>
            </div>
            <div className="action-row">
              <button type="button" className="primary-button" onClick={() => void handleSaveItem()}>
                {itemForm.id ? "Update Item" : "Add Item"}
              </button>
              <button type="button" className="ghost-button" onClick={resetItemForm}>
                Reset
              </button>
            </div>

            <div className="table-shell">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Category</th>
                    <th>Rate</th>
                    <th>GST</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 ? (
                    <EmptyTableRow columns={5} message="No items yet." />
                  ) : (
                    items.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <strong>{item.name}</strong>
                          <div className="table-note">{item.unit}</div>
                        </td>
                        <td>{item.categoryName}</td>
                        <td>{formatCurrencyFromPaise(item.unitPricePaise)}</td>
                        <td>{item.gstRate}%</td>
                        <td className="table-actions">
                          <button
                            type="button"
                            className="ghost-button small"
                            onClick={() =>
                              setItemForm({
                                id: item.id,
                                categoryId: `${item.categoryId}`,
                                name: item.name,
                                unit: UNIT_OPTIONS.includes(item.unit as (typeof UNIT_OPTIONS)[number]) ? item.unit : "custom",
                                customUnit: UNIT_OPTIONS.includes(item.unit as (typeof UNIT_OPTIONS)[number]) ? "" : item.unit,
                                unitPrice: toInputPrice(item.unitPricePaise),
                                gstRate: `${item.gstRate}`,
                                isActive: item.isActive,
                              })
                            }
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="ghost-button small danger"
                            onClick={() => void handleToggleItem(item)}
                          >
                            {item.isActive ? "Disable" : "Enable"}
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </section>
    );
  }

  function renderReportsView() {
    return (
      <section className="reports-layout">
        {salePreview ? (
          <div className="sale-preview-banner">
            <div>
              <span className="eyebrow">Last saved</span>
              <div>
                <strong>{salePreview.billNumber}</strong>
                {" · "}
                {formatCurrencyFromPaise(salePreview.grandTotalPaise)}
                {" · "}
                {PAYMENT_MODE_LABELS[salePreview.paymentMode]}
              </div>
            </div>
            <div className="banner-actions">
              {PRINTING_ENABLED ? (
                <>
                  <button type="button" className="secondary-button" onClick={() => void handlePreviewSaleDocument(salePreview, "receipt")}>
                    Print Receipt
                  </button>
                  <button type="button" className="secondary-button" onClick={() => void handlePreviewSaleDocument(salePreview, "gst_invoice")}>
                    Print GST
                  </button>
                </>
              ) : null}
              <button type="button" className="ghost-button" onClick={() => setSalePreview(null)}>
                Dismiss
              </button>
            </div>
          </div>
        ) : null}

        <section className="panel">
          <PanelHeader
            title="Reports"
            subtitle="Date range, register, and summaries."
            action={
              <button type="button" className="secondary-button" onClick={() => void handleExportSales()}>
                Export sales
              </button>
            }
          />
          <div className="filter-row">
            <LabeledField label="From">
              <input
                className="touch-input"
                type="date"
                value={reportDateFrom}
                onChange={(event) => setReportDateFrom(event.currentTarget.value)}
              />
            </LabeledField>
            <LabeledField label="To">
              <input
                className="touch-input"
                type="date"
                value={reportDateTo}
                onChange={(event) => setReportDateTo(event.currentTarget.value)}
              />
            </LabeledField>
            <LabeledField label="Search">
              <input
                className="touch-input"
                value={reportSearch}
                onChange={(event) => setReportSearch(event.currentTarget.value)}
                placeholder="Bill # or mode"
              />
            </LabeledField>
            <div className="action-stack">
              <button type="button" className="primary-button" onClick={() => void handleRefreshReports()}>
                Refresh
              </button>
            </div>
          </div>
        </section>

        <div className="metrics-strip">
          <MetricTile
            label="Gross"
            value={formatCurrencyFromPaise(filteredReportSales.reduce((sum, sale) => sum + sale.grandTotalPaise, 0))}
          />
          <MetricTile
            label="GST"
            value={formatCurrencyFromPaise(filteredReportSales.reduce((sum, sale) => sum + sale.taxTotalPaise, 0))}
          />
          <MetricTile label="Bills" value={`${filteredReportSales.length}`} />
          <MetricTile label="UPI" value={`${filteredReportSales.filter((sale) => sale.paymentMode === "upi").length}`} />
        </div>

        <div className="reports-main-split">
          <section className="panel flex-fill">
            <PanelHeader title="Sale register" subtitle="Void / reissue from here." />
            <div className="table-shell">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Bill</th>
                    <th>Time</th>
                    <th>Pay</th>
                    <th>Total</th>
                    <th>Stat</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredReportSales.length === 0 ? (
                    <EmptyTableRow columns={6} message="No sales in this date range." />
                  ) : (
                    filteredReportSales.map((sale) => (
                      <tr key={sale.id}>
                        <td>
                          <strong>{sale.billNumber}</strong>
                          <div className="table-note">{DOCUMENT_TYPE_LABELS[sale.documentType]}</div>
                        </td>
                        <td>{formatDateTime(sale.saleTimestamp)}</td>
                        <td>{PAYMENT_MODE_LABELS[sale.paymentMode]}</td>
                        <td>{formatCurrencyFromPaise(sale.grandTotalPaise)}</td>
                        <td>
                          <span className={`status-pill status-${sale.status}`}>{sale.status}</span>
                        </td>
                        <td className="table-actions">
                          <button
                            type="button"
                            className="ghost-button small"
                            onClick={() => void handlePreviewSaleDocument(sale, "receipt")}
                          >
                            Rcpt
                          </button>
                          <button
                            type="button"
                            className="ghost-button small"
                            onClick={() => void handlePreviewSaleDocument(sale, "gst_invoice")}
                          >
                            GST
                          </button>
                          {sale.status !== "voided" ? (
                            <button
                              type="button"
                              className="ghost-button small danger"
                              onClick={() => void handleStartReissue(sale)}
                            >
                              Fix
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <div className="reports-side-stack">
            <section className="panel flex-fill">
              <PanelHeader
                title="GST slabs"
                action={
                  <button type="button" className="ghost-button small" onClick={() => void handleExportGst()}>
                    Export
                  </button>
                }
              />
              <div className="table-shell">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>%</th>
                      <th>Taxable</th>
                      <th>Tax</th>
                      <th>Gross</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gstSummary.length === 0 ? (
                      <EmptyTableRow columns={4} message="No GST in range." />
                    ) : (
                      gstSummary.map((row) => (
                        <tr key={row.gstRate}>
                          <td>{row.gstRate}%</td>
                          <td>{formatCurrencyFromPaise(row.taxablePaise)}</td>
                          <td>{formatCurrencyFromPaise(row.taxPaise)}</td>
                          <td>{formatCurrencyFromPaise(row.grossPaise)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="panel flex-fill">
              <PanelHeader
                title="Payments"
                action={
                  <button type="button" className="ghost-button small" onClick={() => void handleExportPayments()}>
                    Export
                  </button>
                }
              />
              <div className="table-shell">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Mode</th>
                      <th>#</th>
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paymentSummary.length === 0 ? (
                      <EmptyTableRow columns={3} message="No payments in range." />
                    ) : (
                      paymentSummary.map((row) => (
                        <tr key={row.paymentMode}>
                          <td>{PAYMENT_MODE_LABELS[row.paymentMode]}</td>
                          <td>{row.saleCount}</td>
                          <td>{formatCurrencyFromPaise(row.totalPaise)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </div>
      </section>
    );
  }

  function renderSettingsView() {
    return (
      <section className="view-stack">
        <div className="two-column">
          {PRINTING_ENABLED ? (
            <section className="panel">
              <PanelHeader
                title="Printer Profiles"
                subtitle="Keep a separate mapping for receipt and GST invoice output."
                action={
                  <button type="button" className="ghost-button" onClick={() => void handleRefreshRuntime()}>
                    Refresh printers
                  </button>
                }
              />
              {(["receipt", "gst_invoice"] as PrinterProfileType[]).map((profileType) => (
                <section key={profileType} className="printer-card">
                  <div>
                    <span className="eyebrow">{PRINTER_PROFILE_LABELS[profileType]}</span>
                    <strong>{profileType === "receipt" ? "Counter roll or desktop printer" : "A4 GST invoice printer"}</strong>
                  </div>
                  <select
                    className="touch-input"
                    value={printerDrafts[profileType]}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setPrinterDrafts((current) => ({ ...current, [profileType]: value }));
                    }}
                  >
                    <option value="">Select installed printer</option>
                    {printerOptions.map((printerName) => (
                      <option key={`${profileType}-${printerName}`} value={printerName}>
                        {printerName}
                      </option>
                    ))}
                  </select>
                  <div className="action-row">
                    <button type="button" className="primary-button" onClick={() => void handleSavePrinterProfile(profileType)}>
                      Save
                    </button>
                    <button type="button" className="secondary-button" onClick={() => void handleTestPrinter(profileType)}>
                      Test Print
                    </button>
                    <button type="button" className="ghost-button danger" onClick={() => void handleClearPrinterProfile(profileType)}>
                      Remove
                    </button>
                  </div>
                </section>
              ))}
            </section>
          ) : null}

          <section className="panel">
            <PanelHeader title="Local Data" subtitle="Paths and backup." />
            <div className="info-list compact-info">
              <InfoRow label="Platform" value={runtimeInfo?.platform ?? "Loading…"} />
              <InfoRow label="Database" value={runtimeInfo?.databasePath ?? "Loading…"} />
              <InfoRow label="Last Backup" value={adminSettingsState.lastBackupAt ? formatDateTime(adminSettingsState.lastBackupAt) : "No backup yet"} />
            </div>
            <div className="action-row">
              <button type="button" className="primary-button" onClick={() => void handleBackupDatabase()}>
                Create Backup
              </button>
              <button type="button" className="secondary-button" onClick={() => void handleRefreshRuntime()}>
                Refresh
              </button>
            </div>
          </section>
        </div>
      </section>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-ribbon"></div>
          <div>
            <span className="eyebrow">Acksync CRM</span>
            <h1>{shopProfile.shopName}</h1>
          </div>
        </div>
        <nav className="topnav">
          {(["home", "billing", "admin", "reports", "settings"] as AppView[]).map((view) => (
            <button
              key={view}
              type="button"
              className={activeView === view ? "selected" : ""}
              onClick={() => setActiveView(view)}
            >
              {NAV_LABELS[view]}
            </button>
          ))}
        </nav>
        <div className="status-panel">
          <span>{loading ? workingLabel : "Local-first, ready for billing"}</span>
          <strong>{formatCurrencyFromPaise(dashboardMetrics.todayGrossPaise)}</strong>
        </div>
      </header>

      {toast ? <div className={`toast toast-${toast.kind}`}>{toast.message}</div> : null}

      {loading ? (
        <section className="loading-screen">
          <div className="loader-ring"></div>
          <p>{workingLabel}</p>
        </section>
      ) : (
        <div className="view-root">{renderView()}</div>
      )}
    </main>
  );
}

function PanelHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <header className="panel-header">
      <div>
        <h2>{title}</h2>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {action}
    </header>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <article className="metric-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function EmptyTableRow({ columns, message }: { columns: number; message: string }) {
  return (
    <tr>
      <td className="empty-cell" colSpan={columns}>
        {message}
      </td>
    </tr>
  );
}

function LabeledField({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={`field ${wide ? "wide" : ""}`}>
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-row">
      <strong>{label}</strong>
      <span>{value}</span>
    </div>
  );
}

export default App;
