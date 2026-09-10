//! Primitives partagées : la structure canonique de tokens, la lecture
//! incrémentale des journaux, et les quelques conversions de dates.

use chrono::{Datelike, Local, TimeZone};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Somme de tokens : structure canonique unique dans toute l'application.
///
/// Sérialisée en `camelCase` parce que l'interface la lit telle quelle —
/// `tokens.cacheRead`, `tokens.cacheWrite5m`. La frontière avec le renderer
/// est la seule raison de cette convention ; ailleurs, c'est du Rust normal.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Tokens {
    pub input: i64,
    pub output: i64,
    pub cache_write: i64,
    pub cache_write5m: i64,
    pub cache_write1h: i64,
    pub cache_read: i64,
    pub thinking: i64,
    pub total: i64,
}

impl Tokens {
    pub fn empty() -> Self {
        Self::default()
    }

    /// Construit la part « écriture de cache » en répartissant sur les deux
    /// TTL facturés.
    ///
    /// `cache_write` est le TOTAL écrit — il sert au volume et à l'affichage,
    /// et n'est jamais tarifé pour lui-même. Seuls `cache_write5m` et
    /// `cache_write1h` le sont. Un fournisseur qui ne détaille pas les TTL ne
    /// renvoie qu'un total : on l'attribue alors au 5 minutes, le tarif le
    /// plus courant, plutôt que de le perdre.
    ///
    /// La règle vit ici, et pas dans le calcul du coût, pour une raison
    /// précise : dans le calcul, elle ne saurait pas distinguer « pas de
    /// TTL 5 min » de « zéro token en TTL 5 min », et facturerait une seconde
    /// fois les écritures en TTL 1 heure pur.
    pub fn split_cache_write(total: i64, w5m: i64, w1h: i64) -> (i64, i64, i64) {
        let total = if total != 0 { total } else { w5m + w1h };
        if w5m != 0 || w1h != 0 {
            (total, w5m, w1h)
        } else {
            (total, total, 0)
        }
    }

    /// Accumule `other` dans `self`, champ à champ.
    ///
    /// `total` est un champ comme les autres et n'est JAMAIS recalculé ici :
    /// il vient du fournisseur, qui seul sait ce qu'il a facturé. Le déduire
    /// d'une somme reviendrait à compter deux fois les tokens de cache, qui
    /// sont déjà comptés dans leurs propres champs.
    pub fn add(&mut self, other: &Tokens) -> &mut Self {
        self.input += other.input;
        self.output += other.output;
        self.cache_write += other.cache_write;
        self.cache_write5m += other.cache_write5m;
        self.cache_write1h += other.cache_write1h;
        self.cache_read += other.cache_read;
        self.thinking += other.thinking;
        self.total += other.total;
        self
    }
}

impl std::ops::AddAssign<&Tokens> for Tokens {
    fn add_assign(&mut self, other: &Tokens) {
        self.add(other);
    }
}

/// Clé de jour LOCALE `YYYY-MM-DD`, et non UTC : l'utilisateur raisonne en
/// jours locaux, et un rapport journalier décalé de deux heures est un rapport
/// faux pour qui vit à l'est de Greenwich.
pub fn day_key(ts_ms: i64) -> String {
    let dt = Local
        .timestamp_millis_opt(ts_ms)
        .single()
        .unwrap_or_else(|| Local.timestamp_millis_opt(0).unwrap());
    format!("{:04}-{:02}-{:02}", dt.year(), dt.month(), dt.day())
}

/// Instant présent en millisecondes depuis l'époque.
pub fn now_ms() -> i64 {
    Local::now().timestamp_millis()
}

/// Fenêtre glissante : borne inférieure en ms pour `hours` heures en arrière.
pub fn since(hours: f64, now_ms: i64) -> i64 {
    now_ms - (hours * 3_600_000.0) as i64
}

pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// Nom de projet lisible à partir d'un chemin de travail.
pub fn project_name(cwd: &str) -> Option<String> {
    if cwd.is_empty() {
        return None;
    }
    let base = Path::new(cwd)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    Some(if base.is_empty() {
        cwd.to_string()
    } else {
        base.to_string()
    })
}

const MAX_DEPTH: usize = 8;

/// Parcours récursif, tolérant aux permissions refusées et aux liens cassés.
///
/// Un dossier illisible n'est pas une erreur : sur une machine réelle, il y en
/// a toujours un. On l'ignore et on continue plutôt que d'abandonner tout le
/// balayage pour un `~/Library` verrouillé.
pub fn walk_files<F>(dir: &Path, filter: &F) -> Vec<PathBuf>
where
    F: Fn(&Path) -> bool,
{
    let mut out = Vec::new();
    walk_into(dir, filter, &mut out, 0);
    out
}

fn walk_into<F>(dir: &Path, filter: &F, out: &mut Vec<PathBuf>, depth: usize)
where
    F: Fn(&Path) -> bool,
{
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => walk_into(&path, filter, out, depth + 1),
            Ok(ft) if ft.is_file() && filter(&path) => out.push(path),
            _ => {}
        }
    }
}

/// Résultat d'une lecture incrémentale.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadResult {
    /// Nouvel offset, positionné au DÉBUT de la dernière ligne incomplète.
    pub offset: u64,
    /// Faux si le fichier n'a pas pu être lu du tout.
    pub ok: bool,
    /// Vrai si rien n'a bougé depuis la dernière passe.
    pub unchanged: bool,
}

/// Lit un fichier JSONL à partir d'un offset en octets et n'appelle
/// `on_record` que sur les lignes COMPLÈTES.
///
/// L'offset rendu se positionne au début de la dernière ligne incomplète :
/// indispensable, car Claude Code écrit dans ces fichiers pendant qu'on les
/// lit, et reprendre au milieu d'un objet JSON perdrait l'enregistrement.
///
/// Le découpage se fait sur les OCTETS, pas sur une chaîne décodée. La lecture
/// s'arrête à une frontière arbitraire, qui tombe volontiers au milieu d'un
/// caractère multi-octets ; décoder d'abord y planterait un caractère de
/// remplacement. Ici, chaque ligne complète est décodée pour elle-même, et une
/// ligne invalide est sautée comme n'importe quelle ligne corrompue.
pub fn read_jsonl_from<F>(file: &Path, offset: u64, mut on_record: F) -> ReadResult
where
    F: FnMut(&serde_json::Value),
{
    let Ok(meta) = fs::metadata(file) else {
        return ReadResult {
            offset,
            ok: false,
            unchanged: false,
        };
    };
    let size = meta.len();
    // Fichier tronqué ou remplacé : on repart du début plutôt que de lire
    // depuis un offset qui ne veut plus rien dire.
    let mut offset = if size < offset { 0 } else { offset };
    if size == offset {
        return ReadResult {
            offset,
            ok: true,
            unchanged: true,
        };
    }

    let Ok(mut fh) = fs::File::open(file) else {
        return ReadResult {
            offset,
            ok: false,
            unchanged: false,
        };
    };
    if fh.seek(SeekFrom::Start(offset)).is_err() {
        return ReadResult {
            offset,
            ok: false,
            unchanged: false,
        };
    }
    let mut buf = Vec::with_capacity((size - offset) as usize);
    if fh.take(size - offset).read_to_end(&mut buf).is_err() {
        return ReadResult {
            offset,
            ok: false,
            unchanged: false,
        };
    }

    let mut consumed = 0usize;
    for line in buf.split_inclusive(|b| *b == b'\n') {
        // Pas de saut de ligne final : la ligne est incomplète, on s'arrête là
        // et on la relira entière à la prochaine passe.
        if line.last() != Some(&b'\n') {
            break;
        }
        consumed += line.len();
        let trimmed = &line[..line.len() - 1];
        if trimmed.iter().all(|b| b.is_ascii_whitespace()) {
            continue;
        }
        // Ligne corrompue, partielle ou mal encodée : on la saute sans casser
        // l'indexation de tout le fichier.
        if let Ok(text) = std::str::from_utf8(trimmed) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(text) {
                on_record(&value);
            }
        }
    }

    offset += consumed as u64;
    ReadResult {
        offset,
        ok: true,
        unchanged: false,
    }
}

/// Agent HTTP avec le seul réglage qui compte pour un collecteur : une
/// requête qui ne répond jamais ne doit pas bloquer un cycle indéfiniment.
pub fn ureq_agent(timeout: std::time::Duration) -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(timeout).build()
}

/// Horodatage tel qu'une API JSON le rend, sous n'importe laquelle des deux
/// formes usuelles : un nombre en secondes ou en millisecondes (au-delà de
/// 1e11, c'est déjà des millisecondes), ou une chaîne RFC 3339.
pub fn parse_flexible_ts(v: &serde_json::Value) -> Option<i64> {
    match v {
        serde_json::Value::Number(n) => {
            let f = n.as_f64()?;
            Some(if f > 1e11 {
                f as i64
            } else {
                (f * 1000.0) as i64
            })
        }
        serde_json::Value::String(s) => chrono::DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|d| d.timestamp_millis()),
        _ => None,
    }
}
