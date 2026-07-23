use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use siftlane_core::{
    AppError, ConnectionProfile, ErrorCode, Preferences, RemoteFilesystem, TransferQueue,
};
use siftlane_sftp::{HostKeyDecision, HostKeyVerifier, ObservedHostKey, SftpAuth};
use tauri::Manager;
use tokio::sync::{Mutex, RwLock, Semaphore};
use uuid::Uuid;

use crate::{
    secrets::{SecretKind, SecretStore},
    storage::{Storage, StoredHostKey},
};

#[derive(Clone)]
pub struct AppState {
    pub storage: Storage,
    pub secrets: SecretStore,
    pub sessions: Arc<RwLock<HashMap<Uuid, SessionRecord>>>,
    pub pending_host_keys: Arc<Mutex<HashMap<Uuid, PendingHostKey>>>,
    pub transfers: Arc<Mutex<TransferQueue>>,
    pub transfer_slots: Arc<Semaphore>,
}

#[derive(Clone)]
pub struct SessionRecord {
    pub profile_id: Uuid,
    pub client: Arc<dyn RemoteFilesystem>,
}

pub struct PendingHostKey {
    pub key: ObservedHostKey,
    /// Authentication is kept only until the user accepts or rejects the
    /// host-key prompt. Keeping it here prevents a second Keychain read when
    /// the connection is resumed after trust is granted.
    pub profile: ConnectionProfile,
    pub auth: SftpAuth,
    pub supplied_secret: Option<(SecretKind, String)>,
    pub preferences: Preferences,
}

impl AppState {
    fn initialize(app: &tauri::AppHandle) -> Result<Self, AppError> {
        let data_dir = app.path().app_data_dir().map_err(|source| {
            AppError::new(
                ErrorCode::Storage,
                "Could not locate the application data directory",
            )
            .with_detail(source.to_string())
        })?;
        let storage = Storage::open(data_dir.join("siftlane.sqlite3"))?;
        let preferences = storage.load_preferences()?;
        let transfers = TransferQueue::restore(storage.load_transfers()?);
        Ok(Self {
            storage,
            secrets: SecretStore,
            sessions: Arc::new(RwLock::new(HashMap::new())),
            pending_host_keys: Arc::new(Mutex::new(HashMap::new())),
            transfers: Arc::new(Mutex::new(transfers)),
            transfer_slots: Arc::new(Semaphore::new(
                preferences.global_parallel_transfers.max(1) as usize
            )),
        })
    }
}

pub struct StoredKeyVerifier {
    keys: Vec<StoredHostKey>,
}

impl StoredKeyVerifier {
    pub fn new(keys: Vec<StoredHostKey>) -> Self {
        Self { keys }
    }
}

#[async_trait]
impl HostKeyVerifier for StoredKeyVerifier {
    async fn classify(&self, observed: &ObservedHostKey) -> HostKeyDecision {
        if self.keys.iter().any(|known| {
            known.host == observed.host
                && known.port == observed.port
                && known.algorithm == observed.algorithm
                && known.fingerprint == observed.fingerprint_sha256
        }) {
            HostKeyDecision::Trusted
        } else if self.keys.is_empty() {
            HostKeyDecision::Unknown
        } else {
            HostKeyDecision::Changed
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_log::Builder::new().build())
        .setup(|app| {
            let state = AppState::initialize(app.handle())?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            crate::commands::list_profiles,
            crate::commands::save_profile,
            crate::commands::delete_profile,
            crate::commands::connect_profile,
            crate::commands::trust_host_key,
            crate::commands::disconnect_session,
            crate::commands::get_default_local_path,
            crate::commands::list_local_directory,
            crate::commands::read_local_file,
            crate::commands::save_local_file,
            crate::commands::read_local_preview,
            crate::commands::read_local_file_privileged,
            crate::commands::save_local_file_privileged,
            crate::commands::format_rust,
            crate::commands::list_remote_directory,
            crate::commands::read_remote_file,
            crate::commands::save_remote_file,
            crate::commands::read_remote_preview,
            crate::commands::read_remote_file_privileged,
            crate::commands::save_remote_file_privileged,
            crate::commands::create_local_entry,
            crate::commands::delete_local_entry,
            crate::commands::create_local_entry_privileged,
            crate::commands::delete_local_entry_privileged,
            crate::commands::create_remote_entry,
            crate::commands::rename_remote_entry,
            crate::commands::delete_remote_entry,
            crate::commands::create_remote_entry_privileged,
            crate::commands::delete_remote_entry_privileged,
            crate::commands::set_remote_permissions,
            crate::commands::set_local_permissions,
            crate::commands::get_local_directory_size,
            crate::commands::get_remote_directory_size,
            crate::commands::get_preferences,
            crate::commands::save_preferences,
            crate::commands::list_transfers,
            crate::commands::clear_transfers,
            crate::commands::enqueue_transfer,
            crate::commands::control_transfer,
            crate::commands::resolve_transfer_conflict,
            crate::commands::list_saved_actions,
            crate::commands::save_saved_action,
            crate::commands::delete_saved_action,
            crate::commands::package_local_directory,
            crate::commands::package_remote_directory,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Siftlane");
}
