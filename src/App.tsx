import { useDeferredValue, useEffect, useRef, useState, startTransition, type ReactNode } from "react";
import { confirm, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import {
  clearPrinterProfile,
  completeSale,
  deleteVoidedSale,
  markBackupCompleted,
  getDailySalesSummary,
  getDashboardMetrics,
  getGstSummary,
  getItemwiseSummary,
  getPaymentSummary,
  getSaleDetails,
  listSales,
  loadAppSnapshot,
  saveCategory,
  saveItem,
  savePaymentOption,
  savePrinterProfile,
  setCategoryActive,
  setItemActive,
  setPaymentOptionActive,
  toDraftLinesFromSale,
} from "./lib/db";
import {
  DOCUMENT_TYPE_LABELS,
  GST_OPTIONS,
  PRINTER_PROFILE_LABELS,
  UNIT_OPTIONS,
  formatCurrencyFromPaise,
  formatDateTime,
  formatGstRate,
  formatIndianDate,
  formatPaymentModeLabel,
  fromInputPrice,
  quantityMillisToDisplay,
  quantityMillisToString,
  quantityStringToMillis,
  recalculateDraftLine,
  sumDraftTotals,
  toInclusiveBreakdownFromTotal,
  toInputPrice,
  todayIsoDate,
} from "./lib/format";
import { PRINTING_ENABLED } from "./lib/features";
import { buildSalePrintHtml, buildThermalReceiptText, printHtmlDocument } from "./lib/printing";
import {
  exportDailySalesSummary,
  exportGstSummary,
  exportItemwiseSummary,
  exportPaymentSummary,
  exportSalesRegister,
} from "./lib/reports";
import type {
  AdminSettings,
  AppLockStatus,
  AppSnapshot,
  AppView,
  Category,
  DailySalesSummaryRow,
  DashboardMetrics,
  DocumentType,
  DraftLine,
  GstSummaryRow,
  Item,
  ItemwiseSummaryRow,
  PaymentOption,
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

type QuantityEditorState =
  | {
      source: "item";
      item: Item;
      existingDraftId: number | null;
    }
  | {
      source: "line";
      draftId: number;
      initialQuantityMillis: number;
    };

const HOME_ACTIONS: { view: AppView; label: string; eyebrow: string }[] = [
  { view: "billing", label: "Generate Receipt", eyebrow: "Counter" },
  { view: "manual", label: "Manual Receipt", eyebrow: "Custom Price" },
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
  manual: "Manual Receipt",
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

const initialReportDate = todayIsoDate();

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
  const [appLockStatus, setAppLockStatus] = useState<AppLockStatus | null>(null);
  const [unlockCode, setUnlockCode] = useState("");

  const [shopProfile, setShopProfile] = useState<ShopProfile>(INITIAL_SHOP_PROFILE);
  const [adminSettingsState, setAdminSettingsState] = useState<AdminSettings>(INITIAL_ADMIN_SETTINGS);
  const [dashboardMetrics, setDashboardMetrics] = useState<DashboardMetrics>(INITIAL_METRICS);
  const [categories, setCategories] = useState<Category[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [paymentOptions, setPaymentOptions] = useState<PaymentOption[]>([]);
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
    priceIncludesGst: true,
    isActive: true,
  });
  const [paymentOptionForm, setPaymentOptionForm] = useState({
    id: null as number | null,
    name: "",
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
  const [adminCategorySearch, setAdminCategorySearch] = useState("");
  const [adminItemSearch, setAdminItemSearch] = useState("");
  const [draftLines, setDraftLines] = useState<DraftLine[]>([]);
  const [selectedDraftLineId, setSelectedDraftLineId] = useState<number | null>(null);
  const [quantityEntry, setQuantityEntry] = useState("0");
  const [quantityEditorState, setQuantityEditorState] = useState<QuantityEditorState | null>(null);
  const [billPreviewOpen, setBillPreviewOpen] = useState(false);
  const [previewCustomerName, setPreviewCustomerName] = useState("");
  const [previewShouldPrint, setPreviewShouldPrint] = useState(false);
  const [reissueSource, setReissueSource] = useState<SaleDetails | null>(null);

  const [manualPaymentMode, setManualPaymentMode] = useState<PaymentMode>("cash");
  const [manualCustomerName, setManualCustomerName] = useState("");
  const [manualCustomerGstin, setManualCustomerGstin] = useState("");
  const [manualNotes, setManualNotes] = useState("");
  const [manualDraftLines, setManualDraftLines] = useState<DraftLine[]>([]);
  const [manualLineForm, setManualLineForm] = useState({
    itemId: "",
    quantity: "1",
    rate: "",
    total: "",
  });

  const [reportDateFrom, setReportDateFrom] = useState(initialReportDate);
  const [reportDateTo, setReportDateTo] = useState(initialReportDate);
  const [reportSales, setReportSales] = useState<SaleRegisterRow[]>([]);
  const [gstSummary, setGstSummary] = useState<GstSummaryRow[]>([]);
  const [paymentSummary, setPaymentSummary] = useState<PaymentSummaryRow[]>([]);
  const [itemwiseSummary, setItemwiseSummary] = useState<ItemwiseSummaryRow[]>([]);
  const [dailySalesSummary, setDailySalesSummary] = useState<DailySalesSummaryRow[]>([]);
  const [reportSearch, setReportSearch] = useState("");
  const [salePreview, setSalePreview] = useState<SaleDetails | null>(null);

  const deferredItemSearch = useDeferredValue(itemSearch.trim().toLowerCase());
  const deferredAdminCategorySearch = useDeferredValue(adminCategorySearch.trim().toLowerCase());
  const deferredAdminItemSearch = useDeferredValue(adminItemSearch.trim().toLowerCase());
  const deferredReportSearch = useDeferredValue(reportSearch.trim().toLowerCase());

  const bootstrappedRef = useRef(false);
  const prevViewRef = useRef<AppView | null>(null);

  useEffect(() => {
    const prev = prevViewRef.current;
    if (activeView === "settings" && prev !== "settings") {
      setPrinterDrafts({
        receipt: printerProfiles.find((profile) => profile.profileType === "receipt")?.printerName ?? "",
        gst_invoice:
          printerProfiles.find((profile) => profile.profileType === "gst_invoice")?.printerName ?? "",
      });
    }
    prevViewRef.current = activeView;
  }, [activeView, printerProfiles]);

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
        displayOrder: getNextCategoryDisplayOrder(),
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

  useEffect(() => {
    const enabledPaymentOptions = paymentOptions.filter((option) => option.isActive);
    if (enabledPaymentOptions.length === 0) {
      return;
    }

    if (!enabledPaymentOptions.some((option) => option.name === paymentMode)) {
      setPaymentMode(enabledPaymentOptions[0].name);
    }
    if (!enabledPaymentOptions.some((option) => option.name === manualPaymentMode)) {
      setManualPaymentMode(enabledPaymentOptions[0].name);
    }
  }, [paymentOptions, paymentMode, manualPaymentMode]);

  const activeCategories = categories.filter((category) => category.isActive);
  const activePaymentOptions = paymentOptions.filter((option) => option.isActive);
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
  const visibleAdminCategories = categories.filter((category) => {
    if (!deferredAdminCategorySearch) {
      return true;
    }

    return `${category.name} ${category.isActive ? "active" : "disabled"}`
      .toLowerCase()
      .includes(deferredAdminCategorySearch);
  });
  const visibleAdminItems = items.filter((item) => {
    if (!deferredAdminItemSearch) {
      return true;
    }

    return `${item.name} ${item.categoryName} ${item.unit} ${formatGstRate(item.gstRate)} ${
      item.isActive ? "active" : "disabled"
    }`
      .toLowerCase()
      .includes(deferredAdminItemSearch);
  });

  const filteredReportSales = reportSales.filter((sale) => {
    if (!deferredReportSearch) {
      return true;
    }

    return `${sale.billNumber} ${sale.customerName ?? ""} ${sale.paymentMode} ${sale.status}`
      .toLowerCase()
      .includes(deferredReportSearch);
  });

  const selectedDraftLine = draftLines.find((line) => line.draftId === selectedDraftLineId) ?? null;
  const billingTotals = sumDraftTotals(draftLines);
  const manualTotals = sumDraftTotals(manualDraftLines);
  const billingReissueSource = reissueSource?.documentType === "manual_receipt" ? null : reissueSource;
  const findOriginalLineForDraft = (draftLine: DraftLine) =>
    billingReissueSource?.lines.find((line) =>
      line.itemId != null && line.itemId !== 0 && draftLine.itemId !== 0
        ? line.itemId === draftLine.itemId &&
          line.unit === draftLine.unit &&
          line.gstRate === draftLine.gstRate
        : line.itemName === draftLine.itemName &&
          line.categoryName === draftLine.categoryName &&
          line.unit === draftLine.unit &&
          line.gstRate === draftLine.gstRate,
    ) ?? null;
  const quantityEditorItemName =
    quantityEditorState?.source === "item"
      ? quantityEditorState.item.name
      : selectedDraftLine?.itemName ?? "";
  const quantityEditorDraftLine =
    quantityEditorState?.source === "item"
      ? quantityEditorState.existingDraftId != null
        ? draftLines.find((line) => line.draftId === quantityEditorState.existingDraftId) ?? null
        : null
      : quantityEditorState
        ? draftLines.find((line) => line.draftId === quantityEditorState.draftId) ?? null
        : null;
  const quantityEditorOriginalLine = quantityEditorDraftLine ? findOriginalLineForDraft(quantityEditorDraftLine) : null;

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
      const lockStatus = await invoke<AppLockStatus>("get_app_lock_status");
      setAppLockStatus(lockStatus);
      if (lockStatus.isLocked) {
        return;
      }

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
    setAdminSettingsState(snapshot.adminSettings);
    setDashboardMetrics(snapshot.dashboardMetrics);
    setCategories(snapshot.categories);
    setItems(snapshot.items);
    setPaymentOptions(snapshot.paymentOptions);
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

  async function loadReports(profileOverride?: ShopProfile, dateFrom = reportDateFrom, dateTo = reportDateTo) {
    const [sales, gstRows, paymentRows, itemRows, dailyRows] = await Promise.all([
      listSales(dateFrom, dateTo),
      getGstSummary(dateFrom, dateTo),
      getPaymentSummary(dateFrom, dateTo),
      getItemwiseSummary(dateFrom, dateTo),
      getDailySalesSummary(dateFrom, dateTo),
    ]);

    startTransition(() => {
      setReportSales(sales);
      setGstSummary(gstRows);
      setPaymentSummary(paymentRows);
      setItemwiseSummary(itemRows);
      setDailySalesSummary(dailyRows);

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

  function getNextCategoryDisplayOrder() {
    return Math.max(0, ...categories.map((category) => category.displayOrder)) + 10;
  }

  function getDefaultPaymentMode() {
    return activePaymentOptions[0]?.name ?? "cash";
  }

  function readReportDateRange() {
    const dateFrom = reportDateFrom;
    const dateTo = reportDateTo;

    if (!dateFrom || !dateTo) {
      setToast({ kind: "error", message: "Select both report dates." });
      return null;
    }
    if (dateFrom > dateTo) {
      setToast({ kind: "error", message: "The report start date must be before the end date." });
      return null;
    }

    return { dateFrom, dateTo };
  }

  function resetManualReceiptDraft() {
    setManualDraftLines([]);
    setManualCustomerName("");
    setManualCustomerGstin("");
    setManualNotes("");
    setManualPaymentMode(getDefaultPaymentMode());
    setManualLineForm({
      itemId: "",
      quantity: "1",
      rate: "",
      total: "",
    });
    setSelectedCategoryFilter("all");
    setItemSearch("");
  }

  function getReceiptPrinterName() {
    return printerProfiles.find((profile) => profile.profileType === "receipt")?.printerName.trim() ?? "";
  }

  function resetBillingDraft() {
    setDraftLines([]);
    setSelectedDraftLineId(null);
    setQuantityEntry("0");
    setQuantityEditorState(null);
    setBillNotes("");
    setPreviewCustomerName("");
    setBillPreviewOpen(false);
    setPreviewShouldPrint(false);
    setReissueSource(null);
    setBillingDocumentType("receipt");
    setPaymentMode(getDefaultPaymentMode());
    setSelectedCategoryFilter("all");
    setItemSearch("");
  }

  function closeQuantityEditor() {
    setSelectedDraftLineId(null);
    setQuantityEntry("0");
    setQuantityEditorState(null);
  }

  function openItemQuantityEditor(item: Item) {
    const existingLine = draftLines.find(
      (line) =>
        line.itemId === item.id &&
        line.unitPricePaise === item.unitPricePaise &&
        line.gstRate === item.gstRate,
    );

    if (existingLine && billingReissueSource) {
      openDraftLineQuantityEditor(existingLine);
      return;
    }

    setSelectedDraftLineId(existingLine?.draftId ?? null);
    setQuantityEntry("0");
    setQuantityEditorState({
      source: "item",
      item,
      existingDraftId: existingLine?.draftId ?? null,
    });
  }

  function openDraftLineQuantityEditor(line: DraftLine) {
    setSelectedDraftLineId(line.draftId);
    setQuantityEntry(quantityMillisToString(line.quantityMillis));
    setQuantityEditorState({
      source: "line",
      draftId: line.draftId,
      initialQuantityMillis: line.quantityMillis,
    });
  }

  function resetCategoryForm() {
    setCategoryForm({
      id: null,
      name: "",
      displayOrder: getNextCategoryDisplayOrder(),
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
      priceIncludesGst: true,
      isActive: true,
    });
  }

  function resetPaymentOptionForm() {
    setPaymentOptionForm({
      id: null,
      name: "",
      isActive: true,
    });
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
        priceIncludesGst: itemForm.priceIncludesGst,
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

  async function handleSavePaymentOption() {
    const paymentName = normalizeName(paymentOptionForm.name);

    if (!paymentName) {
      setToast({ kind: "error", message: "Payment option name is required." });
      return;
    }

    const duplicatePaymentOption = paymentOptions.find(
      (option) =>
        option.id !== paymentOptionForm.id &&
        option.name.trim().toLowerCase() === paymentName.toLowerCase(),
    );
    if (duplicatePaymentOption) {
      setToast({ kind: "error", message: `Payment option "${paymentName}" already exists.` });
      return;
    }

    try {
      await savePaymentOption({
        ...paymentOptionForm,
        name: paymentName,
      });
      setToast({ kind: "success", message: "Payment option saved." });
      resetPaymentOptionForm();
      await refreshSnapshot("Saving payment option…");
    } catch (error) {
      setToast({
        kind: "error",
        message: isUniqueConstraintError(error)
          ? `Payment option "${paymentName}" already exists.`
          : getErrorMessage(error, "Payment option could not be saved."),
      });
    }
  }

  async function handleTogglePaymentOption(paymentOption: PaymentOption) {
    if (paymentOption.isActive && activePaymentOptions.length <= 1) {
      setToast({ kind: "error", message: "Keep at least one payment option active." });
      return;
    }

    const label = formatPaymentModeLabel(paymentOption.name);
    const approved = await confirm(
      `${paymentOption.isActive ? "Disable" : "Enable"} ${label}?`,
      "Payment option status",
    );
    if (!approved) {
      return;
    }

    try {
      await setPaymentOptionActive(paymentOption.id, !paymentOption.isActive);
      setToast({
        kind: "success",
        message: paymentOption.isActive ? "Payment option disabled." : "Payment option enabled.",
      });
      await refreshSnapshot("Updating payment options…");
    } catch (error) {
      setToast({
        kind: "error",
        message: getErrorMessage(error, "Payment option status could not be updated."),
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
      setQuantityEntry("0");
      return;
    }

    if (key === "backspace") {
      setQuantityEntry((current) => {
        if (current.length <= 1) {
          return "0";
        }
        return current.slice(0, -1);
      });
      return;
    }

    setQuantityEntry((current) => {
      if (key === "." && current === "0") {
        return "0.";
      }
      if (key === "." && current.includes(".")) {
        return current;
      }
      if (current === "0" && key !== ".") {
        return key;
      }
      return `${current}${key}`;
    });
  }

  function handleQuantityShortcut(value: string) {
    setQuantityEntry(value);
  }

  function handleApplyQuantitySelection() {
    if (!quantityEditorState) {
      setToast({ kind: "info", message: "Select an item before applying quantity." });
      return;
    }

    const quantityMillis = quantityStringToMillis(quantityEntry);
    if (quantityMillis <= 0) {
      setToast({ kind: "error", message: "Enter a valid quantity first." });
      return;
    }

    if (quantityEditorState.source === "item") {
      const { item, existingDraftId } = quantityEditorState;
      if (existingDraftId) {
        setDraftLines((current) =>
          current.map((line) =>
            line.draftId === existingDraftId
              ? recalculateDraftLine(line, line.quantityMillis + quantityMillis)
              : line,
          ),
        );
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
            priceIncludesGst: item.priceIncludesGst,
            lineSubtotalPaise: 0,
            lineTaxPaise: 0,
            lineTotalPaise: 0,
          },
          quantityMillis,
        );
        setDraftLines((current) => [...current, newLine]);
      }
      closeQuantityEditor();
      return;
    }

    setDraftLines((current) =>
      current.map((line) =>
        line.draftId === quantityEditorState.draftId
          ? recalculateDraftLine(line, quantityMillis)
          : line,
      ),
    );
    closeQuantityEditor();
  }

  function handleCancelQuantityEditor() {
    closeQuantityEditor();
  }

  async function handleClearDraft() {
    if (draftLines.length === 0) {
      return;
    }

    const approved = await confirm("Clear the current draft bill?", "Clear bill");
    if (!approved) {
      return;
    }

    resetBillingDraft();
  }

  function handleOpenBillPreview(shouldPrint: boolean) {
    if (draftLines.length === 0) {
      setToast({ kind: "error", message: "Add items before saving a bill." });
      return;
    }
    if (!paymentMode.trim()) {
      setToast({ kind: "error", message: "Select a payment option before saving a bill." });
      return;
    }

    setPreviewShouldPrint(shouldPrint);
    setBillPreviewOpen(true);
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
        customerName: previewCustomerName,
        customerGstin: "",
        notes: billNotes,
        lines: draftLines,
        reissueOfSaleId: billingReissueSource?.id ?? null,
      });
      const sale = await getSaleDetails(saleId);
      const snapshot = await loadAppSnapshot();
      await loadReports(snapshot.shopProfile);

      if (!sale) {
        throw new Error("The bill was saved, but the receipt details could not be reloaded.");
      }

      startTransition(() => {
        applySnapshot(snapshot);
        resetBillingDraft();
        setActiveView("billing");
      });

      let printWarning = "";
      if (PRINTING_ENABLED && shouldPrint) {
        try {
          if (billingDocumentType !== "gst_invoice") {
            const printerName = getReceiptPrinterName();
            if (!printerName) {
              throw new Error("Receipt printer is not configured.");
            }

            await invoke<string>("print_receipt_text", {
              printerName,
              receiptText: buildThermalReceiptText(shopProfile, sale),
            });
          } else {
            const html = buildSalePrintHtml(shopProfile, sale, billingDocumentType, printerProfiles);
            printHtmlDocument(sale.billNumber, html);
          }
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

      if (requestedDocument !== "gst_invoice") {
        const printerName = getReceiptPrinterName();
        if (!printerName) {
          setToast({ kind: "error", message: "Configure the receipt printer in Settings before printing." });
          return;
        }

        await invoke<string>("print_receipt_text", {
          printerName,
          receiptText: buildThermalReceiptText(shopProfile, details),
        });
        setToast({ kind: "success", message: `Receipt ${details.billNumber} sent to ${printerName}.` });
      } else {
        const html = buildSalePrintHtml(shopProfile, details, requestedDocument, printerProfiles);
        printHtmlDocument(details.billNumber, html);
      }
    } catch (error) {
      setToast({
        kind: "error",
        message: getErrorMessage(error, "The document preview could not be opened."),
      });
    }
  }

  async function handleOpenSalePreview(sale: SaleRegisterRow) {
    try {
      const details = await getSaleDetails(sale.id);
      if (!details) {
        setToast({ kind: "error", message: "Sale details could not be loaded." });
        return;
      }

      setSalePreview(details);
    } catch (error) {
      setToast({
        kind: "error",
        message: getErrorMessage(error, "The receipt preview could not be opened."),
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

      if (details.documentType === "manual_receipt") {
        setManualDraftLines(toDraftLinesFromSale(details));
        setManualPaymentMode(details.paymentMode);
        setManualCustomerName(details.customerName ?? "");
        setManualCustomerGstin(details.customerGstin ?? "");
        setManualNotes(details.notes ?? "");
        setManualLineForm({ itemId: "", quantity: "1", rate: "", total: "" });
        setReissueSource(details);
        setActiveView("manual");
        setToast({
          kind: "info",
          message: `Reissue mode started for ${details.billNumber}. Save the corrected receipt to void the old entry.`,
        });
        return;
      }

      setDraftLines(toDraftLinesFromSale(details));
      setSelectedDraftLineId(null);
      setQuantityEntry("0");
      setQuantityEditorState(null);
      setPaymentMode(details.paymentMode);
      setBillingDocumentType(details.documentType);
      setBillNotes(details.notes ?? "");
      setPreviewCustomerName(details.customerName ?? "");
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

  async function handleDeleteVoidedSale(sale: SaleRegisterRow) {
    if (sale.status !== "voided") {
      setToast({ kind: "error", message: "Only voided bills can be permanently deleted." });
      return;
    }

    const approved = await confirm(
      `${sale.billNumber} is voided. Delete it permanently? It will be gone forever.`,
      "Delete voided bill forever",
    );
    if (!approved) {
      return;
    }

    setLoading(true);
    setWorkingLabel("Deleting voided bill…");
    try {
      await deleteVoidedSale(sale.id);
      setSalePreview((current) => (current?.id === sale.id ? null : current));
      await loadReports();
      const metrics = await getDashboardMetrics();
      setDashboardMetrics(metrics);
      setToast({ kind: "success", message: `${sale.billNumber} permanently deleted.` });
    } catch (error) {
      setToast({
        kind: "error",
        message: getErrorMessage(error, "Voided bill could not be deleted."),
      });
    } finally {
      setLoading(false);
    }
  }

  function handleCancelReissue() {
    resetBillingDraft();
    setToast({ kind: "info", message: "Reissue cancelled. Ready for a fresh receipt." });
  }

  function handleCancelManualReissue() {
    setReissueSource(null);
    resetManualReceiptDraft();
    setToast({ kind: "info", message: "Manual reissue cancelled. Ready for a fresh manual receipt." });
  }

  function handleSelectManualItem(item: Item) {
    setManualLineForm((current) => ({
      ...current,
      itemId: `${item.id}`,
      rate: current.rate || toInputPrice(item.unitPricePaise),
    }));
  }

  function handleAddManualLine() {
    const item = items.find((candidate) => candidate.id === Number(manualLineForm.itemId));
    const quantityMillis = quantityStringToMillis(manualLineForm.quantity);
    const totalPaise = fromInputPrice(manualLineForm.total);

    if (!item) {
      setToast({ kind: "error", message: "Select an item for the manual receipt." });
      return;
    }
    if (quantityMillis <= 0) {
      setToast({ kind: "error", message: "Enter a valid quantity." });
      return;
    }
    if (totalPaise <= 0) {
      setToast({ kind: "error", message: "Enter the required line total." });
      return;
    }

    const enteredRatePaise = manualLineForm.rate.trim() ? fromInputPrice(manualLineForm.rate) : 0;
    const unitPricePaise = enteredRatePaise > 0 ? enteredRatePaise : Math.round((totalPaise * 1000) / quantityMillis);
    const totals = toInclusiveBreakdownFromTotal(totalPaise, item.gstRate);
    const draftId = Date.now() + item.id;

    setManualDraftLines((current) => [
      ...current,
      {
        draftId,
        itemId: item.id,
        itemName: item.name,
        categoryId: item.categoryId,
        categoryName: item.categoryName,
        unit: item.unit,
        quantityMillis,
        unitPricePaise,
        gstRate: item.gstRate,
        priceIncludesGst: true,
        ...totals,
      },
    ]);
    setManualLineForm({ itemId: "", quantity: "1", rate: "", total: "" });
  }

  function handleRemoveManualLine(draftId: number) {
    setManualDraftLines((current) => current.filter((line) => line.draftId !== draftId));
  }

  async function handleSaveManualReceipt() {
    if (manualDraftLines.length === 0) {
      setToast({ kind: "error", message: "Add at least one item before saving the manual receipt." });
      return;
    }
    if (!manualPaymentMode.trim()) {
      setToast({ kind: "error", message: "Select a payment option before saving the manual receipt." });
      return;
    }

    setLoading(true);
    setWorkingLabel("Saving manual receipt…");

    try {
      const documentType: DocumentType = "manual_receipt";
      const saleId = await completeSale({
        documentType,
        paymentMode: manualPaymentMode,
        customerName: manualCustomerName,
        customerGstin: manualCustomerGstin,
        notes: manualNotes,
        lines: manualDraftLines,
        reissueOfSaleId: reissueSource?.documentType === documentType ? reissueSource.id : null,
      });
      const sale = await getSaleDetails(saleId);
      const snapshot = await loadAppSnapshot();
      await loadReports(snapshot.shopProfile);

      startTransition(() => {
        applySnapshot(snapshot);
        resetManualReceiptDraft();
        setReissueSource(null);
        setActiveView("manual");
      });

      setToast({
        kind: "success",
        message: `${DOCUMENT_TYPE_LABELS[documentType]} ${sale?.billNumber ?? ""} saved successfully.`,
      });
    } catch (error) {
      setToast({
        kind: "error",
        message: getErrorMessage(error, "The manual receipt could not be saved."),
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleRefreshReports() {
    const range = readReportDateRange();
    if (!range) {
      return;
    }

    setLoading(true);
    setWorkingLabel("Refreshing reports…");
    try {
      setReportDateFrom(range.dateFrom);
      setReportDateTo(range.dateTo);
      await loadReports(undefined, range.dateFrom, range.dateTo);
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
    const range = readReportDateRange();
    if (!range) {
      return;
    }

    try {
      const exported = await exportSalesRegister(shopProfile, filteredReportSales, range.dateFrom, range.dateTo);
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
    const range = readReportDateRange();
    if (!range) {
      return;
    }

    try {
      const exported = await exportGstSummary(shopProfile, gstSummary, range.dateFrom, range.dateTo);
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
    const range = readReportDateRange();
    if (!range) {
      return;
    }

    try {
      const exported = await exportPaymentSummary(shopProfile, paymentSummary, range.dateFrom, range.dateTo);
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

  async function handleExportItemwise() {
    const range = readReportDateRange();
    if (!range) {
      return;
    }

    try {
      const exported = await exportItemwiseSummary(shopProfile, itemwiseSummary, range.dateFrom, range.dateTo);
      if (exported) {
        setToast({ kind: "success", message: "Item-wise sold report exported." });
      }
    } catch (error) {
      setToast({
        kind: "error",
        message: getErrorMessage(error, "Item-wise export failed."),
      });
    }
  }

  async function handleExportDailySales() {
    const range = readReportDateRange();
    if (!range) {
      return;
    }

    try {
      const exported = await exportDailySalesSummary(shopProfile, dailySalesSummary, range.dateFrom, range.dateTo);
      if (exported) {
        setToast({ kind: "success", message: "Daily sale report exported." });
      }
    } catch (error) {
      setToast({
        kind: "error",
        message: getErrorMessage(error, "Daily sale export failed."),
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

  async function handleUnlockApp() {
    if (!unlockCode.trim()) {
      setToast({ kind: "error", message: "Enter the unlock code." });
      return;
    }

    setLoading(true);
    setWorkingLabel("Unlocking app…");
    try {
      const lockStatus = await invoke<AppLockStatus>("unlock_app", { code: unlockCode });
      setAppLockStatus(lockStatus);
      setUnlockCode("");
      await bootstrapApp();
      setToast({ kind: "success", message: "App unlocked." });
    } catch (error) {
      setToast({ kind: "error", message: getErrorMessage(error, "Invalid unlock code.") });
    } finally {
      setLoading(false);
    }
  }

  const renderView = () => {
    switch (activeView) {
      case "billing":
        return renderBillingView();
      case "manual":
        return renderManualReceiptView();
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

            {billingReissueSource ? (
              <section className="mini-panel">
                <p className="helper-banner">
                  Reissuing <strong>{billingReissueSource.billNumber}</strong>. Saving voids the old bill, and each line shows its original quantity for reference.
                </p>
                <button type="button" className="secondary-button full-width-action" onClick={handleCancelReissue}>
                  Cancel Reissue
                </button>
              </section>
            ) : null}
          </aside>

          <section className="workspace-panel">
            <PanelHeader
              title="Menu Items"
              subtitle="Tap an item to open the quantity calculator."
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
                    onClick={() => openItemQuantityEditor(item)}
                  >
                    <span className="eyebrow">{item.categoryName}</span>
                    <strong>{item.name}</strong>
                    <p>
                      {item.unit} • {formatGstRate(item.gstRate)} GST •{" "}
                      {item.priceIncludesGst ? "incl." : "excl."}
                    </p>
                    <span className="item-price">{formatCurrencyFromPaise(item.unitPricePaise)}</span>
                  </button>
                ))
              )}
            </div>
          </section>

          <aside className="bill-panel">
          <PanelHeader
            title="Current Bill"
            subtitle={`${draftLines.length} line${draftLines.length === 1 ? "" : "s"}`}
            action={
              <button type="button" className="ghost-button danger" onClick={() => void handleClearDraft()}>
                Clear all
              </button>
            }
          />

          <div className="draft-lines">
            {draftLines.length === 0 ? (
              <div className="empty-state draft-empty-hint">
                Tap menu items to choose quantity, or tap a bill line to edit it.
              </div>
            ) : (
              draftLines.map((line) => {
                const originalLine = reissueSource ? findOriginalLineForDraft(line) : null;

                return (
                  <button
                    key={line.draftId}
                    type="button"
                    className={`draft-line ${selectedDraftLineId === line.draftId ? "selected" : ""}`}
                    onClick={() => openDraftLineQuantityEditor(line)}
                  >
                    <div className="draft-line-main">
                      <strong>{line.itemName}</strong>
                      <span className="draft-line-meta">
                        {quantityMillisToDisplay(line.quantityMillis, line.unit)} · {formatGstRate(line.gstRate)} GST ·{" "}
                        {line.priceIncludesGst ? "incl." : "excl."}
                      </span>
                      {originalLine ? (
                        <span className="draft-line-reference">
                          Original {quantityMillisToDisplay(originalLine.quantityMillis, line.unit)}
                        </span>
                      ) : null}
                    </div>
                    <span className="draft-line-total">{formatCurrencyFromPaise(line.lineTotalPaise)}</span>
                  </button>
                );
              })
            )}
          </div>

          <section className="bill-payment-block">
            <span className="field-label">Payment</span>
            <div className="segmented bill-payment-segmented">
              {activePaymentOptions.length === 0 ? (
                <div className="empty-state compact-empty">Add a payment option in Admin.</div>
              ) : (
                activePaymentOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={paymentMode === option.name ? "selected" : ""}
                    onClick={() => setPaymentMode(option.name)}
                  >
                    {formatPaymentModeLabel(option.name)}
                  </button>
                ))
              )}
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
            <button type="button" className="primary-button checkout-save" onClick={() => handleOpenBillPreview(false)}>
              Save Bill
            </button>
            {PRINTING_ENABLED ? (
              <button type="button" className="secondary-button checkout-save" onClick={() => handleOpenBillPreview(true)}>
                Save & Print
              </button>
            ) : null}
          </div>
        </aside>
        </div>

        {quantityEditorState ? (
        <div className="quantity-drawer-shell" role="presentation">
        <div className="quantity-drawer-backdrop" />
        <div className="billing-quantity-dock" role="dialog" aria-modal="true" aria-label="Quantity entry">
          <div className="quantity-dock-left">
            <div className="quantity-dock-heading">
              <span className="field-label">Quantity Calculator</span>
              <strong className="quantity-dock-item-name">{quantityEditorItemName}</strong>
            </div>
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
              {quantityEditorState.source === "item" ? (
                <>
                  Enter quantity for <strong>{quantityEditorItemName}</strong>, then apply it to the bill.
                </>
              ) : (
                <>
                  Update quantity for <strong>{quantityEditorItemName}</strong>, then apply it to the selected line.
                </>
              )}
            </p>
            {quantityEditorOriginalLine ? (
              <div className="quantity-reference-card">
                <span>Original Receipt Qty</span>
                <strong>{quantityMillisToDisplay(quantityEditorOriginalLine.quantityMillis, quantityEditorOriginalLine.unit)}</strong>
              </div>
            ) : null}
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
            <button type="button" className="secondary-button dock-action-btn" onClick={handleCancelQuantityEditor}>
              Cancel
            </button>
            <button type="button" className="primary-button dock-apply-btn" onClick={handleApplyQuantitySelection}>
              Apply Selected
            </button>
          </div>
        </div>
        </div>
        ) : null}
        {billPreviewOpen ? renderBillPreviewModal() : null}
      </section>
    );
  }

  function renderBillPreviewModal() {
    return (
      <div className="modal-backdrop">
        <section className="modal-sheet bill-preview-modal" role="dialog" aria-modal="true" aria-labelledby="bill-preview-title">
          <span className="eyebrow">Review before saving</span>
          <h2 id="bill-preview-title">Receipt Preview</h2>
          <div className="receipt-preview-meta">
            <div>
              <span>Document</span>
              <strong>{DOCUMENT_TYPE_LABELS[billingDocumentType]}</strong>
            </div>
            <div>
              <span>Payment</span>
              <strong>{formatPaymentModeLabel(paymentMode)}</strong>
            </div>
          </div>

          <LabeledField label="Customer Name (optional)">
            <input
              className="touch-input"
              value={previewCustomerName}
              onChange={(event) => setPreviewCustomerName(event.currentTarget.value)}
              placeholder="Customer name"
            />
          </LabeledField>

          <div className="receipt-preview-lines">
            {draftLines.map((line, index) => (
              <div key={line.draftId} className="receipt-preview-line">
                <span>{index + 1}</span>
                <div>
                  <strong>{line.itemName}</strong>
                  <p>
                    {quantityMillisToDisplay(line.quantityMillis, line.unit)} · {formatGstRate(line.gstRate)} GST ·{" "}
                    {line.priceIncludesGst ? "incl." : "excl."}
                  </p>
                </div>
                <strong>{formatCurrencyFromPaise(line.lineTotalPaise)}</strong>
              </div>
            ))}
          </div>

          <section className="totals-panel preview-totals">
            <div><span>Taxable</span><strong>{formatCurrencyFromPaise(billingTotals.subtotalPaise)}</strong></div>
            <div><span>GST</span><strong>{formatCurrencyFromPaise(billingTotals.taxPaise)}</strong></div>
            <div><span>Grand Total</span><strong>{formatCurrencyFromPaise(billingTotals.grandTotalPaise)}</strong></div>
          </section>

          <div className="modal-actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                setBillPreviewOpen(false);
                void handleSaveSale(previewShouldPrint);
              }}
            >
              Done
            </button>
            <button type="button" className="secondary-button" onClick={() => setBillPreviewOpen(false)}>
              Edit
            </button>
          </div>
        </section>
      </div>
    );
  }

  function renderManualReceiptView() {
    const selectedManualItem = items.find((item) => item.id === Number(manualLineForm.itemId)) ?? null;
    const documentType: DocumentType = "manual_receipt";
    const receiptTitle = DOCUMENT_TYPE_LABELS[documentType];
    const reissuingThisDocument = reissueSource?.documentType === documentType;

    return (
      <section className="billing-shell">
        <div className="billing-main-row manual-main-row">
          <aside className="sidebar-panel">
            <PanelHeader title="Categories" subtitle="Choose items for manual pricing." />
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
              <label className="field-label" htmlFor="manual-item-search">
                Search item
              </label>
              <input
                id="manual-item-search"
                className="touch-input"
                value={itemSearch}
                onChange={(event) => setItemSearch(event.currentTarget.value)}
                placeholder="e.g. Motipak"
              />
            </section>

            {reissuingThisDocument ? (
              <section className="mini-panel">
                <p className="helper-banner">
                  Reissuing <strong>{reissueSource.billNumber}</strong>. Saving voids the old {receiptTitle.toLowerCase()}.
                </p>
                <button type="button" className="secondary-button full-width-action" onClick={handleCancelManualReissue}>
                  Cancel Reissue
                </button>
              </section>
            ) : null}
          </aside>

          <section className="workspace-panel">
            <PanelHeader
              title="Manual Items"
              subtitle="Select an item, then enter the rate or required line total."
              action={
                <button type="button" className="ghost-button" onClick={() => setActiveView("admin")}>
                  Manage menu
                </button>
              }
            />

            <section className="mini-panel manual-entry-panel">
              <div className="manual-line-form">
                <LabeledField label="Item">
                  <select
                    className="touch-input"
                    value={manualLineForm.itemId}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      const item = items.find((candidate) => candidate.id === Number(value));
                      setManualLineForm((current) => ({
                        ...current,
                        itemId: value,
                        rate: item ? toInputPrice(item.unitPricePaise) : current.rate,
                      }));
                    }}
                  >
                    <option value="">Select item</option>
                    {items
                      .filter((item) => item.isActive)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name} ({item.unit})
                        </option>
                      ))}
                  </select>
                </LabeledField>
                <LabeledField label="Qty">
                  <input
                    className="touch-input"
                    inputMode="decimal"
                    value={manualLineForm.quantity}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setManualLineForm((current) => ({ ...current, quantity: value }));
                    }}
                  />
                </LabeledField>
                <LabeledField label="Rate (optional)">
                  <input
                    className="touch-input"
                    inputMode="decimal"
                    value={manualLineForm.rate}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setManualLineForm((current) => ({ ...current, rate: value }));
                    }}
                    placeholder="0.00"
                  />
                </LabeledField>
                <LabeledField label="Total (required)">
                  <input
                    className="touch-input"
                    inputMode="decimal"
                    value={manualLineForm.total}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setManualLineForm((current) => ({ ...current, total: value }));
                    }}
                    placeholder="0.00"
                  />
                </LabeledField>
                <button type="button" className="primary-button manual-add-button" onClick={handleAddManualLine}>
                  Add
                </button>
              </div>
              <p className="manual-entry-hint">
                {selectedManualItem
                  ? `${selectedManualItem.name} uses ${formatGstRate(selectedManualItem.gstRate)} GST. Total is split into taxable and GST automatically.`
                  : `${receiptTitle} lines use your item GST slab, but the entered total controls the final price.`}
              </p>
            </section>

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
                    onClick={() => handleSelectManualItem(item)}
                  >
                    <span className="eyebrow">{item.categoryName}</span>
                    <strong>{item.name}</strong>
                    <p>
                      {item.unit} • {formatGstRate(item.gstRate)} GST
                    </p>
                    <span className="item-price">Custom rate</span>
                  </button>
                ))
              )}
            </div>
          </section>

          <aside className="bill-panel">
            <PanelHeader
              title={receiptTitle}
              subtitle={`${manualDraftLines.length} line${manualDraftLines.length === 1 ? "" : "s"}`}
              action={
                <button
                  type="button"
                  className="ghost-button danger"
                  onClick={reissuingThisDocument ? handleCancelManualReissue : resetManualReceiptDraft}
                >
                  {reissuingThisDocument ? "Cancel Reissue" : "Reset"}
                </button>
              }
            />

            <div className="draft-lines">
              {manualDraftLines.length === 0 ? (
                <div className="empty-state draft-empty-hint">
                  Add items with custom totals to build the receipt.
                </div>
              ) : (
                manualDraftLines.map((line) => (
                  <div key={line.draftId} className="draft-line manual-draft-line">
                    <div className="draft-line-main">
                      <strong>{line.itemName}</strong>
                      <span className="draft-line-meta">
                        {quantityMillisToDisplay(line.quantityMillis, line.unit)} · {formatGstRate(line.gstRate)} GST ·{" "}
                        {formatCurrencyFromPaise(line.unitPricePaise)}
                      </span>
                    </div>
                    <span className="draft-line-total">{formatCurrencyFromPaise(line.lineTotalPaise)}</span>
                    <button
                      type="button"
                      className="ghost-button small danger manual-remove-line"
                      onClick={() => handleRemoveManualLine(line.draftId)}
                    >
                      Remove
                    </button>
                  </div>
                ))
              )}
            </div>

            <section className="manual-customer-stack">
              <LabeledField label="Party Name (optional)">
                <input
                  className="touch-input"
                  value={manualCustomerName}
                  onChange={(event) => setManualCustomerName(event.currentTarget.value)}
                  placeholder="Customer name"
                />
              </LabeledField>
              <LabeledField label="GSTIN (optional)">
                <input
                  className="touch-input"
                  value={manualCustomerGstin}
                  onChange={(event) => setManualCustomerGstin(event.currentTarget.value.toUpperCase())}
                  placeholder="15 digit GSTIN"
                />
              </LabeledField>
            </section>

            <section className="bill-payment-block">
              <span className="field-label">Payment</span>
              <div className="segmented bill-payment-segmented">
                {activePaymentOptions.length === 0 ? (
                  <div className="empty-state compact-empty">Add a payment option in Admin.</div>
                ) : (
                  activePaymentOptions.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={manualPaymentMode === option.name ? "selected" : ""}
                      onClick={() => setManualPaymentMode(option.name)}
                    >
                      {formatPaymentModeLabel(option.name)}
                    </button>
                  ))
                )}
              </div>
              <label className="field-label bill-notes-label" htmlFor="manual-notes">
                Note (optional)
              </label>
              <textarea
                id="manual-notes"
                className="touch-textarea bill-notes"
                value={manualNotes}
                onChange={(event) => setManualNotes(event.currentTarget.value)}
                placeholder="Short note"
                rows={2}
              />
            </section>

            <section className="totals-panel bill-totals">
              <div><span>Taxable</span><strong>{formatCurrencyFromPaise(manualTotals.subtotalPaise)}</strong></div>
              <div><span>GST</span><strong>{formatCurrencyFromPaise(manualTotals.taxPaise)}</strong></div>
              <div><span>Grand Total</span><strong>{formatCurrencyFromPaise(manualTotals.grandTotalPaise)}</strong></div>
            </section>

            <div className="checkout-actions">
              <button type="button" className="primary-button checkout-save" onClick={() => void handleSaveManualReceipt()}>
                Save {receiptTitle}
              </button>
              {reissuingThisDocument ? (
                <button type="button" className="secondary-button checkout-save" onClick={handleCancelManualReissue}>
                  Cancel Reissue
                </button>
              ) : (
                <button type="button" className="secondary-button checkout-save" onClick={resetManualReceiptDraft}>
                  Reset
                </button>
              )}
            </div>
          </aside>
        </div>
      </section>
    );
  }

  function renderAdminView() {
    return (
      <section className="view-stack admin-layout">
        <div className="admin-management-grid">
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
              <LabeledField label="Category Search">
                <input
                  className="touch-input"
                  value={adminCategorySearch}
                  onChange={(event) => setAdminCategorySearch(event.currentTarget.value)}
                  placeholder="Search categories"
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
                    <th>#</th>
                    <th>Name</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleAdminCategories.length === 0 ? (
                    <EmptyTableRow
                      columns={4}
                      message={categories.length === 0 ? "No categories yet." : "No categories match search."}
                    />
                  ) : (
                    visibleAdminCategories.map((category, index) => (
                      <tr key={category.id}>
                        <td>{index + 1}</td>
                        <td>{category.name}</td>
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
            <PanelHeader title="Items" subtitle="Add menu items with GST-inclusive or GST-exclusive rates." />
            <div className="admin-search-row">
              <LabeledField label="Item Search">
                <input
                  className="touch-input"
                  value={adminItemSearch}
                  onChange={(event) => setAdminItemSearch(event.currentTarget.value)}
                  placeholder="Search items"
                />
              </LabeledField>
            </div>
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
              <LabeledField label={itemForm.priceIncludesGst ? "Rate (incl. GST)" : "Rate (excl. GST)"}>
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
              <LabeledField label="Rate Type">
                <select
                  className="touch-input"
                  value={itemForm.priceIncludesGst ? "inclusive" : "exclusive"}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setItemForm((current) => ({ ...current, priceIncludesGst: value === "inclusive" }));
                  }}
                >
                  <option value="inclusive">Includes GST</option>
                  <option value="exclusive">Excludes GST</option>
                </select>
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
                      {formatGstRate(gstRate)}
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
                    <th>#</th>
                    <th>Item</th>
                    <th>Category</th>
                    <th>Rate</th>
                    <th>GST</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleAdminItems.length === 0 ? (
                    <EmptyTableRow columns={6} message={items.length === 0 ? "No items yet." : "No items match search."} />
                  ) : (
                    visibleAdminItems.map((item, index) => (
                      <tr key={item.id}>
                        <td>{index + 1}</td>
                        <td>
                          <strong>{item.name}</strong>
                          <div className="table-note">
                            {item.unit} · {item.priceIncludesGst ? "Includes GST" : "Excludes GST"} ·{" "}
                            {item.isActive ? "Active" : "Disabled"}
                          </div>
                        </td>
                        <td>{item.categoryName}</td>
                        <td>{formatCurrencyFromPaise(item.unitPricePaise)}</td>
                        <td>{formatGstRate(item.gstRate)}</td>
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
                                priceIncludesGst: item.priceIncludesGst,
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

          <section className="panel flex-fill">
            <PanelHeader title="Payment Options" subtitle="Choose what appears on the receipt screen." />
            <div className="form-grid compact single-column">
              <LabeledField label="Payment Name">
                <input
                  className="touch-input"
                  value={paymentOptionForm.name}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setPaymentOptionForm((current) => ({ ...current, name: value }));
                  }}
                  placeholder="e.g. Card"
                />
              </LabeledField>
            </div>
            <div className="toggle-row">
              <label>
                <input
                  type="checkbox"
                  checked={paymentOptionForm.isActive}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setPaymentOptionForm((current) => ({ ...current, isActive: checked }));
                  }}
                />
                Active
              </label>
            </div>
            <div className="action-row">
              <button type="button" className="primary-button" onClick={() => void handleSavePaymentOption()}>
                {paymentOptionForm.id ? "Update Payment" : "Add Payment"}
              </button>
              <button type="button" className="ghost-button" onClick={resetPaymentOptionForm}>
                Reset
              </button>
            </div>

            <div className="table-shell">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Name</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {paymentOptions.length === 0 ? (
                    <EmptyTableRow columns={4} message="No payment options yet." />
                  ) : (
                    paymentOptions.map((option, index) => (
                      <tr key={option.id}>
                        <td>{index + 1}</td>
                        <td>{formatPaymentModeLabel(option.name)}</td>
                        <td>{option.isActive ? "Active" : "Disabled"}</td>
                        <td className="table-actions">
                          <button
                            type="button"
                            className="ghost-button small"
                            onClick={() =>
                              setPaymentOptionForm({
                                id: option.id,
                                name: option.name,
                                isActive: option.isActive,
                              })
                            }
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="ghost-button small danger"
                            onClick={() => void handleTogglePaymentOption(option)}
                          >
                            {option.isActive ? "Disable" : "Enable"}
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
            <div className="sale-preview-header">
              <div>
                <span className="eyebrow">Receipt Preview</span>
                <div>
                  <strong>{salePreview.billNumber}</strong>
                  {" · "}
                  {formatCurrencyFromPaise(salePreview.grandTotalPaise)}
                  {" · "}
                  {formatPaymentModeLabel(salePreview.paymentMode)}
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
                  Close
                </button>
              </div>
            </div>

            <div className="receipt-preview-meta sale-preview-meta-grid">
              <div>
                <span>Customer</span>
                <strong>{salePreview.customerName || "Walk-in Customer"}</strong>
              </div>
              {salePreview.customerGstin ? (
                <div>
                  <span>GSTIN</span>
                  <strong>{salePreview.customerGstin}</strong>
                </div>
              ) : null}
              <div>
                <span>Time</span>
                <strong>{formatDateTime(salePreview.saleTimestamp)}</strong>
              </div>
            </div>

            <div className="receipt-preview-lines">
              {salePreview.lines.map((line, index) => (
                <div key={line.id} className="receipt-preview-line">
                  <span>{index + 1}</span>
                  <div>
                    <strong>{line.itemName}</strong>
                    <p>
                      {quantityMillisToDisplay(line.quantityMillis, line.unit)} · {formatGstRate(line.gstRate)} GST ·{" "}
                      {line.priceIncludesGst ? "incl." : "excl."}
                    </p>
                  </div>
                  <strong>{formatCurrencyFromPaise(line.lineTotalPaise)}</strong>
                </div>
              ))}
            </div>

            <section className="totals-panel preview-totals">
              <div><span>Taxable</span><strong>{formatCurrencyFromPaise(salePreview.subtotalPaise)}</strong></div>
              <div><span>GST</span><strong>{formatCurrencyFromPaise(salePreview.taxTotalPaise)}</strong></div>
              <div><span>Grand Total</span><strong>{formatCurrencyFromPaise(salePreview.grandTotalPaise)}</strong></div>
            </section>
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
              <IndianDateInput
                label="From"
                value={reportDateFrom}
                onChange={setReportDateFrom}
              />
            </LabeledField>
            <LabeledField label="To">
              <IndianDateInput
                label="To"
                value={reportDateTo}
                onChange={setReportDateTo}
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
          <MetricTile label="Days" value={`${dailySalesSummary.length}`} />
          <MetricTile label="UPI" value={`${filteredReportSales.filter((sale) => sale.paymentMode.toLowerCase().includes("upi")).length}`} />
        </div>

        <div className="reports-main-split">
          <section className="panel flex-fill">
            <PanelHeader title="Sale register" subtitle="Preview receipts or fix a bill from here." />
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
                        <td>{formatPaymentModeLabel(sale.paymentMode)}</td>
                        <td>{formatCurrencyFromPaise(sale.grandTotalPaise)}</td>
                        <td>
                          <span className={`status-pill status-${sale.status}`}>{sale.status}</span>
                        </td>
                        <td className="table-actions">
                          <button
                            type="button"
                            className="ghost-button small"
                            onClick={() => void handleOpenSalePreview(sale)}
                          >
                            Rcpt
                          </button>
                          {sale.status !== "voided" ? (
                            <button
                              type="button"
                              className="ghost-button small danger"
                              onClick={() => void handleStartReissue(sale)}
                            >
                              Fix
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="ghost-button small danger"
                              onClick={() => void handleDeleteVoidedSale(sale)}
                            >
                              Delete
                            </button>
                          )}
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
                title="Item sold"
                action={
                  <button type="button" className="ghost-button small" onClick={() => void handleExportItemwise()}>
                    Export
                  </button>
                }
              />
              <div className="table-shell">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Qty</th>
                      <th>Sale</th>
                    </tr>
                  </thead>
                  <tbody>
                    {itemwiseSummary.length === 0 ? (
                      <EmptyTableRow columns={3} message="No item sales in range." />
                    ) : (
                      itemwiseSummary.map((row) => (
                        <tr key={`${row.categoryName}-${row.itemName}-${row.unit}`}>
                          <td>
                            <strong>{row.itemName}</strong>
                            <div className="table-note">{row.categoryName}</div>
                          </td>
                          <td>{quantityMillisToDisplay(row.quantityMillis, row.unit)}</td>
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
                title="Daily sale"
                action={
                  <button type="button" className="ghost-button small" onClick={() => void handleExportDailySales()}>
                    Export
                  </button>
                }
              />
              <div className="table-shell">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>#</th>
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dailySalesSummary.length === 0 ? (
                      <EmptyTableRow columns={3} message="No daily sales in range." />
                    ) : (
                      dailySalesSummary.map((row) => (
                      <tr key={row.saleDate}>
                        <td>
                            <strong>{formatIndianDate(row.saleDate)}</strong>
                            <div className="table-note">GST {formatCurrencyFromPaise(row.taxPaise)}</div>
                          </td>
                          <td>{row.saleCount}</td>
                          <td>{formatCurrencyFromPaise(row.grandTotalPaise)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>

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
                          <td>{formatGstRate(row.gstRate)}</td>
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
                          <td>{formatPaymentModeLabel(row.paymentMode)}</td>
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

  if (!loading && appLockStatus?.isLocked) {
    return (
      <main className="app-shell lock-shell">
        {toast ? <div className={`toast toast-${toast.kind}`}>{toast.message}</div> : null}
        <section className="lock-card">
          <span className="eyebrow">Access Locked</span>
          <h1>{shopProfile.shopName}</h1>
          <p>
            The 7-day trial on this system has ended. Enter the unlock code to continue using the app.
          </p>
          <form
            className="lock-form"
            onSubmit={(event) => {
              event.preventDefault();
              void handleUnlockApp();
            }}
          >
            <LabeledField label="Unlock Code">
              <input
                className="touch-input lock-code-input"
                value={unlockCode}
                onChange={(event) => setUnlockCode(event.currentTarget.value.toUpperCase())}
                placeholder="LMB-XXXX-XXXX"
                autoFocus
              />
            </LabeledField>
            <button type="submit" className="primary-button">
              Unlock App
            </button>
          </form>
        </section>
      </main>
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
          {(["home", "billing", "manual", "admin", "reports", "settings"] as AppView[]).map((view) => (
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

function IndianDateInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      className="touch-input indian-date-field"
      type="date"
      lang="en-IN"
      aria-label={`${label} date`}
      value={value}
      onClick={(event) => event.currentTarget.showPicker?.()}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
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
