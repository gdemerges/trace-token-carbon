//! Traduction.
//!
//! Les catalogues restent les mêmes fichiers JSON que ceux de la version JS —
//! une seule source, deux consommateurs. Ils sont embarqués dans le binaire :
//! une application de barre d'état qui irait chercher ses libellés sur le
//! disque échouerait sur un paquet mal installé, et une clé manquante est déjà
//! gérée plus bas.
//!
//! Trois partis pris repris tels quels de la version d'origine :
//!
//!  1. Une clé absente s'affiche telle quelle plutôt que de casser l'écran. Un
//!     écran qui montre `gauges.empty` est réparable, un écran blanc non.
//!  2. Le français est la langue de référence et le repli.
//!  3. Le pluriel suit la règle la plus simple qui couvre les deux langues :
//!     une forme au singulier, une au pluriel, choisies sur `n`. Le français
//!     met zéro au singulier, l'anglais au pluriel — d'où `plural_zero` porté
//!     par le catalogue plutôt que codé ici.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};

const FR: &str = include_str!("../../../src/i18n/fr.json");
const EN: &str = include_str!("../../../src/i18n/en.json");

pub const DEFAULT_LOCALE: &str = "fr";
pub const SUPPORTED: [&str; 2] = ["fr", "en"];

fn catalog(locale: &str) -> HashMap<String, Value> {
    let raw = if locale == "en" { EN } else { FR };
    serde_json::from_str(raw).expect("catalogue de traductions valide")
}

static CATALOGS: LazyLock<HashMap<&'static str, HashMap<String, Value>>> =
    LazyLock::new(|| HashMap::from([("fr", catalog("fr")), ("en", catalog("en"))]));

/// Langue courante du processus.
///
/// État global assumé, exactement comme dans la version JS : l'alternative —
/// passer un contexte de traduction à travers une trentaine de signatures du
/// cœur, des collecteurs et des jauges — coûterait beaucoup pour une valeur
/// qui ne change qu'au réglage et vaut pour toute l'application.
static CURRENT: LazyLock<RwLock<&'static str>> = LazyLock::new(|| RwLock::new(DEFAULT_LOCALE));

/// Choisit la langue : le réglage explicite l'emporte, sinon celle du système,
/// sinon le français.
pub fn resolve_locale(configured: Option<&str>, system: Option<&str>) -> &'static str {
    let pick = |s: &str| -> Option<&'static str> {
        let want = s.get(..2).unwrap_or("").to_lowercase();
        SUPPORTED.into_iter().find(|l| *l == want)
    };
    if let Some(c) = configured.filter(|c| *c != "auto") {
        if let Some(l) = pick(c) {
            return l;
        }
    }
    system.and_then(pick).unwrap_or(DEFAULT_LOCALE)
}

pub fn set_locale(locale: &str) {
    let resolved = resolve_locale(Some(locale), None);
    if let Ok(mut cur) = CURRENT.write() {
        *cur = resolved;
    }
}

pub fn current_locale() -> &'static str {
    CURRENT.read().map(|c| *c).unwrap_or(DEFAULT_LOCALE)
}

/// Le catalogue brut de la langue demandée, tel qu'il part vers l'interface.
pub fn catalog_json(locale: &str) -> Value {
    serde_json::from_str(if locale == "en" { EN } else { FR })
        .expect("catalogue de traductions valide")
}

fn interpolate(template: &str, params: &[(&str, String)]) -> String {
    if params.is_empty() {
        return template.to_string();
    }
    let mut out = template.to_string();
    for (k, v) in params {
        out = out.replace(&format!("{{{k}}}"), v);
    }
    out
}

/// Traduit une clé, sans paramètre.
pub fn t(key: &str) -> String {
    tp(key, &[])
}

/// Traduit une clé avec paramètres. `n`, s'il est présent et numérique,
/// sélectionne aussi la forme plurielle.
pub fn tp(key: &str, params: &[(&str, String)]) -> String {
    let locale = current_locale();
    let Some(cat) = CATALOGS.get(locale) else {
        return key.to_string();
    };
    let Some(entry) = cat.get(key) else {
        return key.to_string();
    };

    let template = match entry {
        Value::String(s) => s.as_str(),
        Value::Object(map) => {
            let n = params
                .iter()
                .find(|(k, _)| *k == "n")
                .and_then(|(_, v)| v.parse::<f64>().ok());
            let zero_is_plural = map.get("plural_zero").and_then(Value::as_bool) != Some(false);
            // Le français met zéro au singulier, l'anglais au pluriel : le
            // choix est porté par le catalogue, pas codé ici.
            let plural = n.is_some_and(|n| {
                if n == 0.0 {
                    zero_is_plural
                } else {
                    n.abs() > 1.0
                }
            });
            let form = if plural { "other" } else { "one" };
            match map.get(form).and_then(Value::as_str) {
                Some(s) => s,
                None => return key.to_string(),
            }
        }
        _ => return key.to_string(),
    };

    interpolate(template, params)
}

/// Raccourci d'écriture pour les appels à un seul paramètre.
pub fn t1(key: &str, name: &str, value: impl ToString) -> String {
    tp(key, &[(name, value.to_string())])
}
