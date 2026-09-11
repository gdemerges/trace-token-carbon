//! Vérification de version.
//!
//! TRACE n'a pas de mise à jour automatique, et n'en aura pas : installer du
//! code en arrière-plan sur la machine de quelqu'un demande une chaîne de
//! confiance — signature, canal, retour arrière — qu'une application de barre
//! d'état sans serveur ne peut pas tenir sérieusement. Mais ne rien dire est
//! pire : un correctif de calcul reste alors sur le dépôt pendant que
//! l'utilisateur regarde des chiffres faux.
//!
//! Le compromis : on lit la dernière version publiée, on le dit UNE fois, et
//! on ouvre la page si l'utilisateur le demande. Rien n'est téléchargé, rien
//! n'est exécuté.
//!
//! Ce que cela coûte en vie privée, dit franchement : un appel à
//! `api.github.com` au démarrage puis une fois par jour, qui expose l'adresse
//! IP et la version installée. Aucun identifiant, aucune donnée d'usage. Le
//! réglage `check_updates` le coupe, et le module ne fait alors plus un seul
//! appel.

use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

pub const REPO: &str = "gdemerges/trace-token-carbon";
pub const RELEASES_PAGE: &str = "https://github.com/gdemerges/trace-token-carbon/releases/latest";
const ENDPOINT: &str = "https://api.github.com/repos/gdemerges/trace-token-carbon/releases/latest";

const TIMEOUT: Duration = Duration::from_secs(8);
pub const INTERVAL: Duration = Duration::from_secs(24 * 3600);
/// Au démarrage, mais pas DANS le démarrage : la première seconde appartient à
/// l'affichage des chiffres, pas à une requête réseau facultative.
pub const STARTUP_DELAY: Duration = Duration::from_secs(30);

/// Longueur retenue des notes de version : de quoi dire ce qui change, pas de
/// quoi remplir une notification système.
const NOTES_MAX: usize = 400;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    pub version: String,
    pub url: String,
    pub notes: Option<String>,
}

struct Version {
    nums: [u32; 3],
    pre: Option<String>,
}

fn parse(v: &str) -> Option<Version> {
    let v = v.trim().trim_start_matches('v');
    let (core, pre) = match v.split_once('-') {
        Some((c, p)) if !p.is_empty() => (c, Some(p.to_string())),
        _ => (v, None),
    };
    let mut it = core.split('.');
    let mut nums = [0u32; 3];
    for slot in nums.iter_mut() {
        *slot = it.next()?.parse().ok()?;
    }
    // Un quatrième segment n'est pas du semver : on s'abstient plutôt que de
    // deviner ce qu'il veut dire.
    if it.next().is_some() {
        return None;
    }
    Some(Version { nums, pre })
}

/// Compare deux versions sémantiques. Rend un ordre où `a` postérieure est
/// supérieure.
///
/// Volontairement partiel : on compare les trois nombres, et une pré-version
/// (`1.2.0-beta.1`) est tenue pour ANTÉRIEURE à la version stable de même
/// numéro. On ne propose jamais une pré-version à qui n'en a pas demandé —
/// c'est la seule règle qui compte, et un analyseur semver complet serait une
/// dépendance pour rien.
///
/// Un format inconnu rend `Equal` : on s'abstient au lieu de deviner.
pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (Some(pa), Some(pb)) = (parse(a), parse(b)) else {
        return Ordering::Equal;
    };
    for i in 0..3 {
        match pa.nums[i].cmp(&pb.nums[i]) {
            Ordering::Equal => {}
            other => return other,
        }
    }
    match (pa.pre.is_some(), pb.pre.is_some()) {
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        _ => Ordering::Equal,
    }
}

/// Décide s'il y a lieu d'avertir, à partir de la réponse de l'API.
pub fn pick_release(release: &Value, current: &str) -> Option<Update> {
    if !release.is_object() {
        return None;
    }
    // Ni brouillon ni pré-version : on ne pousse personne vers l'inachevé.
    if release["draft"].as_bool() == Some(true) || release["prerelease"].as_bool() == Some(true) {
        return None;
    }
    let tag = release["tag_name"]
        .as_str()
        .or_else(|| release["name"].as_str())?;
    let version = tag.trim().trim_start_matches('v').to_string();
    if version.is_empty() || compare_versions(&version, current) != std::cmp::Ordering::Greater {
        return None;
    }

    // L'URL vient d'une réponse réseau : on n'ouvre que ce qui pointe vers le
    // dépôt, jamais une adresse arbitraire.
    let url = release["html_url"]
        .as_str()
        .filter(|u| u.starts_with("https://github.com/"))
        .unwrap_or(RELEASES_PAGE)
        .to_string();

    let notes = release["body"]
        .as_str()
        .map(|b| b.chars().take(NOTES_MAX).collect());
    Some(Update {
        version,
        url,
        notes,
    })
}

/// Interroge GitHub. Rend `None` sur toute anomalie : ce n'est pas critique,
/// et une panne de réseau ne doit surtout pas remonter à l'utilisateur.
pub fn fetch_latest() -> Option<Value> {
    let agent = crate::util::ureq_agent(TIMEOUT);
    agent
        .get(ENDPOINT)
        .set("accept", "application/vnd.github+json")
        .set("user-agent", "TRACE")
        .call()
        .ok()?
        .into_json()
        .ok()
}

/// Cherche une version plus récente, si le réglage l'autorise.
pub fn check(current: &str, enabled: bool) -> Option<Update> {
    if !enabled {
        return None;
    }
    pick_release(&fetch_latest()?, current)
}
