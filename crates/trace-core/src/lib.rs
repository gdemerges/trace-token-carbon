//! Cœur de TRACE.
//!
//! Ce crate ne connaît ni fenêtre, ni barre d'état, ni Tauri. Il lit des
//! fichiers, résout des modèles, calcule des coûts et des empreintes, et rend
//! des structures. C'est cette frontière — tenue depuis la version Electron —
//! qui permet de l'éprouver sur les trois systèmes sans interface, et au CLI
//! d'exister sans rien dupliquer.

pub mod models;
pub mod pricing;
pub mod util;

pub use models::{resolve_model, Model, CACHE_MULTIPLIERS};
pub use pricing::{cost, cost_without_cache};
pub use util::Tokens;
