// In-memory mock backend used by `npm run dev` in a browser or INCASK_MOCK=1 (SPEC §15).
// Never touches the network. Preview helpers in the URL:
//   ?page=setup|import|classify|results|summary|settings|app|usage   ?gateway=down

import type { Backend, DrillCell, EventMap, EventName } from "./api";
import type {
  ClassifyProgress,
  GatewayInfo,
  GatewayStatus,
  ImportPreview,
  KeyUsage,
  PivotGroup,
  Project,
  RecentItem,
  Role,
  Service,
  Settings,
  TaxonomyRow,
  TicketRow,
  UsageSummary,
} from "./types";
import { DEFAULT_GATEWAY_URL, MODEL_IDS, PROJECT_COLORS, SERVICE_COLORS } from "./gateway";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** C01, C02 … in table order, like taxonomy.rs */
function recode(rows: TaxonomyRow[]): TaxonomyRow[] {
  return rows.map((r, i) => ({ ...r, code: `C${String(i + 1).padStart(2, "0")}` }));
}
const RESERVED = ["เซอร์วิส", "service", "คำอธิบาย", "description", "ตัวอย่าง", "example", "examples"];
function checkColumns(cols: string[]) {
  const c = cols.map((x) => x.trim());
  if (!c.length || c.some((x) => !x)) throw { code: "invalid_columns", message: "ต้องมีคอลัมน์หมวดหมู่อย่างน้อย 1 คอลัมน์ และห้ามเว้นชื่อว่าง" };
  const r = c.find((x) => RESERVED.includes(x.toLowerCase()));
  if (r) throw { code: "invalid_columns", message: `"${r}" เป็นชื่อคอลัมน์พิเศษ ใช้เป็นคอลัมน์หมวดหมู่ไม่ได้` };
  if (new Set(c.map((x) => x.toLowerCase())).size !== c.length) throw { code: "invalid_columns", message: "ชื่อคอลัมน์ซ้ำกัน" };
}
function cleanName(name: string): string {
  const n = name.split(/\s+/).filter(Boolean).join(" ");
  if (!n) throw { code: "invalid_name", message: "ใส่ชื่อโปรเจกต์ก่อน" };
  if ([...n].length > 60) throw { code: "invalid_name", message: "ชื่อโปรเจกต์ยาวได้ไม่เกิน 60 ตัวอักษร" };
  return n;
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
type Listener = (p: unknown) => void;

/** deterministic PRNG so the mock data looks the same on every reload */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COLS = ["หัวข้อหลัก", "หัวข้อย่อย"];
const MONTHS = ["2026-08", "2026-09", "2026-10"];

// [main, sub, description, examples]
const TAXONOMY: Record<string, [string, string, string, string][]> = {
  Internet: [
    ["การเชื่อมต่อ", "เน็ตหลุดเป็นช่วง", "ใช้งานได้แต่หลุดเป็นระยะ กลับมาใช้ได้เอง", "เน็ตหลุดทุกคืน, ประชุมแล้วหลุด"],
    ["การเชื่อมต่อ", "ไม่มีอินเทอร์เน็ต", "ใช้งานไม่ได้เลยต่อเนื่อง ไม่กลับมาเอง", "เช้านี้ใช้เน็ตไม่ได้ทั้งบ้าน"],
    ["การเชื่อมต่อ", "สัญญาณไฟเบอร์ขาด", "ไฟ LOS แดงหรือสายไฟเบอร์เสียหาย", "ไฟ LOS กะพริบแดง"],
    ["ความเร็ว", "ความเร็วต่ำกว่าแพ็กเกจ", "วัดความเร็วได้ต่ำกว่าที่สมัครอย่างชัดเจน", "สมัคร 1 Gbps วัดได้ 200"],
    ["ความเร็ว", "Wi-Fi ช้า", "ช้าเฉพาะผ่าน Wi-Fi ต่อสาย LAN ปกติ", "ห้องนอนเน็ตช้ามาก"],
    ["ความเร็ว", "เล่นเกมแล้วแลค", "ปิงสูงหรือกระตุกเฉพาะเกมออนไลน์", "เล่นเกมปิงพุ่ง"],
    ["บริการติดตั้ง", "ย้ายจุดติดตั้ง", "ขอย้ายที่อยู่หรือตำแหน่งติดตั้ง", "ย้ายไปบ้านใหม่ปลายเดือน"],
    ["บริการติดตั้ง", "นัดช่างไม่ได้", "ช่างไม่มาตามนัดหรือนัดคิวไม่ได้", "ช่างนัดแล้วไม่มา"],
    ["บริการติดตั้ง", "ติดตั้งใหม่ล่าช้า", "สมัครใหม่แล้วยังไม่ได้ติดตั้งตามกำหนด", "สมัครสองอาทิตย์ยังไม่ติดตั้ง"],
  ],
  IPTV: [
    ["คุณภาพภาพ", "ภาพกระตุก/ค้าง", "ภาพค้างหรือกระตุกระหว่างรับชม", "ดูบอลแล้วภาพค้าง"],
    ["คุณภาพภาพ", "ไม่มีสัญญาณภาพ", "จอดำหรือขึ้นไม่มีสัญญาณ", "เปิดทีวีขึ้นจอดำ"],
    ["คุณภาพภาพ", "เสียงไม่ตรงภาพ", "เสียงมาก่อนหรือหลังภาพ", "เสียงมาก่อนภาพ"],
    ["แอปพลิเคชัน", "เข้าสู่ระบบไม่ได้", "ล็อกอินแอปดูทีวีไม่ผ่าน", "ล็อกอินแล้วขึ้น error"],
    ["แอปพลิเคชัน", "แอปค้าง", "แอปค้างหรือปิดเอง", "แอปเด้งออก"],
    ["แอปพลิเคชัน", "หาช่องไม่เจอ", "หาช่องหรือรายการที่สมัครไม่เจอ", "ช่องกีฬาหายไป"],
  ],
  Mobile: [
    ["บิลและค่าบริการ", "บริการเสริมไม่ได้สมัคร", "ถูกเก็บค่าบริการเสริมที่ไม่ได้สมัคร", "โดนตัดเงินค่าบริการเสริม"],
    ["บิลและค่าบริการ", "ยอดบิลผิด", "ยอดเรียกเก็บไม่ตรงแพ็กเกจ", "บิลสูงกว่าปกติ"],
    ["บิลและค่าบริการ", "ชำระแล้วยังโดนระงับ", "จ่ายแล้วแต่บริการยังถูกระงับ", ""],
    ["สัญญาณ", "สัญญาณอ่อนในอาคาร", "สัญญาณอ่อนเฉพาะในตึกหรือบางชั้น", "ในคอนโดสัญญาณหาย"],
    ["สัญญาณ", "ใช้อินเทอร์เน็ตมือถือไม่ได้", "โทรได้แต่ใช้เน็ตมือถือไม่ได้", "ซิมใหม่ใช้เน็ตไม่ได้"],
    ["สัญญาณ", "โทรแล้วสายหลุด", "", "คุยอยู่สายตัด"],
  ],
  "Fixed Line": [
    ["สายโทรศัพท์", "ไม่มีสัญญาณ", "ยกหูแล้วเงียบ ไม่มีเสียงสัญญาณ", "โทรศัพท์บ้านเงียบ"],
    ["สายโทรศัพท์", "เสียงรบกวน", "มีเสียงซ่าหรือเสียงแทรก", "โทรเข้ามีเสียงซ่า"],
    ["สายโทรศัพท์", "โทรออกต่างประเทศไม่ได้", "โทรในประเทศได้แต่ต่างประเทศไม่ได้", "โทรไปญี่ปุ่นไม่ติด"],
  ],
};

// monthly counts per (service, main category) — Aug, Sep, Oct (from the design)
const VOLUME: Record<string, Record<string, number[]>> = {
  Internet: { "การเชื่อมต่อ": [148, 163, 201], "ความเร็ว": [97, 102, 96], "บริการติดตั้ง": [41, 38, 45] },
  IPTV: { "คุณภาพภาพ": [66, 71, 58], "แอปพลิเคชัน": [29, 35, 52] },
  Mobile: { "บิลและค่าบริการ": [88, 79, 84], "สัญญาณ": [54, 61, 73] },
  "Fixed Line": { "สายโทรศัพท์": [23, 19, 17] },
};

const SERVICE_DEFS: [string, string][] = [["Internet", "#2F6FB0"], ["IPTV", "#7B4FB0"], ["Mobile", "#C2631A"], ["Fixed Line", "#5B6270"]];
const CUSTOMERS = ["คุณสมชาย ก.", "คุณวิภา ส.", "คุณอนันต์ ป.", "คุณนภา ร.", "คุณธนา จ.", "คุณปิยะ ม.", "คุณกมล ท.", "คุณศิริ บ."];
const CHANNELS = ["โทร", "แชต", "อีเมล", "โทร", "แชต"];
const STATUS = ["ปิดแล้ว", "รอดำเนินการ", "กำลังตรวจสอบ", "ส่งช่าง", "รอนัดหมาย"];
const FILLERS = ["ลูกค้าแจ้งว่า", "แจ้งซ้ำจากครั้งก่อน", "ขอให้ติดต่อกลับ", "เป็นตั้งแต่เมื่อวาน", "รีสตาร์ทแล้วไม่หาย"];

const PREVIEW_HEADERS = ["เลขอินซิเดนต์", "วันที่แจ้ง", "ชื่อลูกค้า", "เซอร์วิส", "หัวข้อ", "รายละเอียดปัญหา", "ช่องทาง", "สถานะ"];
const PREVIEW_ROWS = [
  ["INC0102341", "01/10/2569", "คุณสมชาย ก.", "Internet", "เน็ตหลุด", "อินเทอร์เน็ตหลุดทุกคืนช่วงสองทุ่ม รีสตาร์ทเราเตอร์แล้วไม่หาย", "โทร", "ปิดแล้ว"],
  ["INC0102342", "01/10/2569", "คุณวิภา ส.", "IPTV", "ภาพกระตุก", "ดูช่องกีฬาแล้วภาพค้างเป็นช่วงๆ เสียงมาก่อนภาพ", "แชต", "รอดำเนินการ"],
  ["INC0102343", "01/10/2569", "คุณอนันต์ ป.", "Mobile", "บิลผิด", "ค่าบริการเดือนนี้สูงกว่าปกติ มีแพ็กเกจเสริมที่ไม่ได้สมัคร", "โทร", "ปิดแล้ว"],
  ["INC0102344", "02/10/2569", "คุณนภา ร.", "Internet", "ความเร็วต่ำ", "สมัครแพ็กเกจ 1 Gbps แต่วัดผ่าน Wi-Fi ได้ไม่ถึงครึ่ง", "อีเมล", "กำลังตรวจสอบ"],
  ["INC0102345", "02/10/2569", "คุณธนา จ.", "Fixed Line", "โทรออกไม่ได้", "โทรศัพท์บ้านไม่มีสัญญาณ ยกหูแล้วเงียบ", "โทร", "ส่งช่าง"],
  ["INC0102346", "02/10/2569", "คุณปิยะ ม.", "Mobile", "สัญญาณอ่อน", "ในตึกที่ทำงานสัญญาณ 4G ขึ้นแค่ขีดเดียว", "แชต", "รอดำเนินการ"],
  ["INC0102347", "03/10/2569", "คุณกมล ท.", "IPTV", "เข้าแอปไม่ได้", "ล็อกอินแอปดูทีวีแล้วขึ้นข้อความผิดพลาด", "โทร", "ปิดแล้ว"],
  ["INC0102348", "03/10/2569", "คุณศิริ บ.", "Internet", "ย้ายที่ติดตั้ง", "ต้องการย้ายจุดติดตั้งไปบ้านใหม่ปลายเดือน", "โทร", "รอนัดหมาย"],
];
const PREVIEW_ROLES: Role[] = ["ticket", "date", "none", "service", "problem", "problem", "none", "none"];

interface ProjectData {
  project: Project;
  services: Service[];
  taxonomy: TaxonomyRow[];
  tickets: TicketRow[];
}

function buildProject(project: Project, scale: number, seed: number, serviceNames: string[]): ProjectData {
  const r = rng(seed);
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
  const services: Service[] = SERVICE_DEFS.filter(([n]) => serviceNames.includes(n)).map(([name, color], i) => ({
    id: `${project.id}-svc-${i}`, name, color, columns: [...COLS], taxonomyVersion: 1, sort: i,
  }));
  const taxonomy: TaxonomyRow[] = [];
  let code = 1;
  for (const s of services) {
    TAXONOMY[s.name].forEach(([main, sub, description, examples], i) => {
      taxonomy.push({
        id: `${s.id}-t${i}`, serviceId: s.id, code: `C${String(code++).padStart(2, "0")}`,
        values: { [COLS[0]]: main, [COLS[1]]: sub }, description, examples,
      });
    });
  }
  const tickets: TicketRow[] = [];
  let no = 100000 + Math.floor(seed % 5000);
  for (const s of services) {
    for (const [main, counts] of Object.entries(VOLUME[s.name])) {
      const subs = TAXONOMY[s.name].filter((t) => t[0] === main);
      counts.forEach((n, mi) => {
        const month = MONTHS[mi];
        const count = Math.max(1, Math.round(n * scale));
        for (let k = 0; k < count; k++) {
          const [, sub, desc, ex] = pick(subs);
          const day = 1 + Math.floor(r() * 28);
          const date = `${month}-${String(day).padStart(2, "0")}`;
          const roll = r();
          const source = roll < 0.006 ? "error" : roll < 0.03 ? "human" : roll < 0.11 ? "cache" : "ai";
          const conf = source === "error" ? null : source === "human" ? 1 : roll > 0.92 ? 0.45 + r() * 0.24 : 0.72 + r() * 0.27;
          const topic = ex ? ex.split(",")[0].trim() : sub;
          const detail = `${pick(FILLERS)} ${desc || sub}`.trim();
          const ticketNo = `INC0${no++}`;
          const fields = source === "error" ? {} : { [COLS[0]]: main, [COLS[1]]: sub };
          const humanFrom = source === "human" ? subs.find((t) => t[1] !== sub) ?? subs[0] : null;
          tickets.push({
            id: `${project.id}-${ticketNo}`,
            ticketNo,
            date,
            month,
            service: s.name,
            problemText: `หัวข้อ: ${topic}, รายละเอียดปัญหา: ${detail}`,
            fields,
            aiFields: humanFrom ? { [COLS[0]]: humanFrom[0], [COLS[1]]: humanFrom[1] } : source === "error" ? null : { ...fields },
            confidence: conf,
            reason: source === "error" ? "AI ตอบหมวดที่ไม่อยู่ในรายการ 2 ครั้ง" : `ข้อความพูดถึง${sub}`,
            source,
            sourceRow: {
              "เลขอินซิเดนต์": ticketNo,
              "วันที่แจ้ง": `${String(day).padStart(2, "0")}/${month.slice(5)}/${Number(month.slice(0, 4)) + 543}`,
              "ชื่อลูกค้า": pick(CUSTOMERS),
              "เซอร์วิส": s.name,
              "หัวข้อ": topic,
              "รายละเอียดปัญหา": detail,
              "ช่องทาง": pick(CHANNELS),
              "สถานะ": pick(STATUS),
            },
          });
        }
      });
    }
  }
  tickets.sort((a, b) => b.date.localeCompare(a.date) || b.ticketNo.localeCompare(a.ticketNo));
  return { project, services, taxonomy, tickets };
}

export function createMockBackend(): Backend {
  const listeners = new Map<string, Set<Listener>>();
  const emit = <E extends EventName>(e: E, p: EventMap[E]) => listeners.get(e)?.forEach((cb) => cb(p));
  const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
  const gatewayDown = params.get("gateway") === "down";

  let settings: Settings = {
    theme: "light",
    font: "looped",
    userName: "Somchai",
    setupDone: params.get("page") !== "setup",
    gatewayUrl: DEFAULT_GATEWAY_URL,
    model: "godev1",
    concurrency: 8,
    batchSize: 10,
    updateUrl: "",
    autoCheckUpdate: true,
    sidebarCollapsed: false,
    lastProjectId: "cc-a",
    lastTestAt: Date.now() - 86_400_000,
    lastTestOk: true,
    lastTestModel: "godev1",
  };
  let gateway: GatewayInfo = {
    groupName: "Gosoft Agent Gateway",
    url: DEFAULT_GATEWAY_URL,
    defaultUrl: DEFAULT_GATEWAY_URL,
    hasKey: params.get("page") !== "setup",
    keyLast4: params.get("page") !== "setup" ? "x7Kp" : null,
    model: "godev1",
    lastTestAt: settings.lastTestAt,
    lastTestOk: settings.lastTestOk,
  };
  const status = (): GatewayStatus =>
    gatewayDown
      ? { state: "unreachable", message: "ต่อ Gateway ไม่ได้ กรุณาต่อ VPN บริษัทแล้วลองใหม่", checkedAt: Date.now() }
      : { state: "ok", message: null, checkedAt: Date.now() };

  const data: Record<string, ProjectData> = {};
  const lazy = (id: string): ProjectData => {
    if (!data[id]) {
      const p = projects.find((x) => x.id === id);
      if (!p) throw { code: "not_found", message: "ไม่พบโปรเจกต์" };
      // projects created in this session start empty, like a fresh .sqlite
      const def = PROJECT_DEFS[id] ?? { scale: 0, seed: 1, services: [] };
      data[id] = buildProject(p, def.scale, def.seed, def.services);
    }
    return data[id];
  };
  const projects: Project[] = [
    { id: "cc-a", name: "Call Center A", color: "#217346", sort: 0 },
    { id: "cc-b", name: "Call Center B", color: "#B4530A", sort: 1 },
    { id: "noc", name: "NOC Incident", color: "#4A5A7A", sort: 2 },
  ];
  const PROJECT_DEFS: Record<string, { scale: number; seed: number; services: string[] }> = {
    "cc-a": { scale: 1, seed: 17, services: ["Internet", "IPTV", "Mobile", "Fixed Line"] },
    "cc-b": { scale: 0.45, seed: 29, services: ["Internet", "Mobile"] },
    noc: { scale: 0.2, seed: 41, services: ["Internet", "IPTV", "Fixed Line"] },
  };

  // ---------------------------------------------------------------- simulated classification job
  const jobs: Record<string, ClassifyProgress> = {};
  const startJob = (projectId: string) => {
    const total = 4812;
    const done = 2984;
    jobs[projectId] = {
      runId: `run-${projectId}`,
      projectId,
      fileName: "incident_report_oct2026.xlsx",
      patternName: "รีพอร์ตอินซิเดนต์รายเดือน",
      status: "running",
      total,
      done,
      ai: 2516,
      cached: 368,
      low: 97,
      error: 3,
      etaSec: 360,
      concurrency: settings.concurrency,
      recent: [],
    };
  };
  startJob("cc-a");
  const recentFrom = (projectId: string, n: number): RecentItem[] => {
    const t = lazy(projectId).tickets;
    const out: RecentItem[] = [];
    for (let i = 0; i < n; i++) {
      const x = t[Math.floor(Math.random() * t.length)];
      out.push({
        ticketNo: x.ticketNo,
        service: x.service,
        text: x.problemText.replace(/^หัวข้อ: [^,]*, รายละเอียดปัญหา: /, ""),
        category: Object.values(x.fields).join(" › ") || "—",
        low: (x.confidence ?? 1) < 0.7,
        cached: x.source === "cache",
      });
    }
    return out;
  };
  jobs["cc-a"].recent = recentFrom("cc-a", 6);
  setInterval(() => {
    for (const j of Object.values(jobs)) {
      if (j.status !== "running") continue;
      const step = Math.min(j.total - j.done, j.concurrency * 2 + Math.floor(Math.random() * 6));
      j.done += step;
      const cached = Math.round(step * 0.12);
      j.cached += cached;
      j.ai += step - cached;
      if (Math.random() < 0.25) j.low += 1;
      j.etaSec = Math.max(0, Math.round(((j.total - j.done) / Math.max(1, step)) * 0.5));
      j.recent = [...recentFrom(j.projectId, 1), ...j.recent].slice(0, 8);
      if (j.done >= j.total) {
        j.status = "done";
        j.etaSec = 0;
      }
      emit("classify://progress", clone(j));
    }
  }, 500);

  // ---------------------------------------------------------------- helpers
  const inRange = (m: string, from: string, to: string) => m >= from && m <= to;
  const main = (t: TicketRow) => t.fields[COLS[0]] ?? "(ไม่มีหมวด)";

  const usage: UsageSummary = {
    monthLabel: "2026-11",
    spend: 18.4,
    budget: 50,
    tokens: 7_900_000,
    runs: 12,
    budgetResetAt: "2026-12-01T00:00:00Z",
    byProject: [
      { name: "Call Center A", color: "#217346", cost: 11.22 },
      { name: "Call Center B", color: "#B4530A", cost: 4.97 },
      { name: "NOC Incident", color: "#4A5A7A", cost: 2.21 },
    ],
    history: [
      ["2026-11-26T14:12", "Call Center A", "incident_report_oct2026.xlsx", 4812, 368, 2_100_000, 4.86],
      ["2026-11-24T10:40", "Call Center B", "cc_b_oct.csv", 2140, 211, 900_000, 2.07],
      ["2026-11-20T16:05", "NOC Incident", "noc_oct_2026.xlsx", 960, 42, 400_000, 0.94],
      ["2026-11-18T09:31", "Call Center A", "ทดลอง 20 แถว", 20, 0, 10_000, 0.02],
      ["2026-11-12T11:47", "Call Center A", "incident_report_sep2026.xlsx", 4530, 402, 2_000_000, 4.61],
      ["2026-11-05T15:20", "Call Center B", "cc_b_sep.csv", 2288, 190, 1_000_000, 2.29],
    ].map(([at, project, fileName, rows, cached, tokens, cost], i) => ({
      id: `r${i}`, startedAt: new Date(at as string).getTime(), project: project as string, fileName: fileName as string,
      rows: rows as number, cached: cached as number, tokens: tokens as number, cost: cost as number,
    })),
  };
  // ?budget=high (88%) / ?budget=full (97%) preview the orange / red usage bar
  const spendNow = params.get("budget") === "full" ? 48.5 : params.get("budget") === "high" ? 44.2 : 18.4;
  usage.spend = spendNow;
  const keyUsage: KeyUsage = {
    keyAlias: "incask-cc", spend: spendNow, maxBudget: 50, softBudget: 40, budgetDuration: "30d",
    budgetResetAt: "2026-12-01T00:00:00Z", expires: null, tpmLimit: 200_000, rpmLimit: 60, models: [...MODEL_IDS],
  };

  const backend: Backend = {
    mock: true,
    appInfo: async () => ({ version: __APP_VERSION__, dataDir: "%APPDATA%\\IncAsk (mock)", mock: true }),
    getSettings: async () => clone(settings),
    // same rule as Rust merge_settings: URL and test bookkeeping are not changed through saveSettings
    saveSettings: async (s) => {
      await wait(60);
      const keep = settings.lastTestModel === s.model.trim();
      settings = {
        ...clone(s), gatewayUrl: settings.gatewayUrl,
        lastTestAt: keep ? settings.lastTestAt : null, lastTestOk: keep ? settings.lastTestOk : null, lastTestModel: keep ? settings.lastTestModel : null,
      };
      return clone(settings);
    },
    getGateway: async () => clone(gateway),
    setGatewayUrl: async (url) => {
      await wait(150);
      const u = url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
      if (!/^https:\/\/\S+$/.test(u)) throw { code: "invalid_url", message: "Gateway URL ต้องขึ้นต้นด้วย https:// และไม่มีช่องว่าง" };
      gateway = { ...gateway, url: u, lastTestAt: null, lastTestOk: null };
      settings.gatewayUrl = u;
      return clone(gateway);
    },
    resetGatewayUrl: async () => {
      gateway = { ...gateway, url: DEFAULT_GATEWAY_URL, lastTestAt: null, lastTestOk: null };
      settings.gatewayUrl = DEFAULT_GATEWAY_URL;
      return clone(gateway);
    },
    saveApiKey: async (key) => {
      await wait(150);
      const k = key.trim();
      if (!k.startsWith("sk-")) throw { code: "key_format", message: "Key ต้องขึ้นต้นด้วย sk-" };
      if (/\s/.test(k) || k.length < 12) throw { code: "key_format", message: "รูปแบบ Key ไม่ถูกต้อง (ห้ามมีช่องว่าง)" };
      // keep only what the real backend would expose
      gateway = { ...gateway, hasKey: true, keyLast4: k.slice(-4), lastTestAt: null, lastTestOk: null };
      return clone(gateway);
    },
    removeApiKey: async () => { gateway = { ...gateway, hasKey: false, keyLast4: null }; return clone(gateway); },
    gatewayStatus: async () => status(),
    checkGateway: async () => { await wait(400); const s = status(); emit("gateway-status", s); return s; },
    gatewayModels: async () => {
      await wait(500);
      if (gatewayDown) throw { code: "gateway_unreachable", message: "ต่อ Gateway ไม่ได้ กรุณาต่อ VPN บริษัทแล้วลองใหม่" };
      // mock mode needs no API key: the model list and the test pass without one
      return [...MODEL_IDS];
    },
    testGateway: async (model) => {
      await wait(900);
      const m = model ?? settings.model;
      // godev3 simulates a model this key may not use (403), to exercise "pick another model"
      const forbidden = m === "godev3";
      const ok = !gatewayDown && !forbidden;
      gateway = { ...gateway, lastTestAt: Date.now(), lastTestOk: ok };
      settings = { ...settings, lastTestAt: Date.now(), lastTestOk: ok, lastTestModel: m };
      return {
        model: m, ok, reply: ok ? "GOSOFT LITELLM OK" : null, status: ok ? 200 : forbidden ? 403 : null, elapsedMs: 812, unreachable: gatewayDown,
        error: ok ? null : forbidden ? "ไม่มีสิทธิ์ใช้โมเดลนี้ ตรวจสิทธิ์ Model/Policy และชนิดของ Key กับ Admin" : "ต่อ Gateway ไม่ได้ กรุณาต่อ VPN บริษัทแล้วลองใหม่",
      };
    },
    gatewayKeyUsage: async () => (gatewayDown ? null : clone(keyUsage)),
    checkUpdate: async () => { await wait(600); return { available: false, currentVersion: __APP_VERSION__, version: null, notes: null, date: null }; },
    installUpdate: async () => { throw { code: "update_none", message: "ไม่มีเวอร์ชันใหม่" }; },

    listProjects: async () => { await wait(120); return clone(projects); },
    // same rules as db/projects.rs: trimmed + collapsed spaces, 1–60 chars, unique ignoring case
    createProject: async (name, color) => {
      await wait(120);
      const n = cleanName(name);
      if (projects.some((p) => p.name.toLowerCase() === n.toLowerCase())) throw { code: "duplicate_name", message: `มีโปรเจกต์ชื่อ "${n}" อยู่แล้ว` };
      const id = `p-${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`;
      const p: Project = { id, name: n, color: color ?? PROJECT_COLORS[projects.length % PROJECT_COLORS.length], sort: projects.length };
      projects.push(p);
      return clone(p);
    },
    updateProject: async (id, patch) => {
      await wait(100);
      const p = projects.find((x) => x.id === id);
      if (!p) throw { code: "not_found", message: "ไม่พบโปรเจกต์" };
      if (patch.name != null) {
        const n = cleanName(patch.name);
        if (projects.some((x) => x.id !== id && x.name.toLowerCase() === n.toLowerCase())) throw { code: "duplicate_name", message: `มีโปรเจกต์ชื่อ "${n}" อยู่แล้ว` };
        p.name = n;
      }
      if (patch.color != null) p.color = patch.color;
      if (data[id]) data[id].project = p;
      return clone(p);
    },
    deleteProject: async (id) => {
      await wait(150);
      const i = projects.findIndex((x) => x.id === id);
      if (i < 0) throw { code: "not_found", message: "ไม่พบโปรเจกต์" };
      projects.splice(i, 1);
      delete data[id];
      delete jobs[id];
      if (settings.lastProjectId === id) settings.lastProjectId = null;
    },
    listServices: async (projectId) => { await wait(80); return clone(lazy(projectId).services); },
    listTaxonomy: async (projectId, serviceId) => clone(recode(lazy(projectId).taxonomy.filter((t) => t.serviceId === serviceId))),
    // same rules as taxonomy.rs (unique names, non-empty columns/cells, codes by order, version bump)
    createService: async (projectId, name, columns, color) => {
      const d = lazy(projectId);
      const n = name.split(/\s+/).filter(Boolean).join(" ");
      if (!n) throw { code: "invalid_name", message: "ชื่อเซอร์วิสต้องยาว 1–60 ตัวอักษร" };
      if (d.services.some((s) => s.name.toLowerCase() === n.toLowerCase())) throw { code: "duplicate_name", message: `มีเซอร์วิสชื่อ "${n}" อยู่แล้ว` };
      checkColumns(columns);
      const used = d.services.map((s) => s.color);
      const s: Service = { id: `s-${Math.random().toString(16).slice(2, 14)}`, name: n, color: color ?? SERVICE_COLORS.find((c) => !used.includes(c)) ?? SERVICE_COLORS[0], columns: columns.map((c) => c.trim()), taxonomyVersion: 1, sort: d.services.length };
      d.services.push(s);
      return clone(s);
    },
    updateService: async (projectId, id, patch) => {
      const d = lazy(projectId);
      const s = d.services.find((x) => x.id === id);
      if (!s) throw { code: "not_found", message: "ไม่พบเซอร์วิส" };
      if (patch.name != null) {
        const n = patch.name.split(/\s+/).filter(Boolean).join(" ");
        if (!n) throw { code: "invalid_name", message: "ชื่อเซอร์วิสต้องยาว 1–60 ตัวอักษร" };
        if (d.services.some((x) => x.id !== id && x.name.toLowerCase() === n.toLowerCase())) throw { code: "duplicate_name", message: `มีเซอร์วิสชื่อ "${n}" อยู่แล้ว` };
        d.tickets.forEach((t) => { if (t.service === s.name) t.service = n; });
        s.name = n;
      }
      if (patch.color != null) s.color = patch.color;
      return clone(s);
    },
    deleteService: async (projectId, id) => {
      const d = lazy(projectId);
      d.services = d.services.filter((s) => s.id !== id);
      d.taxonomy = d.taxonomy.filter((t) => t.serviceId !== id);
    },
    setServiceColumns: async (projectId, id, specs) => {
      const d = lazy(projectId);
      const s = d.services.find((x) => x.id === id);
      if (!s) throw { code: "not_found", message: "ไม่พบเซอร์วิส" };
      const names = specs.map((c) => c.name.trim());
      checkColumns(names);
      const remap = (v: Record<string, string>) => Object.fromEntries(specs.map((c, i) => [names[i], c.from ? v[c.from] ?? "" : ""]));
      d.taxonomy.filter((t) => t.serviceId === id).forEach((t) => { t.values = remap(t.values); });
      d.tickets.filter((t) => t.service === s.name).forEach((t) => { t.fields = remap(t.fields); if (t.aiFields) t.aiFields = remap(t.aiFields); });
      s.columns = names;
      s.taxonomyVersion++;
      return clone(s);
    },
    saveTaxonomyRow: async (projectId, serviceId, row) => {
      const d = lazy(projectId);
      const s = d.services.find((x) => x.id === serviceId);
      if (!s) throw { code: "not_found", message: "ไม่พบเซอร์วิส" };
      const values: Record<string, string> = {};
      for (const c of s.columns) {
        const v = (row.values[c] ?? "").trim();
        if (!v) throw { code: "invalid_row", message: `ช่อง "${c}" ว่าง` };
        values[c] = v;
      }
      const same = (a: Record<string, string>) => s.columns.every((c) => (a[c] ?? "") === values[c]);
      const rows = d.taxonomy.filter((t) => t.serviceId === serviceId);
      if (rows.some((t) => t.id !== row.id && same(t.values))) throw { code: "duplicate_row", message: "มีหมวดนี้อยู่แล้ว" };
      let t = row.id ? d.taxonomy.find((x) => x.id === row.id) : undefined;
      if (t) {
        const old = t.values;
        d.tickets.filter((x) => x.service === s.name && s.columns.every((c) => x.fields[c] === old[c])).forEach((x) => { x.fields = { ...values }; });
        Object.assign(t, { values, description: row.description.trim(), examples: row.examples.trim() });
      } else {
        t = { id: `t-${Math.random().toString(16).slice(2, 14)}`, serviceId, code: "", values, description: row.description.trim(), examples: row.examples.trim() };
        d.taxonomy.push(t);
      }
      s.taxonomyVersion++;
      return clone(recode(d.taxonomy.filter((x) => x.serviceId === serviceId)).find((x) => x.id === t!.id)!);
    },
    taxonomyRowUsage: async (projectId, rowId) => {
      const d = lazy(projectId);
      const t = d.taxonomy.find((x) => x.id === rowId);
      const s = d.services.find((x) => x.id === t?.serviceId);
      if (!t || !s) return 0;
      return d.tickets.filter((x) => x.service === s.name && s.columns.every((c) => x.fields[c] === t.values[c])).length;
    },
    deleteTaxonomyRow: async (projectId, rowId, moveTo) => {
      const d = lazy(projectId);
      const t = d.taxonomy.find((x) => x.id === rowId);
      const s = d.services.find((x) => x.id === t?.serviceId);
      if (!t || !s) throw { code: "not_found", message: "ไม่พบหมวดนี้" };
      const target = moveTo ? d.taxonomy.find((x) => x.id === moveTo) : null;
      const hit = d.tickets.filter((x) => x.service === s.name && s.columns.every((c) => x.fields[c] === t.values[c]));
      hit.forEach((x) => {
        if (target) { x.fields = { ...target.values }; x.source = "human"; } else { x.fields = {}; x.source = "error"; x.confidence = null; }
      });
      d.taxonomy = d.taxonomy.filter((x) => x.id !== rowId);
      s.taxonomyVersion++;
      return hit.length;
    },
    previewTaxonomyImport: async (projectId, path) => {
      await wait(300);
      const d = lazy(projectId);
      const fileName = path.split(/[\\/]/).pop() ?? path;
      const mk = (name: string, rows: [string, string, string][]) => ({
        name, exists: d.services.some((s) => s.name === name), existingRows: d.taxonomy.filter((t) => d.services.find((s) => s.name === name)?.id === t.serviceId).length,
        columns: [...COLS], rows: rows.map(([a, b, desc]) => ({ id: null, values: { [COLS[0]]: a, [COLS[1]]: b }, description: desc, examples: "" })), errors: [] as { row: number; message: string }[], warnings: [] as { row: number; message: string }[],
      });
      const smart = mk("Smart Home", [["อุปกรณ์", "กล้องออฟไลน์", "กล้องวงจรปิดขึ้นออฟไลน์"], ["อุปกรณ์", "เซ็นเซอร์ไม่ทำงาน", ""], ["แอปพลิเคชัน", "แจ้งเตือนไม่เด้ง", "ไม่ได้รับการแจ้งเตือนในแอป"]]);
      smart.warnings.push({ row: 4, message: "อุปกรณ์ › เซ็นเซอร์ไม่ทำงาน ไม่มีคำอธิบาย · AI อาจจัดได้แม่นน้อยลง" });
      smart.errors.push({ row: 6, message: "ช่อง \"หัวข้อย่อย\" ว่าง — ไม่นำเข้าแถวนี้" });
      const mobile = mk("Mobile", TAXONOMY.Mobile.map(([a, b, c]) => [a, b, c] as [string, string, string]));
      return { fileName, services: [mobile, smart] };
    },
    applyTaxonomyImport: async (projectId, path, service) => {
      const prev = await backend.previewTaxonomyImport(projectId, path, service);
      const d = lazy(projectId);
      const out: Service[] = [];
      for (const sp of prev.services) {
        let s = d.services.find((x) => x.name === sp.name);
        if (!s) s = await backend.createService(projectId, sp.name, sp.columns);
        const svc = d.services.find((x) => x.id === s!.id)!;
        d.taxonomy = d.taxonomy.filter((t) => t.serviceId !== svc.id);
        sp.rows.forEach((r, i) => d.taxonomy.push({ id: `t-${svc.id}-${i}-${Date.now()}`, serviceId: svc.id, code: "", values: r.values, description: r.description, examples: r.examples }));
        svc.columns = [...sp.columns];
        svc.taxonomyVersion++;
        out.push(clone(svc));
      }
      return out;
    },
    saveTaxonomyTemplate: async () => { await wait(200); },

    previewImport: async (projectId): Promise<ImportPreview> => {
      lazy(projectId);
      await wait(250);
      return {
        fileName: "incident_report_oct2026.xlsx", sheet: "Sheet1", sheets: ["Sheet1"], headers: [...PREVIEW_HEADERS],
        rows: clone(PREVIEW_ROWS), rowCount: 4812, pattern: projectId === "cc-a" ? null : { id: "p1", name: "รีพอร์ตอินซิเดนต์รายเดือน" },
        roles: [...PREVIEW_ROLES],
      };
    },
    importSummary: async (projectId, roles) => {
      const known = new Set(lazy(projectId).services.map((s) => s.name));
      const svcIdx = roles.indexOf("service");
      const counts: Record<string, number> = {};
      if (svcIdx >= 0) PREVIEW_ROWS.forEach((r) => { counts[r[svcIdx]] = (counts[r[svcIdx]] ?? 0) + 1; });
      const services = Object.entries(counts).map(([name, n]) => ({ name, known: known.has(name), count: Math.round((n / PREVIEW_ROWS.length) * 4800) }));
      if (svcIdx >= 0) services.push({ name: "Smart Home", known: false, count: 12 });
      const hasDate = roles.includes("date");
      return {
        dateFrom: hasDate ? "2026-10-01" : null, dateTo: hasDate ? "2026-10-31" : null, months: hasDate ? ["2026-10"] : [],
        duplicates: roles.includes("ticket") ? 37 : 0, invalid: 2, services,
      };
    },

    classifyStatus: async (projectId) => (jobs[projectId] ? clone(jobs[projectId]) : null),
    pauseClassify: async (runId) => { const j = Object.values(jobs).find((x) => x.runId === runId); if (j) { j.status = "paused"; emit("classify://progress", clone(j)); } },
    resumeClassify: async (runId) => { const j = Object.values(jobs).find((x) => x.runId === runId); if (j) { j.status = "running"; emit("classify://progress", clone(j)); } },
    cancelClassify: async (runId) => { const j = Object.values(jobs).find((x) => x.runId === runId); if (j) { j.status = "cancelled"; emit("classify://progress", clone(j)); } },

    queryResults: async (projectId, q) => {
      await wait(120);
      const s = (q.search ?? "").trim().toLowerCase();
      const all = lazy(projectId).tickets.filter((t) =>
        (!q.service || t.service === q.service) &&
        (!q.month || t.month === q.month) &&
        (!q.lowOnly || (t.confidence != null && t.confidence < 0.7 && t.source !== "human")) &&
        (!q.errorOnly || t.source === "error") &&
        (!s || t.ticketNo.toLowerCase().includes(s) || t.problemText.toLowerCase().includes(s)),
      );
      const lowCount = lazy(projectId).tickets.filter((t) => t.confidence != null && t.confidence < 0.7 && t.source !== "human").length;
      return { total: all.length, lowCount, rows: clone(all.slice(q.offset, q.offset + q.limit)) };
    },
    projectMonths: async (projectId) => [...new Set(lazy(projectId).tickets.map((t) => t.month))].sort(),
    pivot: async (projectId, from, to) => {
      await wait(100);
      const d = lazy(projectId);
      const months = MONTHS.filter((m) => inRange(m, from, to));
      const groups: PivotGroup[] = d.services.map((s) => {
        const leaves = new Map<string, number[]>();
        for (const t of d.tickets) {
          if (t.service !== s.name || !months.includes(t.month)) continue;
          const k = main(t);
          if (!leaves.has(k)) leaves.set(k, months.map(() => 0));
          leaves.get(k)![months.indexOf(t.month)]++;
        }
        const children = [...leaves.entries()].map(([key, values]) => ({ key, values, total: values.reduce((a, b) => a + b, 0) }))
          .sort((a, b) => b.total - a.total);
        const values = months.map((_, i) => children.reduce((a, c) => a + c.values[i], 0));
        return { key: s.name, color: s.color, values, total: values.reduce((a, b) => a + b, 0), children };
      }).sort((a, b) => b.total - a.total);
      const grand = months.map((_, i) => groups.reduce((a, g) => a + g.values[i], 0));
      return { months, groups, grand, grandTotal: grand.reduce((a, b) => a + b, 0) };
    },
    drill: async (projectId, cell: DrillCell, from, to) => {
      await wait(80);
      const rows = lazy(projectId).tickets.filter((t) =>
        t.service === cell.service && inRange(t.month, from, to) && (!cell.month || t.month === cell.month) && (cell.category == null || main(t) === cell.category));
      return { total: rows.length, rows: clone(rows.slice(0, 50)) };
    },
    savedViews: async () => [
      { id: "v1", name: "รายงานประจำเดือน" },
      { id: "v2", name: "แนวโน้มรายเดือน" },
      { id: "v3", name: "เฉพาะ Internet" },
    ],
    usageSummary: async () => { await wait(150); return clone(usage); },
    pickFile: async () => "C:\\Users\\me\\Downloads\\incident_report_oct2026.xlsx",
    pickSavePath: async (name) => `C:\\Users\\me\\Downloads\\${name}`,
    on: async (event, cb) => {
      const set = listeners.get(event) ?? new Set();
      set.add(cb as Listener);
      listeners.set(event, set);
      return () => set.delete(cb as Listener);
    },
  };
  return backend;
}
