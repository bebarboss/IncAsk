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
  lastTestModel: string | null;
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
  /** ต้นเหตุ fixed for this category (user | program | unclear); null = the AI judges each ticket */
  cause?: string | null;
}

// ------------------------------------------------------------------ import

export type Role = "ticket" | "date" | "problem" | "service" | "none";

export type DateOrder = "dmy" | "mdy";

export interface ImportPreview {
  fileName: string;
  sheet: string;
  sheets: string[];
  headers: string[];
  /** first 10 rows, as text */
  rows: string[][];
  rowCount: number;
  /** matched report pattern (by header signature), or null = new pattern */
  pattern: { id: string; name: string } | null;
  roles: Role[];
  /** from the matched pattern */
  dateOrder: DateOrder | null;
}

export interface ImportSummary {
  /** ISO dates yyyy-mm-dd (ค.ศ.) */
  dateFrom: string | null;
  dateTo: string | null;
  months: string[];
  duplicates: number;
  invalid: number;
  invalidRows: { row: number; message: string }[];
  services: { name: string; known: boolean; count: number }[];
  sample: string;
  dateOrder: DateOrder;
  /** every date fits both orders — ask the user */
  dateAmbiguous: boolean;
  newRows: number;
}

export interface ImportResult {
  importId: string;
  rowsTotal: number;
  rowsNew: number;
  rowsDuplicate: number;
  rowsInvalid: number;
  unknownService: number;
}

export interface ReportPattern {
  id: string;
  name: string;
  headers: string[];
  roles: { ticket: string | null; date: string | null; service: string | null; problem: string[] };
  dateFormat: string | null;
}

// ------------------------------------------------------------------ classify

export type ClassifySource = "ai" | "cache" | "human" | "error" | "unknown_service" | "pending";
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
  /** why the job paused or failed (Gateway down, key rejected …) */
  message?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number | null;
}

export interface TrialItem {
  ticketNo: string;
  service: string;
  text: string;
  category: string | null;
  confidence: number | null;
  reason: string | null;
  cause?: string | null;
  low: boolean;
  error: string | null;
}

export interface TrialResult {
  items: TrialItem[];
  tokensIn: number;
  tokensOut: number;
  cost: number | null;
  elapsedMs: number;
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
  editedBy?: string | null;
  /** ต้นเหตุ: user | program | unclear; null = not assessed */
  cause?: string | null;
  aiCause?: string | null;
  /** every column of the source file */
  sourceRow: Record<string, string>;
}

export interface ResultsQuery {
  search?: string;
  service?: string;
  month?: string;
  /** value of the top category column */
  category?: string;
  lowOnly?: boolean;
  errorOnly?: boolean;
  /** ต้นเหตุ: user | program | unclear | none (not assessed) */
  cause?: string;
  /** per-column contains filters; keys: ticketNo, date, service, problem, confidence, source, cat:<col>, src:<header> */
  filters?: { key: string; value: string }[];
  sort?: string | null;
  desc?: boolean;
  offset: number;
  limit: number;
}

export interface ResultsPage {
  total: number;
  lowCount: number;
  rows: TicketRow[];
}

export interface PivotConfig {
  /** 1–3 fields, outer first: service | month | source | cat:<column> | src:<file column> */
  rows: string[];
  /** across, usually "month"; "" = one total column */
  col: string;
  filters: { field: string; values: string[] }[];
  /** yyyy-mm inclusive */
  from: string;
  to: string;
}

export interface PivotNode {
  key: string;
  values: number[];
  total: number;
  children: PivotNode[];
}

export interface PivotResult {
  colKeys: string[];
  rows: PivotNode[];
  grand: number[];
  grandTotal: number;
}

export interface Charts {
  months: string[];
  trend: { name: string; color: string; values: number[] }[];
  top: { service: string; category: string; color: string; count: number }[];
}

/** what a saved view remembers */
export interface ViewConfig {
  rows: string[];
  col: string;
  value: "count" | "share";
  filters: { field: string; values: string[] }[];
  heat: boolean;
}

export interface SavedView {
  id: string;
  name: string;
  config: ViewConfig;
}

// ------------------------------------------------------------------ taxonomy editing (step 4)

export interface RowInput {
  id: string | null;
  values: Record<string, string>;
  description: string;
  examples: string;
  cause?: string | null;
}

export interface ColumnSpec {
  /** current name, or null for a new column */
  from: string | null;
  name: string;
}

export interface ImportIssue {
  row: number;
  message: string;
}

export interface ServiceImportPreview {
  name: string;
  exists: boolean;
  existingRows: number;
  columns: string[];
  rows: RowInput[];
  errors: ImportIssue[];
  warnings: ImportIssue[];
}

export type ImportColumnRole = "service" | "level" | "description" | "examples" | "cause" | "ignore";

export interface TaxonomyImportPreview {
  fileName: string;
  /** every column header in the file */
  headers: string[];
  /** what each column is used for — guessed, or as set by the user */
  roles: ImportColumnRole[];
  services: ServiceImportPreview[];
}

// ------------------------------------------------------------------ export (step 9)

export interface ExportScope {
  from: string;
  to: string;
  service: string | null;
}

export interface IncaskManifest {
  format: string;
  version: number;
  exportedAt: string;
  appVersion: string;
  from: string;
  to: string;
  service: string | null;
  projectName: string;
  projectColor: string;
  schemaVersion: number;
  tickets: number;
}

export interface IncaskInspect {
  manifest: IncaskManifest;
  tickets: number;
  months: string[];
  services: string[];
  conflicts: number;
}

export interface MergeResult {
  added: number;
  replaced: number;
  kept: number;
  servicesAdded: number;
}

// ------------------------------------------------------------------ config backup (step 10)

export interface ConfigProjectDiff {
  name: string;
  newProject: boolean;
  servicesAdded: number;
  servicesChanged: number;
  categoriesAdded: number;
  categoriesChanged: number;
  categoriesRemoved: number;
  ticketsAffected: number;
  patternsAdded: number;
  patternsChanged: number;
  viewsAdded: number;
  viewsChanged: number;
}
