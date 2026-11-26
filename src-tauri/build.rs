fn main() {
    // The HTML report page is built by `npm run build:report` (Vite, report/). Leave a placeholder
    // so a fresh checkout still compiles and runs `cargo test`; exporting tells the user to build it.
    let report = std::path::Path::new("resources").join("report.html");
    if !report.exists() {
        let _ = std::fs::create_dir_all("resources");
        let _ = std::fs::write(&report, "<!doctype html><title>IncAsk</title><p>ยังไม่ได้ build รายงาน — รัน npm run build:report</p>\n");
    }
    println!("cargo:rerun-if-changed=resources/report.html");
    tauri_build::build()
}
