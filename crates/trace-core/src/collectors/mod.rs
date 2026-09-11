//! Les sources de données, et ce qu'elles produisent.
//!
//! Un collecteur lit ce qui existe déjà sur la machine — journaux de clients,
//! ou API du fournisseur — et rend des événements dans une forme unique. Aucun
//! ne demande de mot de passe, aucun n'envoie quoi que ce soit ailleurs.

pub mod anthropic_oauth;
pub mod billing;
pub mod claude_code;
pub mod codex_cli;

use crate::util::Tokens;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Un relevé de consommation, l'unité que tout le reste agrège.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    /// Millisecondes depuis l'époque.
    pub ts: i64,
    pub source: String,
    pub model: String,
    pub project: Option<String>,
    pub session: Option<String>,
    pub tokens: Tokens,
    pub requests: i64,
    /// Marque posée par la compaction : un agrégat journalier déjà replié ne
    /// doit pas l'être une seconde fois.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub compacted: Option<String>,
}

/// L'état réel d'une limite de débit, tel que le fournisseur le rapporte.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quota {
    pub source: String,
    pub ts: i64,
    #[serde(rename = "type")]
    pub kind: String,
    pub status: Option<String>,
    pub resets_at: i64,
    pub using_overage: bool,
    /// La CAUSE réelle du refus, qui n'est pas toujours la fenêtre citée.
    pub cause: Cause,
    /// Taux d'occupation communiqué par le fournisseur. Quand il est là, il
    /// tranche : aucune reconstruction locale ne fait mieux que le serveur.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<f64>,
    /// Durée de la fenêtre, telle que le fournisseur la déclare. Codex la
    /// donne, et elle a déjà changé — d'où le libellé dérivé de la durée
    /// plutôt que d'une liste figée.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_minutes: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
}

impl Quota {
    /// Un relevé de refus, tel que le produit un collecteur de journaux.
    pub fn rejection(source: &str, ts: i64, kind: &str, resets_at: i64, cause: Cause) -> Self {
        Self {
            source: source.to_string(),
            ts,
            kind: kind.to_string(),
            status: None,
            resets_at,
            using_overage: false,
            cause,
            used_percent: None,
            window_minutes: None,
            plan: None,
        }
    }
}

/// Ce qui a réellement bloqué une requête.
///
/// `rateLimitType` vaut toujours « five_hour » : il désigne la fenêtre dont on
/// rapporte l'heure de réinitialisation, PAS ce qui a bloqué. Sur un poste
/// réel, deux refus sur trois viennent d'un plafond de dépense mensuel. Les
/// confondre revient à calibrer la jauge 5 h sur un événement étranger.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Cause {
    Spend,
    Weekly,
    Window,
    Unknown,
}

/// L'état d'indexation d'un collecteur, persisté entre deux passages.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FileCursor {
    pub offset: u64,
    /// Fenêtre glissante des identifiants déjà vus, bornée : les réécritures
    /// de streaming sont adjacentes dans le fichier, garder tout l'historique
    /// des identifiants ne servirait à rien.
    #[serde(default)]
    pub seen: Vec<String>,
    // Le modèle, le projet et la session n'apparaissent qu'en tête de fichier
    // Codex. En lecture incrémentale on ne les reverra jamais : ils voyagent
    // donc avec l'offset, sans quoi tout ce qui suit une reprise serait
    // attribué à « codex » sans projet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CollectorState {
    #[serde(default)]
    pub files: HashMap<String, FileCursor>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub files: usize,
    pub events: usize,
    pub skipped_duplicates: usize,
}

#[derive(Debug, Default)]
pub struct Collected {
    pub events: Vec<Event>,
    pub quota: Vec<Quota>,
    pub state: CollectorState,
    pub stats: Stats,
    /// Rempli par le seul collecteur qui interroge le réseau : l'interface a
    /// besoin de dire POURQUOI un chiffre ne bouge pas, et la cadence normale
    /// n'est pas une panne.
    pub live: Option<anthropic_oauth::LiveStats>,
    /// Le coût facturé, quand une clé Admin permet de le lire. C'est la seule
    /// vérification externe du chiffre estimé localement.
    pub cost: Option<billing::CostReport>,
    /// Ce qui a échoué sans empêcher le reste de remonter.
    pub errors: Vec<String>,
}

/// Taille de la fenêtre de déduplication, en identifiants.
pub const DEDUP_WINDOW: usize = 500;

/// Analyse un horodatage ISO 8601, en millisecondes depuis l'époque.
///
/// Rend `None` plutôt qu'une date par défaut : un événement mal daté fausse
/// silencieusement toutes les fenêtres glissantes, alors que l'appelant sait,
/// lui, s'il vaut mieux le rattacher à maintenant ou l'écarter.
pub fn parse_ts(raw: Option<&str>) -> Option<i64> {
    let raw = raw?;
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|d| d.timestamp_millis())
}

/// Ce qu'une source rapporte d'elle-même à l'interface.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    pub id: String,
    pub label: String,
    pub provides_tokens: bool,
    pub enabled: bool,
    pub available: bool,
    /// Total indexé pour cette source, toutes périodes confondues. Posé par
    /// `snapshot` : un collecteur reprend à un offset, et afficher son delta
    /// donnerait « Claude Code — 4 » sur une base de 6 000.
    pub events: usize,
    /// Ce que CE passage a remonté. C'est un delta, et il se lit comme tel.
    pub new_events: usize,
    /// Ce qui tombe dans la période affichée. C'est ce chiffre-là qui répond à
    /// « qu'est-ce que je regarde », et non le total indexé.
    pub events_in_range: usize,
    pub quota: usize,
    pub error: Option<String>,
    pub note: Option<String>,
    pub stats: Stats,
}

impl SourceStatus {
    /// Statut initial d'une source, avant collecte : les compteurs partent à
    /// zéro et seuls `id`/`label`/`provides_tokens`/`enabled` varient d'une
    /// source à l'autre.
    fn new(id: &str, label: String, provides_tokens: bool, enabled: bool) -> Self {
        Self {
            id: id.to_string(),
            label,
            provides_tokens,
            enabled,
            available: false,
            events: 0,
            new_events: 0,
            events_in_range: 0,
            quota: 0,
            error: None,
            note: None,
            stats: Stats::default(),
        }
    }
}

/// Résultat d'un passage sur toutes les sources.
#[derive(Debug, Default)]
pub struct CollectedAll {
    pub events: Vec<Event>,
    pub quota: Vec<Quota>,
    pub sources: Vec<SourceStatus>,
    pub state: HashMap<String, CollectorState>,
    /// L'état du relevé direct, à persister avec l'index.
    pub live: anthropic_oauth::LiveState,
    /// Ce que le relevé direct rapporte de lui-même, pour que l'interface
    /// puisse dire pourquoi un chiffre ne bouge pas.
    pub live_stats: Option<anthropic_oauth::LiveStats>,
    /// Le coût facturé par le fournisseur, quand une clé Admin le permet.
    pub cost: Option<billing::CostReport>,
}

type IsAvailableFn = fn(Option<&str>) -> bool;
type CollectFn = fn(Option<&str>, &CollectorState) -> Collected;

/// Les collecteurs déjà portés, dans l'ordre d'affichage. `is_available` et
/// `collect` voyagent avec chaque entrée plutôt que d'être choisis par un
/// `if id == ...` : ajouter une troisième source locale n'est alors qu'une
/// ligne ici, pas une branche de plus dans `collect_ported`.
const PORTED: &[(&str, &str, IsAvailableFn, CollectFn)] = &[
    (
        claude_code::SOURCE,
        "source.claude-code",
        claude_code::is_available,
        claude_code::collect,
    ),
    (
        codex_cli::SOURCE,
        "source.codex-cli",
        codex_cli::is_available,
        codex_cli::collect,
    ),
];

type KeyFn = fn(&crate::store::Config) -> Option<&str>;
type BillingCollectFn = fn(Option<&str>, i64) -> Collected;

/// Les collecteurs qui restent à porter : ils demandent HTTP et l'accès au
/// trousseau. On les DÉCLARE plutôt que de les faire disparaître — une source
/// absente de la liste se lirait comme une source qui n'existe pas, alors
/// qu'elle existe et ne fonctionne simplement pas encore.
/// Les deux rapports de facturation. Ils ne se lisent qu'avec une clé Admin,
/// et leur motif d'indisponibilité doit le dire — c'est la première question
/// que se pose l'utilisateur devant une source vide. `key` et `collect`
/// voyagent avec chaque entrée pour la même raison que dans `PORTED`.
const BILLING: &[(&str, &str, &str, KeyFn, BillingCollectFn)] = &[
    (
        billing::ANTHROPIC,
        "source.anthropic-api",
        "source.needAnthropicKey",
        |c| c.anthropic_admin_key.as_deref(),
        billing::collect_anthropic,
    ),
    (
        billing::OPENAI,
        "source.openai-api",
        "source.needOpenaiKey",
        |c| c.openai_admin_key.as_deref(),
        billing::collect_openai,
    ),
];

/// Ce qu'un groupe de collecteurs indépendant verse dans le résultat final.
/// Chaque champ reprend le défaut de `CollectedAll` : un groupe qui ne
/// produit rien de particulier (par ex. la facturation OpenAI sur `live`)
/// n'écrase rien chez les autres à la fusion.
#[derive(Default)]
struct Partial {
    sources: Vec<SourceStatus>,
    events: Vec<Event>,
    quota: Vec<Quota>,
    state: HashMap<String, CollectorState>,
    live: Option<anthropic_oauth::LiveState>,
    live_stats: Option<anthropic_oauth::LiveStats>,
    cost: Option<billing::CostReport>,
}

/// Les collecteurs locaux (`PORTED`), qui ne font que lire des fichiers.
fn collect_ported(
    config: &crate::store::Config,
    state: &HashMap<String, CollectorState>,
) -> Partial {
    use crate::i18n::t;
    let disabled: std::collections::HashSet<&str> =
        config.disabled_sources.iter().map(String::as_str).collect();
    let mut out = Partial::default();

    for (id, label_key, is_available, collect) in PORTED {
        let mut entry = SourceStatus::new(id, t(label_key), true, !disabled.contains(id));

        if !entry.enabled {
            entry.note = Some(t("source.disabled"));
            out.sources.push(entry);
            continue;
        }

        let previous = state.get(*id).cloned().unwrap_or_default();
        entry.available = is_available(None);
        let collected = entry.available.then(|| collect(None, &previous));

        match collected {
            None => entry.note = Some(t("source.notFound")),
            Some(mut res) => {
                entry.new_events = res.events.len();
                entry.quota = res.quota.len();
                entry.stats = res.stats;
                out.events.append(&mut res.events);
                out.quota.append(&mut res.quota);
                out.state.insert((*id).to_string(), res.state);
            }
        }
        out.sources.push(entry);
    }
    out
}

/// Le seul collecteur qui interroge le réseau pour les taux d'occupation. Il
/// ne remonte pas de tokens, et il est le seul chiffre juste sur les
/// fenêtres : aucune reconstruction locale ne fait mieux.
fn collect_oauth(config: &crate::store::Config, live: &anthropic_oauth::LiveState) -> Partial {
    use crate::i18n::t;
    let id = anthropic_oauth::SOURCE;
    let mut out = Partial::default();
    let mut entry = SourceStatus::new(
        id,
        t("source.anthropic-oauth"),
        false,
        !config.disabled_sources.iter().any(|d| d == id),
    );
    if !entry.enabled {
        entry.note = Some(t("source.disabled"));
    } else if !anthropic_oauth::is_available() {
        entry.note = Some(t("source.needClaudeLogin"));
    } else {
        entry.available = true;
        let mut res = anthropic_oauth::collect(anthropic_oauth::MIN_INTERVAL_MS, Some(live));
        entry.quota = res.quota.len();
        if let Some(l) = res.live.take() {
            if !l.errors.is_empty() {
                entry.error = Some(l.errors.join(" ; "));
            }
            out.live = Some(l.state.clone());
            out.live_stats = Some(l);
        }
        out.quota.append(&mut res.quota);
    }
    out.sources.push(entry);
    out
}

/// Un rapport de facturation d'organisation (Anthropic ou OpenAI).
fn collect_billing(
    config: &crate::store::Config,
    id: &'static str,
    label_key: &'static str,
    need_key: &'static str,
    key_fn: KeyFn,
    collect: BillingCollectFn,
) -> Partial {
    use crate::i18n::t;
    let key = key_fn(config);
    let mut out = Partial::default();
    let mut entry = SourceStatus::new(
        id,
        t(label_key),
        true,
        !config.disabled_sources.iter().any(|d| d == id),
    );

    if !entry.enabled {
        entry.note = Some(t("source.disabled"));
    } else if !billing::has_key(key) {
        entry.note = Some(t(need_key));
    } else {
        entry.available = true;
        let mut res = collect(key, config.api_lookback_days);
        entry.new_events = res.events.len();
        entry.stats = res.stats;
        if !res.errors.is_empty() {
            entry.error = Some(res.errors.join(" ; "));
        }
        out.cost = res.cost.take();
        out.events.append(&mut res.events);
    }
    out.sources.push(entry);
    out
}

/// Exécute tous les collecteurs activés et fusionne leurs résultats.
///
/// Chaque collecteur est isolé : celui qui échoue est signalé dans `sources`
/// mais n'empêche jamais les autres de remonter leurs données. Un dossier de
/// journaux corrompu ne doit pas vider tout le tableau de bord.
///
/// Les groupes ci-dessous sont indépendants et, pour la plupart, réseau :
/// les exécuter en séquence ferait attendre un cycle entier la somme de
/// leurs délais d'expiration (jusqu'à 10 s + 2 × 40 s) au lieu du plus lent
/// d'entre eux. `thread::scope` les exécute de front sans qu'aucune donnée
/// n'ait besoin de traverser un canal — chaque groupe rend sa part, et la
/// fusion qui suit la jonction est la seule section séquentielle.
pub fn collect_all(
    config: &crate::store::Config,
    state: &HashMap<String, CollectorState>,
    live: &anthropic_oauth::LiveState,
) -> CollectedAll {
    let parts: Vec<Partial> = std::thread::scope(|scope| {
        let mut handles = Vec::with_capacity(2 + BILLING.len());
        handles.push(scope.spawn(|| collect_ported(config, state)));
        handles.push(scope.spawn(|| collect_oauth(config, live)));
        for (id, label_key, need_key, key_fn, collect) in BILLING {
            handles.push(scope.spawn(move || {
                collect_billing(config, id, label_key, need_key, *key_fn, *collect)
            }));
        }
        handles
            .into_iter()
            .map(|h| h.join().expect("un collecteur ne panique pas"))
            .collect()
    });

    let mut out = CollectedAll::default();
    for mut part in parts {
        out.sources.append(&mut part.sources);
        out.events.append(&mut part.events);
        out.quota.append(&mut part.quota);
        out.state.extend(part.state);
        if let Some(l) = part.live {
            out.live = l;
        }
        if part.live_stats.is_some() {
            out.live_stats = part.live_stats;
        }
        if part.cost.is_some() {
            out.cost = part.cost;
        }
    }

    // Les journaux ne sont pas parcourus dans l'ordre chronologique : la série
    // journalière et les fenêtres glissantes attendent un flux trié.
    out.events.sort_by_key(|e| e.ts);

    // Ordre d'affichage canonique : les sources sont collectées dans l'ordre
    // qui arrange le code, elles se présentent dans celui qui arrange le
    // lecteur — les deux sources Claude côte à côte, puis Codex, puis les
    // rapports d'organisation.
    out.sources.sort_by_key(|s| {
        DISPLAY_ORDER
            .iter()
            .position(|id| *id == s.id)
            .unwrap_or(usize::MAX)
    });
    out
}

/// L'ordre dans lequel l'interface et la CLI listent les sources.
const DISPLAY_ORDER: &[&str] = &[
    claude_code::SOURCE,
    anthropic_oauth::SOURCE,
    codex_cli::SOURCE,
    billing::ANTHROPIC,
    billing::OPENAI,
];
