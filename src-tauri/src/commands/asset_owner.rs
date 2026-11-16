use crate::services::{
    db::{Account, CachedAssetOwnership, Database},
    immich_client::ImmichClient,
};
use crate::AppState;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;
use tokio::task::JoinSet;

pub(super) const OWNER_NOT_SIGNED_IN: &str = "The photo owner's account is not signed in. Sign in to that account in Immich Local, then retry changing the photo.";
const OWNERSHIP_LOOKUP_CONCURRENCY: usize = 8;

#[derive(Clone, Copy)]
pub(super) enum AssetAccess {
    Owner,
    Share,
}

pub(super) fn account_client(
    state: &AppState,
    account: &Account,
) -> Result<Arc<ImmichClient>, String> {
    state
        .accounts
        .client(&account.id)
        .or_else(|| account.is_primary.then(|| state.immich.clone()))
        .ok_or_else(|| {
            format!(
                "Account {} is not signed in. Sign in again before changing photos.",
                account.id
            )
        })
}

pub(super) async fn signed_in_client(
    state: &AppState,
    account: &Account,
) -> Result<Arc<ImmichClient>, String> {
    let client = account_client(state, account).map_err(|_| OWNER_NOT_SIGNED_IN)?;
    let matches_account = client.session.lock().await.as_ref().is_some_and(|session| {
        session.user_id == account.user_id
            && session.server_url.trim_end_matches('/') == account.server_url.trim_end_matches('/')
    });
    if !matches_account {
        return Err(OWNER_NOT_SIGNED_IN.into());
    }
    Ok(client)
}

/// Cache attribution identifies a server/read session, not necessarily the
/// owner of a shared photo. Never fall back to another user for a mutation.
pub(in crate::commands) async fn owner_client(
    state: &AppState,
    cached_account: &str,
    asset_id: &str,
) -> Result<Arc<ImmichClient>, String> {
    resolve_asset_account(state, cached_account, asset_id, AssetAccess::Owner)
        .await
        .map(|(_, client)| client)
}

pub(super) async fn resolve_asset_account(
    state: &AppState,
    cached_account: &str,
    asset_id: &str,
    access: AssetAccess,
) -> Result<(Account, Arc<ImmichClient>), String> {
    OwnershipResolver::new(state, &[asset_id.to_string()])
        .await?
        .resolve(cached_account, asset_id, access)
        .await
}

type ResolvedAsset = (Account, Arc<ImmichClient>);

struct OwnershipContext {
    db: Arc<Database>,
    accounts: HashMap<String, Account>,
    owners: HashMap<(String, String), String>,
    clients: HashMap<String, Arc<ImmichClient>>,
}

pub(super) struct OwnershipResolver {
    context: Arc<OwnershipContext>,
    cached: HashMap<String, CachedAssetOwnership>,
}

impl OwnershipResolver {
    pub(super) async fn new(state: &AppState, asset_ids: &[String]) -> Result<Self, String> {
        let cached = state.db.get_asset_ownership(asset_ids)?;
        log::debug!(
            "[assets.owner] loaded local batch selected={} cached_rows={}",
            asset_ids.len(),
            cached.len()
        );
        let mut accounts = HashMap::new();
        let mut owners = HashMap::new();
        let mut clients = HashMap::new();
        for account in state.db.list_accounts()? {
            match signed_in_client(state, &account).await {
                Ok(client) => {
                    clients.insert(account.id.clone(), client);
                }
                Err(error) => log::debug!(
                    "[assets.owner] session unavailable account={}: {error}",
                    account.id
                ),
            }
            owners.insert(
                (server_key(&account.server_url), account.user_id.clone()),
                account.id.clone(),
            );
            accounts.insert(account.id.clone(), account);
        }
        Ok(Self {
            context: Arc::new(OwnershipContext {
                db: state.db.clone(),
                accounts,
                owners,
                clients,
            }),
            cached,
        })
    }

    pub(super) fn cached_account(&self, asset_id: &str) -> Option<&str> {
        self.cached
            .get(asset_id)
            .map(|cached| cached.account_id.as_str())
            .filter(|id| !id.is_empty())
    }

    pub(super) fn cached_owner(&self, asset_id: &str) -> Option<&str> {
        self.cached.get(asset_id)?.owner_id.as_deref()
    }

    fn local_route(
        &self,
        cached_account: &str,
        asset_id: &str,
        access: AssetAccess,
    ) -> Option<Result<ResolvedAsset, String>> {
        let cached = self.cached.get(asset_id)?;
        let account = self.context.accounts.get(cached_account)?;
        let source = self.context.accounts.get(&cached.account_id)?;
        if server_key(&source.server_url) != server_key(&account.server_url) {
            return None;
        }
        let owner_id = cached.owner_id.as_deref()?;
        self.context.route_owner(account, owner_id, access)
    }

    fn remember(&mut self, cached_account: &str, asset_id: &str, owner_id: String) {
        // Detail lookups may target an uncached original. Retain the answer for
        // this operation even when no asset row exists to update.
        self.cached.insert(
            asset_id.to_string(),
            CachedAssetOwnership {
                account_id: cached_account.to_string(),
                owner_id: Some(owner_id),
            },
        );
    }

    pub(super) async fn resolve(
        &mut self,
        cached_account: &str,
        asset_id: &str,
        access: AssetAccess,
    ) -> Result<ResolvedAsset, String> {
        let result = if let Some(result) = self.local_route(cached_account, asset_id, access) {
            result
        } else {
            match self
                .context
                .resolve_missing(cached_account, asset_id, access)
                .await
            {
                Ok((resolved, owner)) => {
                    self.remember(cached_account, asset_id, owner);
                    Ok(resolved)
                }
                Err(error) => Err(error),
            }
        };
        if let Err(error) = &result {
            log::warn!(
                "[assets.owner] failed asset={asset_id} cached_account={cached_account}: {error}"
            );
        }
        result
    }

    pub(super) async fn resolve_many(
        &mut self,
        requests: &[(String, String)],
        access: AssetAccess,
    ) -> Result<HashMap<String, ResolvedAsset>, String> {
        let started = Instant::now();
        log::info!("[assets.owner] batch start selected={}", requests.len());
        let result = self.resolve_batch(requests, access).await;
        match &result {
            Ok((_, cached, missing)) => log::info!(
                "[assets.owner] batch complete selected={} cached={cached} fallback={missing} elapsed_ms={}",
                requests.len(), started.elapsed().as_millis()
            ),
            Err(error) => log::warn!(
                "[assets.owner] batch failed selected={} elapsed_ms={}: {error}",
                requests.len(), started.elapsed().as_millis()
            ),
        }
        result.map(|(resolved, _, _)| resolved)
    }

    async fn resolve_batch(
        &mut self,
        requests: &[(String, String)],
        access: AssetAccess,
    ) -> Result<(HashMap<String, ResolvedAsset>, usize, usize), String> {
        let mut resolved = HashMap::new();
        let mut missing = Vec::new();
        let mut seen = HashSet::new();
        // Finish the entire local pass before starting any ownership requests.
        for (account, id) in requests {
            if !seen.insert(id) {
                continue;
            }
            match self.local_route(account, id, access) {
                Some(result) => {
                    resolved.insert(id.clone(), result?);
                }
                None => missing.push((account.clone(), id.clone())),
            }
        }
        let cached_count = resolved.len();
        let missing_count = missing.len();
        let mut missing = missing.into_iter();
        let mut tasks = JoinSet::new();
        loop {
            while tasks.len() < OWNERSHIP_LOOKUP_CONCURRENCY {
                let Some((account, id)) = missing.next() else {
                    break;
                };
                let context = self.context.clone();
                tasks.spawn(async move {
                    let result = context.resolve_missing(&account, &id, access).await;
                    (account, id, result)
                });
            }
            let Some(result) = tasks.join_next().await else {
                break;
            };
            let (account, id, result) =
                result.map_err(|error| format!("Ownership lookup task failed: {error}"))?;
            let (route, owner) = result?;
            self.remember(&account, &id, owner);
            resolved.insert(id, route);
        }
        Ok((resolved, cached_count, missing_count))
    }
}

fn server_key(server: &str) -> String {
    server.trim_end_matches('/').to_string()
}

impl OwnershipContext {
    fn route_owner(
        &self,
        reader: &Account,
        owner_user: &str,
        access: AssetAccess,
    ) -> Option<Result<ResolvedAsset, String>> {
        if let Some(owner) = self
            .owners
            .get(&(server_key(&reader.server_url), owner_user.to_string()))
            .and_then(|id| self.accounts.get(id))
        {
            return Some(
                self.clients
                    .get(&owner.id)
                    .cloned()
                    .map(|client| (owner.clone(), client))
                    .ok_or_else(|| OWNER_NOT_SIGNED_IN.to_string()),
            );
        }
        if matches!(access, AssetAccess::Share) {
            // Cached read access permits attempting a partner contribution,
            // never an owner-only mutation. The server still enforces sharing.
            self.clients
                .get(&reader.id)
                .cloned()
                .map(|client| Ok((reader.clone(), client)))
        } else {
            Some(Err(OWNER_NOT_SIGNED_IN.to_string()))
        }
    }

    async fn resolve_missing(
        &self,
        cached_account: &str,
        asset_id: &str,
        access: AssetAccess,
    ) -> Result<(ResolvedAsset, String), String> {
        let cached = self
            .accounts
            .get(cached_account)
            .ok_or("Unknown photo account")?;
        let mut candidates: Vec<_> = self
            .accounts
            .values()
            .filter(|account| server_key(&account.server_url) == server_key(&cached.server_url))
            .collect();
        candidates.sort_by_key(|account| account.id != cached.id);
        let mut last_error = OWNER_NOT_SIGNED_IN.to_string();
        for account in candidates {
            let reader = match self.clients.get(&account.id) {
                Some(reader) => reader,
                None => {
                    log::warn!(
                        "[assets.owner] read account unavailable asset={asset_id} account={}",
                        account.id
                    );
                    continue;
                }
            };
            let owner_user = match reader.get_asset_owner_id(asset_id).await {
                Ok(owner) => owner,
                Err(error) => {
                    if !reader.ping(&cached.server_url).await {
                        return Err(format!(
                            "offline: Could not resolve the owner of photo {asset_id}: {error}"
                        ));
                    }
                    log::warn!(
                        "[assets.owner] ownership read failed asset={asset_id} account={}: {error}",
                        account.id
                    );
                    last_error = error;
                    continue;
                }
            };
            self.db
                .cache_asset_owner(asset_id, &cached.server_url, &owner_user)?;
            let route = self
                .route_owner(account, &owner_user, access)
                .ok_or_else(|| OWNER_NOT_SIGNED_IN.to_string())??;
            log::debug!(
                "[assets.owner] fallback resolved asset={asset_id} owner_account={}",
                route.0.id
            );
            return Ok((route, owner_user));
        }
        Err(last_error)
    }
}

#[cfg(test)]
#[path = "asset_owner/tests.rs"]
mod tests;
