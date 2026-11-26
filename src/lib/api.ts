// Thin wrapper over Tauri invoke/listen (pattern from DocAsk lib/api.ts). Falls back to an
// in-memory mock when the page is not running inside Tauri, or when built with INCASK_MOCK=1.
// The frontend never sees the API key — only hasKey + last 4 chars.

import type {
  AppError,
  AppInfo,
  ClassifyProgress,
  GatewayInfo,
  GatewayStatus,
  ImportPreview,
  ImportSummary,
  ImportResult,
  DateOrder,
  ReportPattern,
  TrialResult,
  KeyUsage,
  PivotResult,
  PivotConfig,
  Charts,
  ViewConfig,
  Project,
  ResultsPage,
  ResultsQuery,
  RowInput,
  ColumnSpec,
  TaxonomyImportPreview,
  Role,
  SavedView,
  Service,
  Settings,
  TaxonomyRow,
  TestResult,
  TicketRow,
  UpdateInfo,
  UpdateProgress,
  UsageSummary,
} from "./types";
import { createMockBackend } from "./mock";
import { th } from "../i18n/th";

export interface EventMap {
  "gateway-status": GatewayStatus;
  "update-progress": UpdateProgress;
  "classify://progress": ClassifyProgress;
}

export type EventName = keyof EventMap;
export type Unlisten = () => void;

export interface DrillCell {
  /** (field, value) from the outer row level down to the clicked one */
  path: [string, string][];
  col: [string, string] | null;
}

export interface Backend {
  mock: boolean;
  appInfo(): Promise<AppInfo>;
  getSettings(): Promise<Settings>;
  saveSettings(s: Settings): Promise<Settings>;
  // gateway + key
  getGateway(): Promise<GatewayInfo>;
  setGatewayUrl(url: string): Promise<GatewayInfo>;
  resetGatewayUrl(): Promise<GatewayInfo>;
  /** the key goes to Rust → Windows Credential Manager; it is never stored in the frontend */
  saveApiKey(key: string): Promise<GatewayInfo>;
  removeApiKey(): Promise<GatewayInfo>;
  gatewayStatus(): Promise<GatewayStatus>;
  checkGateway(): Promise<GatewayStatus>;
  gatewayModels(): Promise<string[]>;
  testGateway(model?: string): Promise<TestResult>;
  gatewayKeyUsage(): Promise<KeyUsage | null>;
  checkUpdate(): Promise<UpdateInfo>;
  installUpdate(): Promise<void>;
  // projects + taxonomy (step 3–4)
  listProjects(): Promise<Project[]>;
  createProject(name: string, color?: string): Promise<Project>;
  updateProject(id: string, patch: { name?: string; color?: string }): Promise<Project>;
  /** deletes the project database — cannot be undone */
  deleteProject(id: string): Promise<void>;
  listServices(projectId: string): Promise<Service[]>;
  listTaxonomy(projectId: string, serviceId: string): Promise<TaxonomyRow[]>;
  createService(projectId: string, name: string, columns: string[], color?: string): Promise<Service>;
  updateService(projectId: string, id: string, patch: { name?: string; color?: string }): Promise<Service>;
  deleteService(projectId: string, id: string): Promise<void>;
  setServiceColumns(projectId: string, id: string, columns: ColumnSpec[]): Promise<Service>;
  saveTaxonomyRow(projectId: string, serviceId: string, row: RowInput): Promise<TaxonomyRow>;
  /** tickets currently classified into this category */
  taxonomyRowUsage(projectId: string, rowId: string): Promise<number>;
  /** moveTo = another category of the same service; null = classify those tickets again */
  deleteTaxonomyRow(projectId: string, rowId: string, moveTo: string | null): Promise<number>;
  previewTaxonomyImport(projectId: string, path: string, service: string | null): Promise<TaxonomyImportPreview>;
  applyTaxonomyImport(projectId: string, path: string, service: string | null): Promise<Service[]>;
  saveTaxonomyTemplate(path: string): Promise<void>;
  // import (step 5)
  previewImport(projectId: string, path: string, sheet: string | null): Promise<ImportPreview>;
  importAnalyze(projectId: string, path: string, sheet: string | null, roles: Role[], dateOrder: DateOrder | null): Promise<ImportSummary>;
  importCommit(projectId: string, path: string, sheet: string | null, roles: Role[], dateOrder: DateOrder | null, replace: boolean, patternName: string | null): Promise<ImportResult>;
  listPatterns(projectId: string): Promise<ReportPattern[]>;
  updatePattern(projectId: string, id: string, patch: { name?: string; roles?: Role[] }): Promise<ReportPattern>;
  deletePattern(projectId: string, id: string): Promise<void>;
  // classify (step 6)
  startClassify(projectId: string, importId: string | null): Promise<ClassifyProgress>;
  classifyStatus(projectId: string): Promise<ClassifyProgress | null>;
  pauseClassify(projectId: string): Promise<void>;
  resumeClassify(projectId: string): Promise<ClassifyProgress>;
  cancelClassify(projectId: string): Promise<void>;
  /** clear results of these tickets (or all low/error ones) and classify again */
  reclassify(projectId: string, ticketIds: string[] | null, lowOnly: boolean, includeHuman: boolean): Promise<ClassifyProgress>;
  classifyTrial(projectId: string, path: string, sheet: string | null, roles: Role[], dateOrder: DateOrder | null): Promise<TrialResult>;
  getPref(projectId: string, key: string): Promise<string | null>;
  setPref(projectId: string, key: string, value: string): Promise<void>;
  // results + summary (step 7–8)
  queryResults(projectId: string, q: ResultsQuery): Promise<ResultsPage>;
  /** every column of the imported files */
  sourceColumns(projectId: string): Promise<string[]>;
  /** one or more tickets of the same service → a category of that service; saved as human */
  setCategory(projectId: string, ticketIds: string[], fields: Record<string, string>): Promise<number>;
  projectMonths(projectId: string): Promise<string[]>;
  pivot(projectId: string, cfg: PivotConfig): Promise<PivotResult>;
  drill(projectId: string, cfg: PivotConfig, cell: DrillCell, limit: number): Promise<{ total: number; rows: TicketRow[] }>;
  pivotCharts(projectId: string, from: string, to: string, filters: PivotConfig["filters"]): Promise<Charts>;
  /** distinct values of a field in the period, for filter chips */
  pivotValues(projectId: string, field: string, from: string, to: string): Promise<string[]>;
  savedViews(projectId: string): Promise<SavedView[]>;
  saveView(projectId: string, id: string | null, name: string, config: ViewConfig): Promise<SavedView>;
  deleteView(projectId: string, id: string): Promise<void>;
  // usage (step 10)
  usageSummary(): Promise<UsageSummary>;
  pickFile(filters: { name: string; extensions: string[] }[]): Promise<string | null>;
  pickSavePath(defaultName: string, filters: { name: string; extensions: string[] }[]): Promise<string | null>;
  on<E extends EventName>(event: E, cb: (payload: EventMap[E]) => void): Promise<Unlisten>;
}

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function toAppError(e: unknown): AppError {
  if (e && typeof e === "object" && "message" in e) {
    const o = e as { code?: string; message: string; status?: number };
    return { code: o.code ?? "unknown", message: String(o.message), status: o.status };
  }
  return { code: "unknown", message: String(e) };
}

export function errMsg(e: unknown): string {
  return toAppError(e).message;
}

/** Commands that later steps add on the Rust side. */
const notYet = (): Promise<never> => Promise.reject<never>({ code: "not_implemented", message: th.err.notYet });

function createTauriBackend(): Backend {
  const core = import("@tauri-apps/api/core");
  const ev = import("@tauri-apps/api/event");
  const dialog = import("@tauri-apps/plugin-dialog");

  const call = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const { invoke } = await core;
    try {
      return await invoke<T>(cmd, args);
    } catch (e) {
      throw toAppError(e);
    }
  };

  return {
    mock: false,
    appInfo: () => call("app_info"),
    getSettings: () => call("get_settings"),
    saveSettings: (settings) => call("save_settings", { settings }),
    getGateway: () => call("get_gateway"),
    setGatewayUrl: (url) => call("set_gateway_url", { url }),
    resetGatewayUrl: () => call("reset_gateway_url"),
    saveApiKey: (key) => call("save_api_key", { key }),
    removeApiKey: () => call("remove_api_key"),
    gatewayStatus: () => call("gateway_status"),
    checkGateway: () => call("check_gateway"),
    gatewayModels: () => call("gateway_models"),
    testGateway: (model) => call("test_gateway", { model: model ?? null }),
    gatewayKeyUsage: () => call("gateway_key_usage"),
    checkUpdate: () => call("check_update"),
    installUpdate: () => call("install_update"),
    listProjects: () => call("list_projects"),
    createProject: (name, color) => call("create_project", { name, color: color ?? null }),
    updateProject: (id, patch) => call("update_project", { id, name: patch.name ?? null, color: patch.color ?? null }),
    deleteProject: (id) => call("delete_project", { id }),
    listServices: (projectId) => call("list_services", { projectId }),
    listTaxonomy: (projectId, serviceId) => call("list_taxonomy", { projectId, serviceId }),
    createService: (projectId, name, columns, color) => call("create_service", { projectId, name, columns, color: color ?? null }),
    updateService: (projectId, id, patch) => call("update_service", { projectId, id, name: patch.name ?? null, color: patch.color ?? null }),
    deleteService: (projectId, id) => call("delete_service", { projectId, id }),
    setServiceColumns: (projectId, id, columns) => call("set_service_columns", { projectId, id, columns }),
    saveTaxonomyRow: (projectId, serviceId, row) => call("save_taxonomy_row", { projectId, serviceId, row }),
    taxonomyRowUsage: (projectId, rowId) => call("taxonomy_row_usage", { projectId, rowId }),
    deleteTaxonomyRow: (projectId, rowId, moveTo) => call("delete_taxonomy_row", { projectId, rowId, moveTo }),
    previewTaxonomyImport: (projectId, path, service) => call("preview_taxonomy_import", { projectId, path, service }),
    applyTaxonomyImport: (projectId, path, service) => call("apply_taxonomy_import", { projectId, path, service }),
    saveTaxonomyTemplate: (path) => call("save_taxonomy_template", { path }),
    previewImport: (projectId, path, sheet) => call("import_preview", { projectId, path, sheet }),
    importAnalyze: (projectId, path, sheet, roles, dateOrder) => call("import_analyze", { projectId, path, sheet, roles, dateOrder }),
    importCommit: (projectId, path, sheet, roles, dateOrder, replace, patternName) => call("import_commit", { projectId, path, sheet, roles, dateOrder, replace, patternName }),
    listPatterns: (projectId) => call("list_patterns", { projectId }),
    updatePattern: (projectId, id, patch) => call("update_pattern", { projectId, id, name: patch.name ?? null, roles: patch.roles ?? null }),
    deletePattern: (projectId, id) => call("delete_pattern", { projectId, id }),
    startClassify: (projectId, importId) => call("start_classify", { projectId, importId }),
    classifyStatus: (projectId) => call("classify_status", { projectId }),
    pauseClassify: (projectId) => call("pause_classify", { projectId }),
    resumeClassify: (projectId) => call("resume_classify", { projectId }),
    cancelClassify: (projectId) => call("cancel_classify", { projectId }),
    reclassify: (projectId, ticketIds, lowOnly, includeHuman) => call("reclassify", { projectId, ticketIds, lowOnly, includeHuman }),
    classifyTrial: (projectId, path, sheet, roles, dateOrder) => call("classify_trial", { projectId, path, sheet, roles, dateOrder }),
    getPref: (projectId, key) => call("get_pref", { projectId, key }),
    setPref: (projectId, key, value) => call("set_pref", { projectId, key, value }),
    queryResults: (projectId, query) => call("query_results", { projectId, query: { ...query, filters: query.filters ?? [], sort: query.sort ?? null, desc: !!query.desc } }),
    sourceColumns: (projectId) => call("source_columns", { projectId }),
    setCategory: (projectId, ticketIds, fields) => call("set_category", { projectId, ticketIds, fields }),
    projectMonths: (projectId) => call("project_months", { projectId }),
    pivot: (projectId, cfg) => call("pivot_query", { projectId, config: cfg }),
    drill: (projectId, cfg, cell, limit) => call("pivot_drill", { projectId, config: cfg, cell, limit }),
    pivotCharts: (projectId, from, to, filters) => call("pivot_charts", { projectId, from, to, filters }),
    pivotValues: (projectId, field, from, to) => call("pivot_values", { projectId, field, from, to }),
    savedViews: (projectId) => call("list_views", { projectId }),
    saveView: (projectId, id, name, config) => call("save_view", { projectId, id, name, config }),
    deleteView: (projectId, id) => call("delete_view", { projectId, id }),
    usageSummary: notYet,
    pickFile: async (filters) => {
      const { open } = await dialog;
      const r = await open({ multiple: false, directory: false, filters });
      return typeof r === "string" ? r : null;
    },
    pickSavePath: async (defaultName, filters) => {
      const { save } = await dialog;
      return (await save({ defaultPath: defaultName, filters })) ?? null;
    },
    on: async (event, cb) => {
      const { listen } = await ev;
      return listen(event, (e) => cb(e.payload as never));
    },
  };
}

export const api: Backend = !inTauri() || __INCASK_MOCK__ ? createMockBackend() : createTauriBackend();
