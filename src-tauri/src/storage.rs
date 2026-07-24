use std::{fs, path::Path};

use rusqlite::{Connection, OptionalExtension, params};
use siftlane_core::{
    AppError, ConnectionProfile, ErrorCode, Favorite, FavoriteSide, Preferences, SavedAction,
    TransferJob,
};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct StoredHostKey {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint: String,
}

#[derive(Clone)]
pub struct Storage {
    path: std::path::PathBuf,
}

impl Storage {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, AppError> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(storage_io_error)?;
        }
        let storage = Self { path };
        storage.with_connection(migrate)?;
        Ok(storage)
    }

    fn with_connection<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> rusqlite::Result<T>,
    ) -> Result<T, AppError> {
        let mut connection = Connection::open(&self.path).map_err(storage_error)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(storage_error)?;
        connection
            .execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
            .map_err(storage_error)?;
        operation(&mut connection).map_err(storage_error)
    }

    pub fn list_profiles(&self) -> Result<Vec<ConnectionProfile>, AppError> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT profile_json FROM connection_profiles ORDER BY favorite DESC, label COLLATE NOCASE",
            )?;
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .map(|row| {
                    let json = row?;
                    serde_json::from_str(&json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })
                })
                .collect()
        })
    }

    pub fn get_profile(&self, id: uuid::Uuid) -> Result<ConnectionProfile, AppError> {
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT profile_json FROM connection_profiles WHERE id = ?1",
                    [id.to_string()],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .map(|json| {
                    serde_json::from_str(&json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })
                })
                .transpose()?
                .ok_or(rusqlite::Error::QueryReturnedNoRows)
        })
        .map_err(|error| {
            if error.code == ErrorCode::Storage
                && error
                    .detail
                    .as_deref()
                    .is_some_and(|detail| detail.contains("Query returned no rows"))
            {
                AppError::new(ErrorCode::NotFound, "The connection profile was not found")
            } else {
                error
            }
        })
    }

    pub fn save_profile(&self, profile: &ConnectionProfile) -> Result<(), AppError> {
        let json = serde_json::to_string(profile).map_err(serialization_error)?;
        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO connection_profiles (id, label, favorite, profile_json, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET label=excluded.label, favorite=excluded.favorite,
                 profile_json=excluded.profile_json, updated_at=excluded.updated_at",
                params![
                    profile.id.to_string(),
                    profile.label,
                    profile.favorite,
                    json,
                    profile.updated_at.to_rfc3339(),
                ],
            )?;
            Ok(())
        })
    }

    pub fn delete_profile(&self, id: uuid::Uuid) -> Result<(), AppError> {
        self.with_connection(|connection| {
            connection.execute(
                "DELETE FROM connection_profiles WHERE id = ?1",
                [id.to_string()],
            )?;
            Ok(())
        })
    }

    pub fn host_keys(&self, host: &str, port: u16) -> Result<Vec<StoredHostKey>, AppError> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT host, port, algorithm, fingerprint FROM known_hosts WHERE host = ?1 AND port = ?2",
            )?;
            statement
                .query_map(params![host, port], |row| {
                    Ok(StoredHostKey {
                        host: row.get(0)?,
                        port: row.get::<_, u16>(1)?,
                        algorithm: row.get(2)?,
                        fingerprint: row.get(3)?,
                    })
                })?
                .collect()
        })
    }

    pub fn trust_host_key(&self, key: &StoredHostKey) -> Result<(), AppError> {
        self.with_connection(|connection| {
            let transaction = connection.transaction()?;
            transaction.execute(
                "DELETE FROM known_hosts WHERE host = ?1 AND port = ?2 AND algorithm = ?3",
                params![key.host, key.port, key.algorithm],
            )?;
            transaction.execute(
                "INSERT INTO known_hosts (host, port, algorithm, fingerprint, first_seen_at, last_seen_at)
                 VALUES (?1, ?2, ?3, ?4, datetime('now'), datetime('now'))",
                params![key.host, key.port, key.algorithm, key.fingerprint],
            )?;
            transaction.commit()
        })
    }

    pub fn load_preferences(&self) -> Result<Preferences, AppError> {
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT value_json FROM preferences WHERE key = 'application'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .map(|json| {
                    serde_json::from_str(&json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })
                })
                .transpose()
                .map(|value| value.unwrap_or_default())
        })
    }

    pub fn save_preferences(&self, preferences: &Preferences) -> Result<(), AppError> {
        let json = serde_json::to_string(preferences).map_err(serialization_error)?;
        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO preferences (key, value_json) VALUES ('application', ?1)
                 ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
                [json],
            )?;
            Ok(())
        })
    }

    pub fn load_transfers(&self) -> Result<Vec<TransferJob>, AppError> {
        self.with_connection(|connection| {
            let mut statement =
                connection.prepare("SELECT job_json FROM transfer_jobs ORDER BY created_at")?;
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .map(|row| {
                    let json = row?;
                    serde_json::from_str(&json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })
                })
                .collect()
        })
    }

    pub fn save_transfer(&self, job: &TransferJob) -> Result<(), AppError> {
        let json = serde_json::to_string(job).map_err(serialization_error)?;
        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO transfer_jobs (id, profile_id, state, job_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET state=excluded.state, job_json=excluded.job_json,
                 updated_at=excluded.updated_at",
                params![
                    job.id.to_string(),
                    job.profile_id.to_string(),
                    format!("{:?}", job.state).to_lowercase(),
                    json,
                    job.created_at.to_rfc3339(),
                    job.updated_at.to_rfc3339(),
                ],
            )?;
            Ok(())
        })
    }

    pub fn delete_transfers(&self, ids: &[Uuid]) -> Result<(), AppError> {
        if ids.is_empty() {
            return Ok(());
        }
        self.with_connection(|connection| {
            let mut statement = connection.prepare("DELETE FROM transfer_jobs WHERE id = ?1")?;
            for id in ids {
                statement.execute(params![id.to_string()])?;
            }
            Ok(())
        })
    }

    pub fn list_favorites(&self) -> Result<Vec<Favorite>, AppError> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id, profile_id, side, label, path FROM favorites
                 ORDER BY label COLLATE NOCASE, path COLLATE NOCASE",
            )?;
            statement
                .query_map([], |row| {
                    let id: String = row.get(0)?;
                    let profile_id: Option<String> = row.get(1)?;
                    let side: String = row.get(2)?;
                    let label: String = row.get(3)?;
                    let path: String = row.get(4)?;
                    Ok((id, profile_id, side, label, path))
                })?
                .map(|row| {
                    let (id, profile_id, side, label, path) = row?;
                    parse_favorite(id, profile_id, side, label, path)
                })
                .collect()
        })
    }

    pub fn find_favorite(
        &self,
        profile_id: Option<Uuid>,
        side: FavoriteSide,
        path: &str,
    ) -> Result<Option<Favorite>, AppError> {
        self.with_connection(|connection| {
            let side_value = favorite_side_value(side);
            let row = if let Some(profile_id) = profile_id {
                connection
                    .query_row(
                        "SELECT id, profile_id, side, label, path FROM favorites
                         WHERE profile_id = ?1 AND side = ?2 AND path = ?3",
                        params![profile_id.to_string(), side_value, path],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, Option<String>>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, String>(3)?,
                                row.get::<_, String>(4)?,
                            ))
                        },
                    )
                    .optional()?
            } else {
                connection
                    .query_row(
                        "SELECT id, profile_id, side, label, path FROM favorites
                         WHERE profile_id IS NULL AND side = ?1 AND path = ?2",
                        params![side_value, path],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, Option<String>>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, String>(3)?,
                                row.get::<_, String>(4)?,
                            ))
                        },
                    )
                    .optional()?
            };
            row.map(|(id, profile_id, side, label, path)| {
                parse_favorite(id, profile_id, side, label, path)
            })
            .transpose()
        })
    }

    pub fn save_favorite(&self, favorite: &Favorite) -> Result<(), AppError> {
        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO favorites (id, profile_id, side, label, path)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET profile_id=excluded.profile_id,
                 side=excluded.side, label=excluded.label, path=excluded.path",
                params![
                    favorite.id.to_string(),
                    favorite.profile_id.map(|id| id.to_string()),
                    favorite_side_value(favorite.side),
                    favorite.label,
                    favorite.path,
                ],
            )?;
            Ok(())
        })
    }

    pub fn delete_favorite(&self, id: Uuid) -> Result<(), AppError> {
        let removed = self.with_connection(|connection| {
            connection.execute("DELETE FROM favorites WHERE id = ?1", [id.to_string()])
        })?;
        if removed == 0 {
            return Err(AppError::new(
                ErrorCode::NotFound,
                "The bookmark was not found",
            ));
        }
        Ok(())
    }

    pub fn list_saved_actions(&self) -> Result<Vec<SavedAction>, AppError> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT action_json FROM saved_actions ORDER BY label COLLATE NOCASE, updated_at DESC",
            )?;
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .map(|row| {
                    let json = row?;
                    serde_json::from_str(&json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })
                })
                .collect()
        })
    }

    pub fn save_saved_action(&self, action: &SavedAction) -> Result<(), AppError> {
        let json = serde_json::to_string(action).map_err(serialization_error)?;
        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO saved_actions (id, label, action_json, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET label=excluded.label,
                 action_json=excluded.action_json, updated_at=excluded.updated_at",
                params![
                    action.id.to_string(),
                    action.label,
                    json,
                    action.updated_at.to_rfc3339(),
                ],
            )?;
            Ok(())
        })
    }

    pub fn delete_saved_action(&self, id: Uuid) -> Result<(), AppError> {
        let removed = self.with_connection(|connection| {
            connection.execute("DELETE FROM saved_actions WHERE id = ?1", [id.to_string()])
        })?;
        if removed == 0 {
            return Err(AppError::new(
                ErrorCode::NotFound,
                "The saved action was not found",
            ));
        }
        Ok(())
    }
}

fn migrate(connection: &mut Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "BEGIN;
         CREATE TABLE IF NOT EXISTS schema_migrations (
           version INTEGER PRIMARY KEY,
           applied_at TEXT NOT NULL DEFAULT (datetime('now'))
         );
         CREATE TABLE IF NOT EXISTS connection_profiles (
           id TEXT PRIMARY KEY,
           label TEXT NOT NULL,
           favorite INTEGER NOT NULL DEFAULT 0,
           profile_json TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS known_hosts (
           host TEXT NOT NULL,
           port INTEGER NOT NULL,
           algorithm TEXT NOT NULL,
           fingerprint TEXT NOT NULL,
           first_seen_at TEXT NOT NULL,
           last_seen_at TEXT NOT NULL,
           PRIMARY KEY (host, port, algorithm)
         );
         CREATE TABLE IF NOT EXISTS favorites (
           id TEXT PRIMARY KEY,
           profile_id TEXT,
           side TEXT NOT NULL,
           label TEXT NOT NULL,
           path TEXT NOT NULL,
           FOREIGN KEY(profile_id) REFERENCES connection_profiles(id) ON DELETE CASCADE
         );
         CREATE TABLE IF NOT EXISTS recent_sessions (
           profile_id TEXT PRIMARY KEY,
           local_path TEXT,
           remote_path TEXT,
           layout TEXT NOT NULL DEFAULT 'dual_pane',
           last_opened_at TEXT NOT NULL,
           FOREIGN KEY(profile_id) REFERENCES connection_profiles(id) ON DELETE CASCADE
         );
         CREATE TABLE IF NOT EXISTS transfer_jobs (
           id TEXT PRIMARY KEY,
           profile_id TEXT NOT NULL,
           state TEXT NOT NULL,
           job_json TEXT NOT NULL,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           FOREIGN KEY(profile_id) REFERENCES connection_profiles(id) ON DELETE CASCADE
         );
         CREATE TABLE IF NOT EXISTS transfer_items (
           id TEXT PRIMARY KEY,
           job_id TEXT NOT NULL,
           item_json TEXT NOT NULL,
           FOREIGN KEY(job_id) REFERENCES transfer_jobs(id) ON DELETE CASCADE
         );
         CREATE TABLE IF NOT EXISTS preferences (
           key TEXT PRIMARY KEY,
           value_json TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS saved_actions (
           id TEXT PRIMARY KEY,
           label TEXT NOT NULL,
           action_json TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );
         INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);
         COMMIT;",
    )?;

    let version_two_applied = connection
        .query_row(
            "SELECT 1 FROM schema_migrations WHERE version = 2",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !version_two_applied {
        // Bookmarks are per-connection; drop legacy universal (null profile) rows.
        connection.execute_batch(
            "BEGIN;
             DELETE FROM favorites WHERE profile_id IS NULL;
             INSERT INTO schema_migrations(version) VALUES (2);
             COMMIT;",
        )?;
    }
    Ok(())
}

fn storage_error(source: rusqlite::Error) -> AppError {
    AppError::new(
        ErrorCode::Storage,
        "The local Siftlane database operation failed",
    )
    .with_detail(source.to_string())
}

fn storage_io_error(source: std::io::Error) -> AppError {
    AppError::new(
        ErrorCode::Storage,
        "Could not create the Siftlane data directory",
    )
    .with_detail(source.to_string())
}

fn serialization_error(source: serde_json::Error) -> AppError {
    AppError::new(ErrorCode::Storage, "Could not serialize application data")
        .with_detail(source.to_string())
}

fn favorite_side_value(side: FavoriteSide) -> &'static str {
    match side {
        FavoriteSide::Local => "local",
        FavoriteSide::Remote => "remote",
    }
}

fn parse_favorite(
    id: String,
    profile_id: Option<String>,
    side: String,
    label: String,
    path: String,
) -> rusqlite::Result<Favorite> {
    let id = Uuid::parse_str(&id).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let profile_id = profile_id
        .map(|value| {
            Uuid::parse_str(&value).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    1,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })
        })
        .transpose()?;
    let side = match side.as_str() {
        "local" => FavoriteSide::Local,
        "remote" => FavoriteSide::Remote,
        other => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                2,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("unknown favorite side: {other}"),
                )),
            ));
        }
    };
    Ok(Favorite {
        id,
        profile_id,
        side,
        label,
        path,
    })
}

#[cfg(test)]
mod tests {
    use siftlane_core::{AuthRef, ConnectionProfile, Favorite, FavoriteSide};

    use super::Storage;

    #[test]
    fn profiles_round_trip_without_secrets() {
        let temp = tempfile::tempdir().unwrap();
        let storage = Storage::open(temp.path().join("siftlane.sqlite3")).unwrap();
        let profile = ConnectionProfile::new(
            "Test".into(),
            "example.com".into(),
            "deploy".into(),
            AuthRef::Password { remember: true },
        );
        storage.save_profile(&profile).unwrap();
        assert_eq!(storage.list_profiles().unwrap(), vec![profile]);
    }

    #[test]
    fn favorites_round_trip_and_lookup() {
        let temp = tempfile::tempdir().unwrap();
        let storage = Storage::open(temp.path().join("siftlane.sqlite3")).unwrap();
        let profile = ConnectionProfile::new(
            "Test".into(),
            "example.com".into(),
            "deploy".into(),
            AuthRef::Password { remember: true },
        );
        storage.save_profile(&profile).unwrap();

        let remote = Favorite::new(
            Some(profile.id),
            FavoriteSide::Remote,
            "html".into(),
            "/var/www/html".into(),
        );
        let local = Favorite::new(
            Some(profile.id),
            FavoriteSide::Local,
            "Projects".into(),
            "/Users/me/Projects".into(),
        );
        storage.save_favorite(&remote).unwrap();
        storage.save_favorite(&local).unwrap();

        let listed = storage.list_favorites().unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(
            storage
                .find_favorite(Some(profile.id), FavoriteSide::Remote, "/var/www/html")
                .unwrap()
                .unwrap()
                .id,
            remote.id
        );
        assert_eq!(
            storage
                .find_favorite(Some(profile.id), FavoriteSide::Local, "/Users/me/Projects")
                .unwrap()
                .unwrap()
                .id,
            local.id
        );

        storage.delete_favorite(remote.id).unwrap();
        assert_eq!(storage.list_favorites().unwrap(), vec![local]);
    }

    #[test]
    fn migration_removes_universal_bookmarks() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("siftlane.sqlite3");
        {
            let connection = rusqlite::Connection::open(&db_path).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE schema_migrations (
                       version INTEGER PRIMARY KEY,
                       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
                     );
                     CREATE TABLE connection_profiles (
                       id TEXT PRIMARY KEY,
                       label TEXT NOT NULL,
                       favorite INTEGER NOT NULL DEFAULT 0,
                       profile_json TEXT NOT NULL,
                       updated_at TEXT NOT NULL
                     );
                     CREATE TABLE favorites (
                       id TEXT PRIMARY KEY,
                       profile_id TEXT,
                       side TEXT NOT NULL,
                       label TEXT NOT NULL,
                       path TEXT NOT NULL
                     );
                     INSERT INTO schema_migrations(version) VALUES (1);
                     INSERT INTO favorites(id, profile_id, side, label, path)
                     VALUES ('legacy', NULL, 'local', 'Home', '/Users/me');",
                )
                .unwrap();
        }

        let storage = Storage::open(&db_path).unwrap();
        assert!(storage.list_favorites().unwrap().is_empty());
    }
}
