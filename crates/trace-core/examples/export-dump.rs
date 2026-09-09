//! Vidage de l'export CSV, pour la comparaison différentielle. Non distribué.

use trace_core::aggregate::{export_rows, methodology_rows, to_csv, Options};
use trace_core::collectors::{claude_code, CollectorState};

const TO: i64 = 1_788_900_000_000;

fn main() {
    let dir = std::env::var("TRACE_CC_DIR").ok();
    let collected = claude_code::collect(dir.as_deref(), &CollectorState::default());
    let opts = Options { from: Some(TO - 30 * 86_400_000), to: Some(TO), ..Options::default() };
    print!("{}", to_csv(&export_rows(&collected.events, &opts)));
    println!();
    print!("{}", to_csv(&methodology_rows(Some("us-average"))));
}
