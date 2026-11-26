// Left sidebar, 252px (SPEC §11.3, canvas "คอมโพเนนต์ · Sidebar"): logo, + โปรเจกต์ใหม่,
// project list, Key-usage bar, profile row. No Gateway status light (SPEC).
import { Plus, Settings as SettingsIcon } from "lucide-react";
import { th } from "../i18n/th";
import { useApp } from "../state";
import { KeyUsageChip } from "./KeyUsageChip";
import { ProfileMenu } from "./ProfileMenu";
import { Logo, Skeleton } from "./ui";

export function Sidebar() {
  const app = useApp();
  const { projects, activeProject, setActiveProject, page, go, ready } = app;
  const inProject = page.name === "project";
  return (
    <aside className="sidebar" aria-label="โปรเจกต์">
      <Logo />
      <button
        className="nav-item nav-new"
        onClick={() => app.toast("สร้างโปรเจกต์ใหม่ — ทำในขั้นที่ 3")}
      >
        <span className="plus" aria-hidden="true"><Plus size={14} strokeWidth={2.6} /></span>
        {th.newProject}
      </button>
      <div className="side-head">
        <span>{th.projects}</span>
        <button className="link-btn" onClick={() => app.toast("จัดการโปรเจกต์ — ทำในขั้นที่ 3")}>{th.manage}</button>
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
    </aside>
  );
}
