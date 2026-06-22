use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use crate::services::immich_client::ImmichClient;

/// In-memory registry of authenticated [`ImmichClient`] sessions, one per
/// locally-registered account. The app keeps every account signed in
/// simultaneously so views can mix assets from all accounts and per-asset
/// operations can be routed to the session that owns each asset.
///
/// Each account gets its own [`ImmichClient`] instance so that per-server
/// cookie jars (used for OAuth/password sessions) stay isolated — accounts may
/// live on different Immich servers.
pub struct AccountManager {
    clients: RwLock<HashMap<String, Arc<ImmichClient>>>,
    primary_id: RwLock<Option<String>>,
    /// Clients for add-account OAuth flows that are in progress, keyed by the
    /// target server URL. The same client must finish the flow it started so its
    /// PKCE/cookie state is preserved.
    pending_oauth: RwLock<HashMap<String, Arc<ImmichClient>>>,
}

impl AccountManager {
    pub fn new() -> Self {
        Self {
            clients: RwLock::new(HashMap::new()),
            primary_id: RwLock::new(None),
            pending_oauth: RwLock::new(HashMap::new()),
        }
    }

    /// Register (or replace) the client for an account.
    pub fn insert(&self, account_id: String, client: Arc<ImmichClient>) {
        self.clients
            .write()
            .expect("account clients lock poisoned")
            .insert(account_id, client);
    }

    /// Remove an account's client from the registry.
    pub fn remove(&self, account_id: &str) {
        self.clients
            .write()
            .expect("account clients lock poisoned")
            .remove(account_id);
        let mut primary = self
            .primary_id
            .write()
            .expect("primary id lock poisoned");
        if primary.as_deref() == Some(account_id) {
            *primary = None;
        }
    }

    /// Returns the client for a specific account, if registered.
    pub fn client(&self, account_id: &str) -> Option<Arc<ImmichClient>> {
        self.clients
            .read()
            .expect("account clients lock poisoned")
            .get(account_id)
            .cloned()
    }

    /// Mark which account is primary. The primary client drives album creation
    /// and is used as the default for legacy single-account code paths.
    pub fn set_primary(&self, account_id: String) {
        *self
            .primary_id
            .write()
            .expect("primary id lock poisoned") = Some(account_id);
    }

    /// The id of the current primary account, if any.
    pub fn primary_id(&self) -> Option<String> {
        self.primary_id
            .read()
            .expect("primary id lock poisoned")
            .clone()
    }

    /// The client for the current primary account, if registered.
    pub fn primary(&self) -> Option<Arc<ImmichClient>> {
        let pid = self.primary_id()?;
        self.client(&pid)
    }

    /// All registered `(account_id, client)` pairs.
    pub fn all(&self) -> Vec<(String, Arc<ImmichClient>)> {
        self.clients
            .read()
            .expect("account clients lock poisoned")
            .iter()
            .map(|(id, client)| (id.clone(), client.clone()))
            .collect()
    }

    /// All registered account ids.
    pub fn account_ids(&self) -> Vec<String> {
        self.clients
            .read()
            .expect("account clients lock poisoned")
            .keys()
            .cloned()
            .collect()
    }

    /// Number of registered account clients.
    pub fn len(&self) -> usize {
        self.clients
            .read()
            .expect("account clients lock poisoned")
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Drop all registered clients (used on full sign-out).
    pub fn clear(&self) {
        self.clients
            .write()
            .expect("account clients lock poisoned")
            .clear();
        *self
            .primary_id
            .write()
            .expect("primary id lock poisoned") = None;
        self.pending_oauth
            .write()
            .expect("pending oauth lock poisoned")
            .clear();
    }

    /// Stash a client for an in-progress add-account OAuth flow.
    pub fn stash_pending_oauth(&self, server_url: String, client: Arc<ImmichClient>) {
        self.pending_oauth
            .write()
            .expect("pending oauth lock poisoned")
            .insert(server_url, client);
    }

    /// Take (remove and return) the client for an in-progress add-account OAuth
    /// flow targeting `server_url`.
    pub fn take_pending_oauth(&self, server_url: &str) -> Option<Arc<ImmichClient>> {
        self.pending_oauth
            .write()
            .expect("pending oauth lock poisoned")
            .remove(server_url)
    }
}

impl Default for AccountManager {
    fn default() -> Self {
        Self::new()
    }
}
