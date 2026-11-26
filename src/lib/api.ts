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
  KeyUsage,
  PivotResult,
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
  service: string;
  /** value of the first category column, or null for the service total */
  category: string | null;
  month: string | null;
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
  classifyStatus(projectId: string): Promise<ClassifyProgress | null>;
  pauseClassify(runId: string): Promise<void>;
  resumeClassify(runId: string): Promise<void>;
  cancelClassify(runId: string): Promise<void>;
  // results + summary (step 7–8)
  queryResults(projectId: string, q: ResultsQuery): Promise<ResultsPage>;
  projectMonths(projectId: string): Promise<string[]>;
  pivot(projectId: string, from: string, to: string): Promise<PivotResult>;
  drill(projectId: string, cell: DrillCell, from: string, to: string): Promise<{ total: number; rows: TicketRow[] }>;
  savedViews(projectId: string): Promise<SavedView[]>;
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
    classifyStatus: async () => null,
    pauseClassify: notYet,
    resumeClassify: notYet,
    cancelClassify: notYet,
    queryResults: notYet,
    projectMonths: (projectId) => call("project_months", { projectId }),
    pivot: notYet,
    drill: notYet,
    savedViews: notYet,
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
