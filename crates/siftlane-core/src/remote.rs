use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use secrecy::SecretString;

use crate::{AppError, FileEntry};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteCapabilities {
    pub chmod: bool,
    pub symlinks: bool,
    pub fsync: bool,
    pub resume: bool,
    pub atomic_rename: bool,
}

#[async_trait]
pub trait RemoteFilesystem: Send + Sync {
    fn capabilities(&self) -> RemoteCapabilities;
    async fn disconnect(&self) -> Result<(), AppError>;
    async fn list_directory(&self, path: &str) -> Result<Vec<FileEntry>, AppError>;
    async fn metadata(&self, path: &str) -> Result<Option<FileEntry>, AppError>;
    async fn create_directory(&self, path: &str) -> Result<(), AppError>;
    async fn rename(&self, from: &str, to: &str) -> Result<(), AppError>;
    async fn remove_file(&self, path: &str) -> Result<(), AppError>;
    async fn remove_directory(&self, path: &str) -> Result<(), AppError>;
    async fn set_permissions(&self, path: &str, permissions: u32) -> Result<(), AppError>;
    async fn read_chunk(&self, path: &str, offset: u64, length: u32) -> Result<Vec<u8>, AppError>;
    async fn write_chunk(&self, path: &str, offset: u64, data: &[u8]) -> Result<(), AppError>;
    async fn sync_file(&self, path: &str) -> Result<(), AppError>;
    async fn read_privileged(
        &self,
        path: &str,
        password: Option<&SecretString>,
    ) -> Result<Vec<u8>, AppError>;
    async fn write_privileged(
        &self,
        path: &str,
        content: &[u8],
        password: Option<&SecretString>,
    ) -> Result<(), AppError>;
    async fn create_privileged(
        &self,
        path: &str,
        directory: bool,
        password: Option<&SecretString>,
    ) -> Result<(), AppError>;
    async fn delete_privileged(
        &self,
        path: &str,
        directory: bool,
        password: Option<&SecretString>,
    ) -> Result<(), AppError>;
}
