// Tabs of the selected project (SPEC §11.3): name | นำเข้าไฟล์ · จัดหมวด · ผลลัพธ์ · สรุปผล · ตั้งค่าโปรเจกต์.
// While a job runs, the จัดหมวด tab shows its % from every page (SPEC §11.5).
import { th } from "../i18n/th";
import { useApp, type ProjectTab } from "../state";

const TABS: ProjectTab[] = ["import", "classify", "results", "summary", "settings"];

export function TopNav() {
  const { activeProject, page, go, jobs } = useApp();
  if (!activeProject) return null;
  const current = page.name === "project" ? page.tab : null;
  const job = jobs[activeProject.id];
  const running = job && (job.status === "running" || job.status === "paused");
  const pct = job && job.total ? Math.floor((job.done / job.total) * 100) : 0;
  return (
    <nav className="topnav" aria-label="หน้าในโปรเจกต์">
      <div className="topnav-project">
        <span className="swatch" style={{ background: activeProject.color }} aria-hidden="true" />
        <span>{activeProject.name}</span>
      </div>
      <div className="topnav-tabs">
        {TABS.map((t) => (
          <button key={t} className="tab" aria-current={current === t ? "page" : undefined} onClick={() => go({ name: "project", tab: t })}>
            {th.tabs[t]}
            {t === "classify" && running && (
              <span className="tab-badge" aria-label={`กำลังจัดหมวด ${pct}%`}>{job.status === "paused" ? "พัก" : `${pct}%`}</span>
            )}
          </button>
        ))}
      </div>
    </nav>
  );
}
