use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::watch;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PreparationStage {
    People,
    Albums,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPreparationProgress {
    pub stage: PreparationStage,
    pub account_index: usize,
    pub account_count: usize,
    pub completed_albums: usize,
    pub total_albums: Option<usize>,
    pub processed_album_assets: usize,
    pub total_album_assets: Option<usize>,
}

impl SyncPreparationProgress {
    pub fn people(account_index: usize, account_count: usize) -> Self {
        Self {
            stage: PreparationStage::People,
            account_index,
            account_count,
            completed_albums: 0,
            total_albums: None,
            processed_album_assets: 0,
            total_album_assets: None,
        }
    }
}

pub type PreparationSender = watch::Sender<Option<SyncPreparationProgress>>;

/// Display-only progress; never changes the persisted asset-page resume cursor.
pub struct SyncProgress {
    running: AtomicBool,
    pub preparation: PreparationSender,
}

impl Default for SyncProgress {
    fn default() -> Self {
        Self {
            running: AtomicBool::new(false),
            preparation: watch::channel(None).0,
        }
    }
}

impl SyncProgress {
    pub fn try_start(self: &Arc<Self>) -> Option<SyncRun> {
        self.running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()?;
        self.preparation.send_replace(None);
        Some(SyncRun(self.clone()))
    }
}

pub struct SyncRun(Arc<SyncProgress>);

impl Drop for SyncRun {
    fn drop(&mut self) {
        self.0.preparation.send_replace(None);
        self.0.running.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_sync_progress_is_transient_and_only_one_run_can_own_it() {
        let progress = Arc::new(SyncProgress::default());
        let run = progress.try_start().unwrap();
        progress
            .preparation
            .send_replace(Some(SyncPreparationProgress::people(1, 2)));
        assert!(progress.try_start().is_none());
        drop(run);
        assert!(progress.preparation.borrow().is_none());
        assert!(progress.try_start().is_some());
    }
}
