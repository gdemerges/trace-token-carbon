//! Vide l'instantané complet, tel qu'il part vers l'interface. C'est la
//! frontière que les vidages précédents ne voyaient pas : ils lisaient les
//! structures Rust, pas le JSON qu'elles produisent.

use trace_core::core::{self, SnapshotOptions};

fn main() {
    let state = core::refresh(trace_core::store::load_config(), false);
    let snap = core::snapshot(
        &state,
        &SnapshotOptions {
            days: Some(30),
            ..Default::default()
        },
    );
    println!("{}", serde_json::to_string(&snap).unwrap());
}
