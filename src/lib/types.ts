// Shapes shared by the Tauri backend (src-tauri) and the mock backend.
// Field names are camelCase, matching `#[serde(rename_all = "camelCase")]` in Rust.

export interface AppError {
  code: string;
  message: string;
  status?: number;
}

export interface AppInfo {
  version: string;
  dataDir: string;
  mock: boolean;
}

export type Theme = "light" | "dark" | "system";
export type FontChoice = "looped" | "sarabun" | "plex" | "system";

/** %APPDATA%\IncAsk\app.json — never contains the key. */
export interface Settings {
  theme: Theme;
  font: FontChoice;
  userName: string;
  setupDone: boolean;
  gatewayUrl: string;
  model: string;
  concurrency: 4 | 8 | 16;
  batchSize: number;
  updateUrl: string;
  autoCheckUpdate: boolean;
  sidebarCollapsed: boolean;
  lastProjectId: string | null;
  lastTestAt: number | null;
  lastTestOk: boolean | null;
}

/** The frontend only learns whether a key exists and its last 4 characters. */
export interface GatewayInfo {
  groupName: string;
  url: string;
  defaultUrl: string;
  hasKey: boolean;
  keyLast4: string | null;
  model: string;
  lastTestAt: number | null;
  lastTestOk: boolean | null;
}

export interface GatewayStatus {
  state: "unknown" | "ok" | "unreachable" | "error";
  message: string | null;
  checkedAt: number;
}

export interface TestResult {
  model: string;
  ok: boolean;
  reply: string | null;
  error: string | null;
  status: number | null;
  elapsedMs: number;
  unreachable: boolean;
}

export interface KeyUsage {
  keyAlias: string | null;
  spend: number | null;
  maxBudget: number | null;
  softBudget: number | null;
  budgetDuration: string | null;
  budgetResetAt: string | null;
  expires: string | null;
  tpmLimit: number | null;
  rpmLimit: number | null;
  models: string[];
}

export interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  version: string | null;
  notes: string | null;
  date: string | null;
}

export interface UpdateProgress {
  downloaded: number;
  total: number | null;
  done: boolean;
}

// ------------------------------------------------------------------ projects / taxonomy

export interface Project {
  id: string;
  name: string;
  color: string;
  sort: number;
}

export interface Service {
  id: string;
  name: string;
  color: string;
  /** user-defined category columns, in hierarchy order (e.g. หัวข้อหลัก, หัวข้อย่อย) */
  columns: string[];
  taxonomyVersion: number;
  sort: number;
}

export interface TaxonomyRow {
  id: string;
  serviceId: string;
  code: string;
  values: Record<string, string>;
  description: string;
  examples: string;
}

// ------------------------------------------------------------------ import

export type Role = "ticket" | "date" | "problem" | "service" | "none";

export interface ImportPreview {
  fileName: string;
  sheet: string;
  sheets: string[];
  headers: string[];
  /** first 8–10 rows, as text */
  rows: string[][];
  rowCount: number;
  /** matched report pattern (by header signature), or null = new pattern */
  pattern: { id: string; name: string } | null;
  roles: Role[];
}

export interface ImportSummary {
  /** ISO dates yyyy-mm-dd (ค.ศ.) */
  dateFrom: string | null;
  dateTo: string | null;
  months: string[];
  duplicates: number;
  invalid: number;
  services: { name: string; known: boolean; count: number }[];
}

// ------------------------------------------------------------------ classify

export type ClassifySource = "ai" | "cache" | "human" | "error" | "unknown_service";
export type RunStatus = "running" | "paused" | "done" | "cancelled" | "failed";

export interface RecentItem {
  ticketNo: string;
  service: string;
  text: string;
  category: string;
  low: boolean;
  cached: boolean;
}

export interface ClassifyProgress {
  runId: string;
  projectId: string;
  fileName: string;
  patternName: string | null;
  status: RunStatus;
  total: number;
  done: number;
  ai: number;
  cached: number;
  low: number;
  error: number;
  etaSec: number | null;
  concurrency: number;
  recent: RecentItem[];
}

// ------------------------------------------------------------------ results / pivot

export interface TicketRow {
  id: string;
  ticketNo: string;
  /** yyyy-mm-dd */
  date: string;
  /** yyyy-mm */
  month: string;
  service: string;
  problemText: string;
  fields: Record<string, string>;
  aiFields: Record<string, string> | null;
  confidence: number | null;
  reason: string | null;
  source: ClassifySource;
  /** every column of the source file */
  sourceRow: Record<string, string>;
}

export interface ResultsQuery {
  search?: string;
  service?: string;
  month?: string;
  lowOnly?: boolean;
  errorOnly?: boolean;
  offset: number;
  limit: number;
}

export interface ResultsPage {
  total: number;
  lowCount: number;
  rows: TicketRow[];
}

export interface PivotLeaf {
  key: string;
  values: number[];
  total: number;
}

export interface PivotGroup {
  key: string;
  color: string;
  values: number[];
  total: number;
  children: PivotLeaf[];
}

export interface PivotResult {
  months: string[];
  groups: PivotGroup[];
  grand: number[];
  grandTotal: number;
}

export interface SavedView {
  id: string;
  name: string;
}

// ------------------------------------------------------------------ usage

export interface RunRow {
  id: string;
  startedAt: number;
  project: string;
  fileName: string;
  rows: number;
  cached: number;
  tokens: number;
  cost: number | null;
}

export interface UsageSummary {
  monthLabel: string;
  spend: number | null;
  budget: number | null;
  tokens: number;
  runs: number;
  budgetResetAt: string | null;
  byProject: { name: string; color: string; cost: number }[];
  history: RunRow[];
}
