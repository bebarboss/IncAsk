// Menu opened from the user's name at the bottom of the sidebar (canvas "เมนูชื่อผู้ใช้").
import { useState } from "react";
import { BarChart3, ChevronUp, DownloadCloud, Moon, RefreshCw, Wifi } from "lucide-react";
import { api, errMsg } from "../lib/api";
import type { UpdateInfo } from "../lib/types";
import { initials } from "../lib/format";
import { th } from "../i18n/th";
import { useApp, type AppSection } from "../state";
import { usePopover } from "./ui";
import { UpdateDialog } from "./UpdateDialog";

export function ProfileMenu() {
  const app = useApp();
  const { settings, info, go } = app;
  const pop = usePopover();
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const name = settings.userName || "ผู้ใช้";
  const open = (section: AppSection) => { pop.setOpen(false); go({ name: "app", section }); };
  const checkUpdate = async () => {
    pop.setOpen(false);
    try {
      const u = await api.checkUpdate();
      if (u.available) setUpdate(u);
      else app.toast(`✓ IncAsk ${u.currentVersion} เป็นเวอร์ชันล่าสุด`);
    } catch (e) {
      app.toast(errMsg(e));
    }
  };
  const ico = { size: 17, strokeWidth: 1.8, "aria-hidden": true } as const;
  return (
    <div ref={pop.ref} style={{ position: "relative", flex: 1, minWidth: 0, display: "flex" }}>
      <button className="profile-btn" aria-haspopup="menu" aria-expanded={pop.open} onClick={() => pop.setOpen(!pop.open)}>
        <span className="avatar" aria-hidden="true">{initials(name)}</span>
        <span className="profile-name ellipsis">{name}</span>
        <ChevronUp size={14} strokeWidth={2.2} className="muted" aria-hidden="true" style={{ transform: pop.open ? undefined : "rotate(180deg)" }} />
      </button>
      {pop.open && (
        <div className="popover" role="menu" aria-label="เมนูผู้ใช้" style={{ left: -10, bottom: 46, width: 300 }}>
          <div className="menu-head">
            <span style={{ fontWeight: 600 }}>{name}</span>
            <span className="muted" style={{ fontSize: 12 }}>IncAsk เวอร์ชัน {info?.version ?? __APP_VERSION__}</span>
          </div>
          <button role="menuitem" className="menu-item" onClick={() => open("gateway")}><Wifi {...ico} />{th.menu.gateway}</button>
          <button role="menuitem" className="menu-item" onClick={() => open("usage")}><BarChart3 {...ico} />{th.menu.usage}</button>
          <button role="menuitem" className="menu-item" onClick={() => open("theme")}><Moon {...ico} />{th.menu.theme} · {th.theme[settings.theme]}</button>
          <button role="menuitem" className="menu-item" onClick={() => open("backup")}><DownloadCloud {...ico} />{th.menu.backup}</button>
          <button role="menuitem" className="menu-item" onClick={checkUpdate}><RefreshCw {...ico} />{th.menu.update}</button>
        </div>
      )}
      {update && <UpdateDialog info={update} onClose={() => setUpdate(null)} />}
    </div>
  );
}
