import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, errMsg } from "./lib/api";
import type { AppInfo, ClassifyProgress, GatewayStatus, Project, Settings } from "./lib/types";

export type ProjectTab = "import" | "classify" | "results" | "summary" | "settings";
export type AppSection = "gateway" | "usage" | "theme" | "backup" | "about";

export type Page =
  | { name: "setup" }
  | { name: "project"; tab: ProjectTab }
  | { name: "app"; section: AppSection };

interface Ctx {
  ready: boolean;
  loadError: string | null;
  info: AppInfo | null;
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  /** re-read app.json after a command that changed it on the Rust side (URL, test result) */
  refreshSettings: () => Promise<void>;
  gateway: GatewayStatus;
  recheckGateway: () => Promise<void>;
  projects: Project[];
  refreshProjects: () => Promise<void>;
  activeProject: Project | null;
  setActiveProject: (id: string) => void;
  /** latest classification progress per project (drives the % on the จัดหมวด tab) */
  jobs: Record<string, ClassifyProgress>;
  page: Page;
  go: (p: Page) => void;
  exportOpen: boolean;
  setExportOpen: (v: boolean) => void;
  toast: (msg: string) => void;
  reload: () => Promise<void>;
}

const AppCtx = createContext<Ctx | null>(null);

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  font: "looped",
  userName: "",
  setupDone: false,
  gatewayUrl: "",
  model: "godev1",
  concurrency: 8,
  batchSize: 10,
  updateUrl: "",
  autoCheckUpdate: true,
  sidebarCollapsed: false,
  lastProjectId: null,
  lastTestAt: null,
  lastTestOk: null,
  lastTestModel: null,
};

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [gateway, setGateway] = useState<GatewayStatus>({ state: "unknown", message: null, checkedAt: 0 });
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Record<string, ClassifyProgress>>({});
  const [page, setPage] = useState<Page>({ name: "project", tab: "import" });
  const [exportOpen, setExportOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<number>();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const refreshProjects = useCallback(async () => {
    const ps = await api.listProjects();
    setProjects(ps);
    setActiveId((cur) => (cur && ps.some((p) => p.id === cur) ? cur : ps[0]?.id ?? null));
  }, []);

  const recheckGateway = useCallback(async () => {
    try {
      setGateway(await api.checkGateway());
    } catch (e) {
      setGateway({ state: "error", message: errMsg(e), checkedAt: Date.now() });
    }
  }, []);

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      const [s, i] = await Promise.all([api.getSettings(), api.appInfo()]);
      setSettings(s);
      setInfo(i);
      await refreshProjects();
      setActiveId((cur) => cur ?? s.lastProjectId);
      setPage(s.setupDone ? initialPage() : { name: "setup" });
      setReady(true);
      if (s.setupDone) recheckGateway();
    } catch (e) {
      setLoadError(errMsg(e));
    }
  }, [refreshProjects, recheckGateway]);

  useEffect(() => {
    reload();
  }, [reload]);

  // theme + font
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.dataset.font = settings.font;
  }, [settings.theme, settings.font]);

  // live events + periodic Gateway re-check (so the VPN banner clears/appears on its own)
  useEffect(() => {
    const offs = [
      api.on("gateway-status", (s) => setGateway(s)),
      api.on("classify://progress", (p) => setJobs((j) => ({ ...j, [p.projectId]: p }))),
    ];
    const t = window.setInterval(() => {
      if (settingsRef.current.setupDone) api.gatewayStatus().then(setGateway).catch(() => {});
    }, 30_000);
    return () => {
      offs.forEach((p) => p.then((f) => f()));
      clearInterval(t);
    };
  }, []);

  // a job that was already running when the app opened
  useEffect(() => {
    if (!activeId) return;
    api.classifyStatus(activeId).then((p) => p && setJobs((j) => ({ ...j, [p.projectId]: p }))).catch(() => {});
  }, [activeId]);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...patch };
    setSettings(next);
    setSettings(await api.saveSettings(next));
  }, []);

  const refreshSettings = useCallback(async () => {
    setSettings(await api.getSettings());
  }, []);

  const setActiveProject = useCallback((id: string) => {
    setActiveId(id);
    if (settingsRef.current.lastProjectId !== id) updateSettings({ lastProjectId: id }).catch(() => {});
  }, [updateSettings]);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), 2600);
  }, []);

  const activeProject = projects.find((p) => p.id === activeId) ?? null;

  const value = useMemo<Ctx>(
    () => ({
      ready, loadError, info, settings, updateSettings, refreshSettings, gateway, recheckGateway, projects, refreshProjects,
      activeProject, setActiveProject, jobs, page, go: setPage, exportOpen, setExportOpen, toast, reload,
    }),
    [ready, loadError, info, settings, updateSettings, refreshSettings, gateway, recheckGateway, projects, refreshProjects, activeProject, setActiveProject, jobs, page, exportOpen, toast, reload],
  );

  return (
    <AppCtx.Provider value={value}>
      {children}
      {toastMsg && <div className="toast" role="status">{toastMsg}</div>}
    </AppCtx.Provider>
  );
}

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error("useApp outside AppProvider");
  return c;
}

/** mock-mode preview helper: ?page=import|classify|results|summary|settings|app|usage */
function initialPage(): Page {
  if (!api.mock) return { name: "project", tab: "import" };
  const p = new URLSearchParams(location.search).get("page");
  if (p === "import" || p === "classify" || p === "results" || p === "summary" || p === "settings") return { name: "project", tab: p };
  if (p === "app") return { name: "app", section: "gateway" };
  if (p === "usage") return { name: "app", section: "usage" };
  return { name: "project", tab: "import" };
}
