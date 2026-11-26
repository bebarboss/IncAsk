// Left sidebar, 252px (SPEC §11.3, canvas "คอมโพเนนต์ · Sidebar"): logo, + โปรเจกต์ใหม่,
// project list, Key-usage bar, profile row. No Gateway status light (SPEC).
import { useState } from "react";
import { ChevronsLeft, ChevronsRight, Plus, Settings as SettingsIcon } from "lucide-react";
import { initials } from "../lib/format";
import { th } from "../i18n/th";
import { useApp } from "../state";
import { KeyUsageChip } from "./KeyUsageChip";
import { ProfileMenu } from "./ProfileMenu";
import { Logo, Skeleton } from "./ui";
import { ManageProjectsDialog, ProjectFormDialog } from "./ProjectDialogs";

export function Sidebar() {
  const app = useApp();
  const { projects, activeProject, setActiveProject, page, go, ready } = app;
  const inProject = page.name === "project";
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState(false);
  const collapsed = app.settings.sidebarCollapsed;
  const toggle = () => app.updateSettings({ sidebarCollapsed: !collapsed });
  const dialogs = (
    <>
      {creating && <ProjectFormDialog onClose={() => setCreating(false)} />}
      {managing && <ManageProjectsDialog onClose={() => setManaging(false)} />}
    </>
  );
  if (collapsed) {
    // icon rail: logo, new project, one swatch per project, settings
    return (
      <aside className="sidebar collapsed" aria-label="โปรเจกต์">
        <div className="logo-mark" aria-hidden="true" style={{ margin: "4px auto 10px" }}>I</div>
        <button className="icon-btn rail-btn" aria-label={th.newProject} title={th.newProject} onClick={() => setCreating(true)}>
          <span className="plus" aria-hidden="true" style={{ width: 24, height: 24, borderRadius: 12, background: "var(--accent)", color: "var(--on-accent)", display: "flex", alignItems: "center", justifyContent: "center" }}><Plus size={14} strokeWidth={2.6} /></span>
        </button>
        <nav aria-label="รายการโปรเจกต์" style={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "center", marginTop: 8 }}>
          {projects.map((p) => {
            const sel = inProject && activeProject?.id === p.id;
            return (
              <button key={p.id} className={`icon-btn rail-btn${sel ? " selected" : ""}`} aria-label={p.name} title={p.name} aria-current={sel ? "true" : undefined}
                onClick={() => { setActiveProject(p.id); if (!inProject) go({ name: "project", tab: "import" }); }}>
                <span className="swatch" style={{ background: p.color, width: 14, height: 14, borderRadius: 4 }} aria-hidden="true" />
              </button>
            );
          })}
        </nav>
        <div className="side-bottom" style={{ alignItems: "center", gap: 4, paddingBottom: 10 }}>
          <button className="icon-btn rail-btn" aria-label="ขยายแถบด้านข้าง" title="ขยายแถบด้านข้าง" onClick={toggle}><ChevronsRight size={18} strokeWidth={1.8} /></button>
          <span className="avatar" title={app.settings.userName} aria-hidden="true">{initials(app.settings.userName || "?")}</span>
          <button className="icon-btn rail-btn" aria-label={th.appSettings} title={th.appSettings} onClick={() => go({ name: "app", section: "gateway" })}><SettingsIcon size={18} strokeWidth={1.8} /></button>
        </div>
        {dialogs}
      </aside>
    );
  }
  return (
    <aside className="sidebar" aria-label="โปรเจกต์">
      <button className="icon-btn collapse-toggle" aria-label="ย่อแถบด้านข้าง" title="ย่อแถบด้านข้าง" onClick={toggle}><ChevronsLeft size={16} strokeWidth={1.8} /></button>
      <Logo />
      <button
        className="nav-item nav-new"
        onClick={() => setCreating(true)}
      >
        <span className="plus" aria-hidden="true"><Plus size={14} strokeWidth={2.6} /></span>
        {th.newProject}
      </button>
      <div className="side-head">
        <span>{th.projects}</span>
        <button className="link-btn" onClick={() => setManaging(true)}>{th.manage}</button>
      </div>
      {!ready && <Skeleton h={32} />}
      {ready && projects.length === 0 && <p className="muted" style={{ fontSize: 12, padding: "4px 10px" }}>ยังไม่มีโปรเจกต์</p>}
      <nav aria-label="รายการโปรเจกต์" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {projects.map((p) => {
          const sel = inProject && activeProject?.id === p.id;
          return (
            <button
              key={p.id}
              className={`nav-item${sel ? " selected" : ""}`}
              aria-current={sel ? "true" : undefined}
              onClick={() => { setActiveProject(p.id); if (!inProject) go({ name: "project", tab: "import" }); }}
            >
              <span className="swatch" style={{ background: p.color }} aria-hidden="true" />
              <span className="ellipsis">{p.name}</span>
            </button>
          );
        })}
      </nav>
      <div className="side-bottom">
        <KeyUsageChip />
        <div className="side-foot">
          <ProfileMenu />
          <button className="icon-btn" aria-label={th.appSettings} onClick={() => go({ name: "app", section: "gateway" })}>
            <SettingsIcon size={18} strokeWidth={1.8} />
          </button>
        </div>
      </div>
      {dialogs}
    </aside>
  );
}
