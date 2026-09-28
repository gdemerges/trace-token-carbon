//! Le rapport carbone en Markdown, tel que l'app l'écrit.

use trace_core::core::{self, SnapshotOptions};

pub fn run() {
    let state = core::refresh(trace_core::store::load_config(), false);
    let snap = core::snapshot(
        &state,
        &SnapshotOptions {
            days: Some(30),
            ..Default::default()
        },
    );
    print!("{}", trace_core::report_md::carbon_report(&snap));
}
