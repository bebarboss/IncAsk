// Empty state for a project without tickets yet (SPEC §11.5: empty + a button for the first step).
import { FileSpreadsheet } from "lucide-react";
import { useApp } from "../state";
import { EmptyState } from "./ui";

export function NoData({ title, body }: { title: string; body?: string }) {
  const { go } = useApp();
  return (
    <div className="card">
      <EmptyState
        icon={<FileSpreadsheet size={36} strokeWidth={1.6} aria-hidden="true" />}
        title={title}
        body={body ?? "นำเข้าไฟล์ทิกเก็ตแล้วจัดหมวดก่อน ผลจะแสดงที่นี่"}
        action={<button className="btn btn-lg btn-primary" onClick={() => go({ name: "project", tab: "import" })}>นำเข้าไฟล์</button>}
      />
    </div>
  );
}
