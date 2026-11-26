import { useEffect, useState } from "react";
import { FolderPlus, X } from "lucide-react";
import type { UpdateInfo } from "./lib/types";
import { UpdateDialog } from "./components/UpdateDialog";
import { ProjectFormDialog } from "./components/ProjectDialogs";
import { api } from "./lib/api";
import { th } from "./i18n/th";
import { useApp } from "./state";
import { Sidebar } from "./components/Sidebar";
import { TopNav } from "./components/TopNav";
import { ExportDialog } from "./components/ExportDialog";
import { EmptyState, ErrorState, Logo, SkeletonList } from "./components/ui";
import SetupPage from "./pages/Setup";
import ImportPage from "./pages/Import";
import ClassifyPage from "./pages/Classify";
import ResultsPage from "./pages/Results";
import SummaryPage from "./pages/Summary";
import ProjectSettingsPage from "./pages/ProjectSettings";
import AppSettingsPage from "./pages/AppSettings";

export default function App() {
  const app = useApp();
  const { page, ready, loadError, activeProject } = app;
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  // check for a new version once at startup; VPN/URL problems are ignored silently (as DocAsk)
  useEffect(() => {
    if (!ready || !app.settings.setupDone || !app.settings.autoCheckUpdate || api.mock) return;
    const t = setTimeout(() => { api.checkUpdate().then((u) => u.available && setUpdate(u)).catch(() => {}); }, 4000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, app.settings.setupDone]);

  const badge = api.mock && <span className="mock-badge">{th.mock}</span>;

  if (loadError) {
    return (
      <div className="setup" style={{ flexDirection: "column", alignItems: "center", gap: 20 }}>
        <Logo />
        <div style={{ maxWidth: 520, width: "100%" }}><ErrorState message={loadError} onRetry={app.reload} /></div>
        {badge}
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="app" aria-busy="true">
        <aside className="sidebar"><Logo /><SkeletonList rows={5} h={32} /></aside>
        <main className="main" style={{ padding: 40 }}><SkeletonList rows={3} h={72} /></main>
      </div>
    );
  }

  if (page.name === "setup") {
    return (
      <div className="app">
        <SetupPage />
        {badge}
      </div>
    );
  }

  return (
    <div className="app">
      {!app.fullscreen && <Sidebar />}
      <main className="main">
        {update && !updateOpen && (
          <div className="banner info" role="status">
            <span>มี IncAsk เวอร์ชันใหม่ <b className="mono">{update.version}</b> (ตอนนี้ใช้ {update.currentVersion})</span>
            <button className="btn btn-primary" onClick={() => setUpdateOpen(true)}>อัปเดต</button>
            <button className="icon-btn" aria-label="ซ่อนการแจ้งเตือนอัปเดต" onClick={() => setUpdate(null)}><X size={16} strokeWidth={1.8} /></button>
          </div>
        )}
        {updateOpen && update && <UpdateDialog info={update} onClose={() => setUpdateOpen(false)} />}
        {page.name === "project" && (
          activeProject ? (
            <>
              {!app.fullscreen && <TopNav />}
              <div className="scroll" style={{ display: "flex", flexDirection: "column" }}>
                {page.tab === "import" && <ImportPage key={activeProject.id} project={activeProject} />}
                {page.tab === "classify" && <ClassifyPage key={activeProject.id} project={activeProject} />}
                {page.tab === "results" && <ResultsPage key={activeProject.id} project={activeProject} />}
                {page.tab === "summary" && <SummaryPage key={activeProject.id} project={activeProject} />}
                {page.tab === "settings" && <ProjectSettingsPage key={activeProject.id} project={activeProject} />}
              </div>
            </>
          ) : (
            <EmptyState
              icon={<FolderPlus size={36} strokeWidth={1.6} aria-hidden="true" />}
              title="ยังไม่มีโปรเจกต์"
              body="แยกงานเป็นโปรเจกต์ เช่น Call Center A หรือ NOC Incident แต่ละโปรเจกต์มีเซอร์วิส หมวดหมู่ และข้อมูลของตัวเอง"
              action={<button className="btn btn-lg btn-primary" onClick={() => setCreating(true)}>สร้างโปรเจกต์แรก</button>}
            />
          )
        )}
        {page.name === "app" && <div className="scroll"><AppSettingsPage section={page.section} /></div>}
      </main>
      <ExportDialog />
      {creating && <ProjectFormDialog onClose={() => setCreating(false)} />}
      {badge}
    </div>
  );
}
