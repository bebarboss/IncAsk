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
  KeyUsage,
  PivotResult,
  Project,
  ResultsPage,
  ResultsQuery,
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
  listServices(projectId: string): Promise<Service[]>;
  listTaxonomy(projectId: string, serviceId: string): Promise<TaxonomyRow[]>;
  // import (step 5)
  previewImport(projectId: string, path: string | null): Promise<ImportPreview>;
  importSummary(projectId: string, roles: Role[]): Promise<ImportSummary>;
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
    saveApiKey: (key) => call("save_api_key", { key }),
    removeApiKey: () => call("remove_api_key"),
    gatewayStatus: () => call("gateway_status"),
    checkGateway: () => call("check_gateway"),
    gatewayModels: () => call("gateway_models"),
    testGateway: (model) => call("test_gateway", { model: model ?? null }),
    gatewayKeyUsage: () => call("gateway_key_usage"),
    checkUpdate: () => call("check_update"),
    installUpdate: () => call("install_update"),
    // no projects until step 3 — the UI shows its empty state
    listProjects: async () => [],
    listServices: notYet,
    listTaxonomy: notYet,
    previewImport: notYet,
    importSummary: notYet,
    classifyStatus: async () => null,
    pauseClassify: notYet,
    resumeClassify: notYet,
    cancelClassify: notYet,
    queryResults: notYet,
    projectMonths: notYet,
    pivot: notYet,
    drill: notYet,
    savedViews: notYet,
    usageSummary: notYet,
    pickFile: async (filters) => {
      const { open } = await dialog;
      const r = await open({ multiple: false, directory: false, filters });
      return typeof r === "string" ? r : null;
    },
    on: async (event, cb) => {
      const { listen } = await ev;
      return listen(event, (e) => cb(e.payload as never));
    },
  };
}

export const api: Backend = !inTauri() || __INCASK_MOCK__ ? createMockBackend() : createTauriBackend();
