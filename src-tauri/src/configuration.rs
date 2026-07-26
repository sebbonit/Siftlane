use std::{collections::HashSet, fs::OpenOptions, io::Write, path::Path};

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use argon2::Argon2;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use chrono::{DateTime, Utc};
use secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};
use siftlane_core::{AppError, AuthRef, ConnectionProfile, ErrorCode, Favorite, SavedAction};
use tauri::State;
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::{commands::normalize_profile, secrets::SecretKind, state::AppState};

const DOCUMENT_FORMAT: &str = "app.siftlane.configuration";
const DOCUMENT_VERSION: u32 = 1;
const ENCRYPTION_SCHEME: &str = "argon2id-aes-256-gcm";
const ENCRYPTION_AAD: &[u8] = b"app.siftlane.configuration/v1/secrets";
const MAX_DOCUMENT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PROFILES: usize = 2_000;
const MAX_BOOKMARKS: usize = 20_000;
const MAX_ACTIONS: usize = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PortableConfiguration {
    format: String,
    version: u32,
    exported_at: DateTime<Utc>,
    profiles: Vec<ConnectionProfile>,
    bookmarks: Vec<Favorite>,
    saved_actions: Vec<SavedAction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    encrypted_secrets: Option<EncryptedSecrets>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EncryptedSecrets {
    scheme: String,
    salt_base64: String,
    nonce_base64: String,
    ciphertext_base64: String,
}

#[derive(Debug, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
struct SecretBundle {
    entries: Vec<SecretEntry>,
}

#[derive(Debug, Serialize, Deserialize, Zeroize)]
struct SecretEntry {
    #[zeroize(skip)]
    profile_id: Uuid,
    password: Option<String>,
    private_key_passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConfigurationSummary {
    pub version: u32,
    pub profiles: usize,
    pub bookmarks: usize,
    pub saved_actions: usize,
    pub secrets_included: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConfigurationImportSummary {
    pub profiles: usize,
    pub bookmarks: usize,
    pub saved_actions: usize,
    pub secrets_imported: usize,
}

#[tauri::command]
pub fn export_configuration(
    state: State<'_, AppState>,
    path: String,
    include_secrets: bool,
    passphrase: Option<String>,
) -> Result<ConfigurationSummary, AppError> {
    let profiles = state.storage.list_profiles()?;
    let bookmarks = state.storage.list_favorites()?;
    let saved_actions = state.storage.list_saved_actions()?;
    let encrypted_secrets = if include_secrets {
        let passphrase = require_passphrase(passphrase)?;
        let bundle = collect_secrets(&state, &profiles)?;
        Some(encrypt_secrets(&bundle, &passphrase)?)
    } else {
        None
    };
    let document = PortableConfiguration {
        format: DOCUMENT_FORMAT.to_string(),
        version: DOCUMENT_VERSION,
        exported_at: Utc::now(),
        profiles,
        bookmarks,
        saved_actions,
        encrypted_secrets,
    };
    validate_document(&document)?;
    let bytes = serde_json::to_vec_pretty(&document).map_err(serialization_error)?;
    write_export(Path::new(&path), &bytes, include_secrets)?;
    Ok(summary(&document))
}

#[tauri::command]
pub fn inspect_configuration(path: String) -> Result<ConfigurationSummary, AppError> {
    let document = read_document(Path::new(&path))?;
    Ok(summary(&document))
}

#[tauri::command]
pub fn import_configuration(
    state: State<'_, AppState>,
    path: String,
    passphrase: Option<String>,
) -> Result<ConfigurationImportSummary, AppError> {
    let document = read_document(Path::new(&path))?;
    let profiles = document
        .profiles
        .into_iter()
        .map(normalize_profile)
        .collect::<Result<Vec<_>, _>>()?;
    let profile_ids = profiles
        .iter()
        .map(|profile| profile.id)
        .collect::<HashSet<_>>();
    validate_related_records(
        &state,
        &profile_ids,
        &document.bookmarks,
        &document.saved_actions,
    )?;

    let mut secrets = match document.encrypted_secrets {
        Some(encrypted) => {
            let passphrase = require_passphrase(passphrase)?;
            Some(decrypt_secrets(&encrypted, &passphrase)?)
        }
        None => None,
    };

    for profile in &profiles {
        state.storage.save_profile(profile)?;
    }
    for bookmark in &document.bookmarks {
        state.storage.save_favorite(bookmark)?;
    }
    for action in &document.saved_actions {
        state.storage.save_saved_action(action)?;
    }

    let mut secrets_imported = 0;
    if let Some(bundle) = secrets.as_mut() {
        for entry in &bundle.entries {
            if !profile_ids.contains(&entry.profile_id)
                && state.storage.get_profile(entry.profile_id).is_err()
            {
                continue;
            }
            if let Some(password) = &entry.password {
                state
                    .secrets
                    .set(entry.profile_id, SecretKind::Password, password)?;
                secrets_imported += 1;
            }
            if let Some(passphrase) = &entry.private_key_passphrase {
                state.secrets.set(
                    entry.profile_id,
                    SecretKind::PrivateKeyPassphrase,
                    passphrase,
                )?;
                secrets_imported += 1;
            }
        }
    }

    Ok(ConfigurationImportSummary {
        profiles: profiles.len(),
        bookmarks: document.bookmarks.len(),
        saved_actions: document.saved_actions.len(),
        secrets_imported,
    })
}

fn collect_secrets(
    state: &AppState,
    profiles: &[ConnectionProfile],
) -> Result<SecretBundle, AppError> {
    let mut entries = Vec::new();
    for profile in profiles {
        let password = match profile.auth {
            AuthRef::Password { remember: true } => state
                .secrets
                .get(profile.id, SecretKind::Password)?
                .map(|value| value.expose_secret().to_string()),
            _ => None,
        };
        let private_key_passphrase = match profile.auth {
            AuthRef::PrivateKey {
                remember_passphrase: true,
                ..
            } => state
                .secrets
                .get(profile.id, SecretKind::PrivateKeyPassphrase)?
                .map(|value| value.expose_secret().to_string()),
            _ => None,
        };
        if password.is_some() || private_key_passphrase.is_some() {
            entries.push(SecretEntry {
                profile_id: profile.id,
                password,
                private_key_passphrase,
            });
        }
    }
    Ok(SecretBundle { entries })
}

fn encrypt_secrets(
    bundle: &SecretBundle,
    passphrase: &Zeroizing<String>,
) -> Result<EncryptedSecrets, AppError> {
    let plaintext = Zeroizing::new(serde_json::to_vec(bundle).map_err(serialization_error)?);
    let mut salt = [0_u8; 16];
    let mut nonce_bytes = [0_u8; 12];
    getrandom::fill(&mut salt).map_err(random_error)?;
    getrandom::fill(&mut nonce_bytes).map_err(random_error)?;
    let key = derive_key(passphrase, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(encryption_error)?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: plaintext.as_ref(),
                aad: ENCRYPTION_AAD,
            },
        )
        .map_err(encryption_error)?;
    Ok(EncryptedSecrets {
        scheme: ENCRYPTION_SCHEME.to_string(),
        salt_base64: BASE64.encode(salt),
        nonce_base64: BASE64.encode(nonce_bytes),
        ciphertext_base64: BASE64.encode(ciphertext),
    })
}

fn decrypt_secrets(
    encrypted: &EncryptedSecrets,
    passphrase: &Zeroizing<String>,
) -> Result<SecretBundle, AppError> {
    if encrypted.scheme != ENCRYPTION_SCHEME {
        return Err(AppError::new(
            ErrorCode::Unsupported,
            "This encrypted configuration scheme is not supported",
        ));
    }
    let salt = decode_fixed::<16>(&encrypted.salt_base64)?;
    let nonce = decode_fixed::<12>(&encrypted.nonce_base64)?;
    let ciphertext = BASE64
        .decode(&encrypted.ciphertext_base64)
        .map_err(decryption_error)?;
    let key = derive_key(passphrase, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(decryption_error)?;
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: ENCRYPTION_AAD,
                },
            )
            .map_err(|_| {
                AppError::new(
                    ErrorCode::AuthenticationFailed,
                    "The configuration passphrase is incorrect or the file was modified",
                )
            })?,
    );
    serde_json::from_slice(plaintext.as_ref()).map_err(|source| {
        AppError::new(
            ErrorCode::InvalidInput,
            "The encrypted secret payload is invalid",
        )
        .with_detail(source.to_string())
    })
}

fn derive_key(passphrase: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, AppError> {
    let mut key = Zeroizing::new([0_u8; 32]);
    Argon2::default()
        .hash_password_into(passphrase.as_bytes(), salt, key.as_mut())
        .map_err(encryption_error)?;
    Ok(key)
}

fn decode_fixed<const N: usize>(value: &str) -> Result<[u8; N], AppError> {
    let decoded = BASE64.decode(value).map_err(decryption_error)?;
    decoded.try_into().map_err(|_| {
        AppError::new(
            ErrorCode::InvalidInput,
            "The encrypted configuration metadata is invalid",
        )
    })
}

fn require_passphrase(passphrase: Option<String>) -> Result<Zeroizing<String>, AppError> {
    let passphrase = Zeroizing::new(passphrase.unwrap_or_default());
    if passphrase.chars().count() < 12 {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Use an export passphrase with at least 12 characters",
        ));
    }
    Ok(passphrase)
}

fn read_document(path: &Path) -> Result<PortableConfiguration, AppError> {
    let metadata = std::fs::metadata(path).map_err(file_error)?;
    if metadata.len() > MAX_DOCUMENT_BYTES {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Configuration files larger than 16 MB are not supported",
        ));
    }
    let bytes = std::fs::read(path).map_err(file_error)?;
    let document = serde_json::from_slice::<PortableConfiguration>(&bytes).map_err(|source| {
        AppError::new(
            ErrorCode::InvalidInput,
            "This is not a valid Siftlane configuration",
        )
        .with_detail(source.to_string())
    })?;
    validate_document(&document)?;
    Ok(document)
}

fn validate_document(document: &PortableConfiguration) -> Result<(), AppError> {
    if document.format != DOCUMENT_FORMAT {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "This JSON document is not a Siftlane configuration",
        ));
    }
    if document.version != DOCUMENT_VERSION {
        return Err(AppError::new(
            ErrorCode::Unsupported,
            format!(
                "Configuration version {} is not supported by this release",
                document.version
            ),
        ));
    }
    if document.profiles.len() > MAX_PROFILES
        || document.bookmarks.len() > MAX_BOOKMARKS
        || document.saved_actions.len() > MAX_ACTIONS
    {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "The configuration contains too many records",
        ));
    }
    Ok(())
}

fn validate_related_records(
    state: &AppState,
    imported_profile_ids: &HashSet<Uuid>,
    bookmarks: &[Favorite],
    actions: &[SavedAction],
) -> Result<(), AppError> {
    for bookmark in bookmarks {
        if bookmark.label.trim().is_empty() || bookmark.path.trim().is_empty() {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "Imported bookmarks must have a label and path",
            ));
        }
        let profile_id = bookmark.profile_id.ok_or_else(|| {
            AppError::new(
                ErrorCode::InvalidInput,
                "Imported bookmarks must belong to a profile",
            )
        })?;
        if !imported_profile_ids.contains(&profile_id)
            && state.storage.get_profile(profile_id).is_err()
        {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "An imported bookmark refers to a missing profile",
            ));
        }
    }
    if actions.iter().any(|action| action.label.trim().is_empty()) {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Imported saved actions must have a label",
        ));
    }
    Ok(())
}

fn summary(document: &PortableConfiguration) -> ConfigurationSummary {
    ConfigurationSummary {
        version: document.version,
        profiles: document.profiles.len(),
        bookmarks: document.bookmarks.len(),
        saved_actions: document.saved_actions.len(),
        secrets_included: document.encrypted_secrets.is_some(),
    }
}

fn write_export(path: &Path, bytes: &[u8], private: bool) -> Result<(), AppError> {
    if path.file_name().is_none() {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Choose a file for the configuration export",
        ));
    }
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent).map_err(file_error)?;
    }
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(file_error)?;
    file.write_all(bytes).map_err(file_error)?;
    file.sync_all().map_err(file_error)?;
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(file_error)?;
    }
    Ok(())
}

fn file_error(source: std::io::Error) -> AppError {
    AppError::new(ErrorCode::Io, "The configuration file operation failed")
        .with_detail(source.to_string())
}

fn serialization_error(source: serde_json::Error) -> AppError {
    AppError::new(
        ErrorCode::Internal,
        "Could not serialize the Siftlane configuration",
    )
    .with_detail(source.to_string())
}

fn encryption_error(source: impl std::fmt::Display) -> AppError {
    AppError::new(
        ErrorCode::Internal,
        "Could not encrypt the configuration secrets",
    )
    .with_detail(source.to_string())
}

fn decryption_error(source: impl std::fmt::Display) -> AppError {
    AppError::new(
        ErrorCode::InvalidInput,
        "The encrypted configuration metadata is invalid",
    )
    .with_detail(source.to_string())
}

fn random_error(source: impl std::fmt::Display) -> AppError {
    AppError::new(
        ErrorCode::Internal,
        "The operating system could not generate secure random data",
    )
    .with_detail(source.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_secret_bundle_round_trips() {
        let bundle = SecretBundle {
            entries: vec![SecretEntry {
                profile_id: Uuid::new_v4(),
                password: Some("correct horse battery staple".into()),
                private_key_passphrase: None,
            }],
        };
        let passphrase = Zeroizing::new("a long export passphrase".to_string());
        let encrypted = encrypt_secrets(&bundle, &passphrase).unwrap();
        let decrypted = decrypt_secrets(&encrypted, &passphrase).unwrap();
        assert_eq!(decrypted.entries.len(), 1);
        assert_eq!(
            decrypted.entries[0].password.as_deref(),
            Some("correct horse battery staple")
        );
    }

    #[test]
    fn wrong_passphrase_is_rejected() {
        let bundle = SecretBundle {
            entries: vec![SecretEntry {
                profile_id: Uuid::new_v4(),
                password: Some("secret".into()),
                private_key_passphrase: None,
            }],
        };
        let encrypted =
            encrypt_secrets(&bundle, &Zeroizing::new("first long passphrase".into())).unwrap();
        let error = decrypt_secrets(&encrypted, &Zeroizing::new("second long passphrase".into()))
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::AuthenticationFailed);
    }

    #[test]
    fn summary_never_exposes_encrypted_payload() {
        let document = PortableConfiguration {
            format: DOCUMENT_FORMAT.into(),
            version: DOCUMENT_VERSION,
            exported_at: Utc::now(),
            profiles: vec![],
            bookmarks: vec![],
            saved_actions: vec![],
            encrypted_secrets: Some(EncryptedSecrets {
                scheme: ENCRYPTION_SCHEME.into(),
                salt_base64: "salt".into(),
                nonce_base64: "nonce".into(),
                ciphertext_base64: "ciphertext".into(),
            }),
        };
        let summary = summary(&document);
        assert!(summary.secrets_included);
        assert_eq!(summary.profiles, 0);
    }

    #[test]
    fn legacy_profiles_receive_empty_organization_fields() {
        let profile = ConnectionProfile::new(
            "Legacy".into(),
            "legacy.example.com".into(),
            "deploy".into(),
            AuthRef::Agent,
        );
        let mut value = serde_json::to_value(profile).unwrap();
        let object = value.as_object_mut().unwrap();
        object.remove("folder");
        object.remove("tags");
        object.remove("color");
        object.remove("notes");
        let restored: ConnectionProfile = serde_json::from_value(value).unwrap();
        assert_eq!(restored.folder, None);
        assert!(restored.tags.is_empty());
        assert_eq!(restored.color, None);
        assert!(restored.notes.is_empty());
    }
}
