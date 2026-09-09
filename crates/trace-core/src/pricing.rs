//! Coût monétaire d'un volume de tokens, en USD.

use crate::models::{Model, CACHE_MULTIPLIERS};
use crate::util::Tokens;

/// Un fournisseur `local` fait tourner le modèle sur votre machine : le coût
/// monétaire est nul, l'empreinte carbone ne l'est pas.
const LOCAL: &str = "local";

fn per_million(n: i64, rate: f64) -> f64 {
    (n as f64 / 1_000_000.0) * rate
}

/// Coût d'un volume de tokens.
///
/// Les tarifs sont exprimés par million de tokens. Le cache suit les
/// multiplicateurs Anthropic — d'où la distinction entre `cache_write5m` et
/// `cache_write1h`, que les journaux de Claude Code fournissent.
///
/// Rend `None`, et non `Some(0.0)`, quand le modèle n'a pas de tarif connu :
/// un coût inconnu ne doit pas se fondre dans un total en se faisant passer
/// pour la gratuité. Les modèles locaux, eux, valent bien zéro.
pub fn cost(tokens: &Tokens, model: &Model) -> Option<f64> {
    let Some(p) = model.pricing else {
        return if model.provider == LOCAL {
            Some(0.0)
        } else {
            None
        };
    };

    // `cache_write5m` et `cache_write1h` sont facturés, `cache_write` ne l'est
    // PAS : c'est leur somme, gardée pour l'affichage et pour le calcul du
    // volume total. Le tarifer en plus reviendrait à compter deux fois toute
    // écriture de cache. La répartition entre les deux TTL est faite une seule
    // fois, à la source, par [`Tokens::with_cache_write`].
    Some(
        per_million(tokens.input, p.input)
            + per_million(tokens.output, p.output)
            + per_million(tokens.cache_read, p.input * CACHE_MULTIPLIERS.read)
            + per_million(tokens.cache_write5m, p.input * CACHE_MULTIPLIERS.write5m)
            + per_million(tokens.cache_write1h, p.input * CACHE_MULTIPLIERS.write1h),
    )
}

/// Ce que le même volume aurait coûté SANS cache.
///
/// C'est ce qui chiffre l'économie réelle du cache, qui est le plus souvent le
/// poste d'optimisation numéro un d'un usage type Claude Code.
pub fn cost_without_cache(tokens: &Tokens, model: &Model) -> Option<f64> {
    let Some(p) = model.pricing else {
        return if model.provider == LOCAL {
            Some(0.0)
        } else {
            None
        };
    };
    let all_input = tokens.input + tokens.cache_read + tokens.cache_write;
    Some(per_million(all_input, p.input) + per_million(tokens.output, p.output))
}
