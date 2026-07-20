use secrecy::SecretString;
use siftlane_core::{AppError, ErrorCode, ProfileId};

const SERVICE: &str = "app.siftlane.desktop";

#[derive(Debug, Clone, Copy)]
pub enum SecretKind {
    Password,
    PrivateKeyPassphrase,
}

impl SecretKind {
    fn suffix(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::PrivateKeyPassphrase => "key-passphrase",
        }
    }
}

#[derive(Clone, Default)]
pub struct SecretStore;

impl SecretStore {
    fn entry(&self, profile_id: ProfileId, kind: SecretKind) -> Result<keyring::Entry, AppError> {
        keyring::Entry::new(
            SERVICE,
            &format!("connection/{profile_id}/{}", kind.suffix()),
        )
        .map_err(secret_error)
    }

    pub fn get(
        &self,
        profile_id: ProfileId,
        kind: SecretKind,
    ) -> Result<Option<SecretString>, AppError> {
        match self.entry(profile_id, kind)?.get_password() {
            Ok(value) => Ok(Some(SecretString::from(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(secret_error(error)),
        }
    }

    pub fn set(
        &self,
        profile_id: ProfileId,
        kind: SecretKind,
        value: &str,
    ) -> Result<(), AppError> {
        self.entry(profile_id, kind)?
            .set_password(value)
            .map_err(secret_error)
    }

    pub fn delete_profile(&self, profile_id: ProfileId) {
        for kind in [SecretKind::Password, SecretKind::PrivateKeyPassphrase] {
            if let Ok(entry) = self.entry(profile_id, kind) {
                let _ = entry.delete_credential();
            }
        }
    }
}

fn secret_error(source: keyring::Error) -> AppError {
    AppError::new(
        ErrorCode::SecretStoreUnavailable,
        "The operating system credential store is unavailable",
    )
    .with_detail(source.to_string())
}
