//! FTP and explicit FTPS adapter.

use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use chrono::{DateTime, NaiveDateTime, Utc};
use secrecy::{ExposeSecret, SecretString};
use siftlane_core::{
    AppError, EntryKind, ErrorCode, FileEntry, RemoteCapabilities, RemoteFilesystem,
};
use suppaftp::{
    tokio::{AsyncFtpStream, AsyncNativeTlsConnector, AsyncNativeTlsFtpStream},
    types::{FtpError, Status},
};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, sync::Mutex, time::timeout};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FtpSecurity {
    Plain,
    ExplicitTls,
}

pub struct FtpConnectOptions {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: SecretString,
    pub security: FtpSecurity,
    pub connect_timeout: Duration,
}

enum FtpSession {
    Plain(AsyncFtpStream),
    ExplicitTls(AsyncNativeTlsFtpStream),
}

pub struct FtpClient {
    session: Arc<Mutex<Option<FtpSession>>>,
}

impl FtpClient {
    pub async fn connect(options: FtpConnectOptions) -> Result<Self, AppError> {
        let address = format!("{}:{}", options.host, options.port);
        let session = match options.security {
            FtpSecurity::Plain => {
                let mut stream = timeout(options.connect_timeout, AsyncFtpStream::connect(address))
                    .await
                    .map_err(|_| timed_out())
                    .and_then(|result| result.map_err(map_ftp_error))?;
                stream
                    .login(&options.username, options.password.expose_secret())
                    .await
                    .map_err(map_ftp_error)?;
                FtpSession::Plain(stream)
            }
            FtpSecurity::ExplicitTls => {
                let stream = timeout(options.connect_timeout, AsyncNativeTlsFtpStream::connect(address))
                    .await
                    .map_err(|_| timed_out())
                    .and_then(|result| result.map_err(map_ftp_error))?;
                let connector = AsyncNativeTlsConnector::from(async_native_tls::TlsConnector::new());
                let mut stream = stream
                    .into_secure(connector, &options.host)
                    .await
                    .map_err(map_ftp_error)?;
                stream
                    .login(&options.username, options.password.expose_secret())
                    .await
                    .map_err(map_ftp_error)?;
                FtpSession::ExplicitTls(stream)
            }
        };
        Ok(Self { session: Arc::new(Mutex::new(Some(session))) })
    }

    async fn with_session<T>(
        &self,
        operation: impl AsyncFnOnce(&mut FtpSession) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let mut session = self.session.lock().await;
        let session = session.as_mut().ok_or_else(|| {
            AppError::new(ErrorCode::ConnectionClosed, "The FTP session is not connected")
        })?;
        operation(session).await
    }
}

#[async_trait]
impl RemoteFilesystem for FtpClient {
    fn capabilities(&self) -> RemoteCapabilities {
        RemoteCapabilities {
            chmod: false,
            symlinks: false,
            fsync: false,
            resume: true,
            atomic_rename: false,
        }
    }

    async fn disconnect(&self) -> Result<(), AppError> {
        let mut session = self.session.lock().await;
        let Some(mut session) = session.take() else { return Ok(()); };
        match &mut session {
            FtpSession::Plain(stream) => stream.quit().await,
            FtpSession::ExplicitTls(stream) => stream.quit().await,
        }
        .map_err(map_ftp_error)
    }

    async fn list_directory(&self, path: &str) -> Result<Vec<FileEntry>, AppError> {
        self.with_session(async |session| {
            let lines = match session {
                FtpSession::Plain(stream) => stream.mlsd(Some(path)).await,
                FtpSession::ExplicitTls(stream) => stream.mlsd(Some(path)).await,
            };
            let mut entries = match lines {
                Ok(lines) => lines.into_iter().filter_map(|line| parse_mlsx(&line, path)).collect(),
                Err(_) => {
                    let names = match session {
                        FtpSession::Plain(stream) => stream.nlst(Some(path)).await,
                        FtpSession::ExplicitTls(stream) => stream.nlst(Some(path)).await,
                    }.map_err(map_ftp_error)?;
                    names.into_iter().filter_map(|name| fallback_entry(path, &name)).collect()
                }
            };
            entries.sort_by(|left: &FileEntry, right: &FileEntry| {
                (right.kind == EntryKind::Directory).cmp(&(left.kind == EntryKind::Directory))
                    .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            });
            Ok(entries)
        }).await
    }

    async fn metadata(&self, path: &str) -> Result<Option<FileEntry>, AppError> {
        self.with_session(async |session| {
            let details = match session {
                FtpSession::Plain(stream) => stream.mlst(Some(path)).await,
                FtpSession::ExplicitTls(stream) => stream.mlst(Some(path)).await,
            };
            match details {
                Ok(value) => Ok(parse_mlsx(&value, parent_path(path))),
                Err(error) if is_missing(&error) => Ok(None),
                Err(error) => Err(map_ftp_error(error)),
            }
        }).await
    }

    async fn create_directory(&self, path: &str) -> Result<(), AppError> {
        self.with_session(async |session| match session {
            FtpSession::Plain(stream) => stream.mkdir(path).await.map_err(map_ftp_error),
            FtpSession::ExplicitTls(stream) => stream.mkdir(path).await.map_err(map_ftp_error),
        }).await
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), AppError> {
        self.with_session(async |session| match session {
            FtpSession::Plain(stream) => stream.rename(from, to).await.map_err(map_ftp_error),
            FtpSession::ExplicitTls(stream) => stream.rename(from, to).await.map_err(map_ftp_error),
        }).await
    }

    async fn remove_file(&self, path: &str) -> Result<(), AppError> {
        self.with_session(async |session| match session {
            FtpSession::Plain(stream) => stream.rm(path).await.map_err(map_ftp_error),
            FtpSession::ExplicitTls(stream) => stream.rm(path).await.map_err(map_ftp_error),
        }).await
    }

    async fn remove_directory(&self, path: &str) -> Result<(), AppError> {
        self.with_session(async |session| match session {
            FtpSession::Plain(stream) => stream.rmdir(path).await.map_err(map_ftp_error),
            FtpSession::ExplicitTls(stream) => stream.rmdir(path).await.map_err(map_ftp_error),
        }).await
    }

    async fn set_permissions(&self, _path: &str, _permissions: u32) -> Result<(), AppError> {
        Err(AppError::new(ErrorCode::Unsupported, "FTP servers do not provide portable permission changes"))
    }

    async fn read_chunk(&self, path: &str, offset: u64, length: u32) -> Result<Vec<u8>, AppError> {
        self.with_session(async |session| {
            let bytes = match session {
                FtpSession::Plain(stream) => read_chunk(stream, path, offset, length).await,
                FtpSession::ExplicitTls(stream) => read_chunk(stream, path, offset, length).await,
            };
            bytes.map_err(map_ftp_error)
        }).await
    }

    async fn write_chunk(&self, path: &str, offset: u64, data: &[u8]) -> Result<(), AppError> {
        self.with_session(async |session| {
            let outcome = match session {
                FtpSession::Plain(stream) => write_chunk(stream, path, offset, data).await,
                FtpSession::ExplicitTls(stream) => write_chunk(stream, path, offset, data).await,
            };
            outcome.map_err(map_ftp_error)
        }).await
    }

    async fn sync_file(&self, _path: &str) -> Result<(), AppError> { Ok(()) }
}

async fn read_chunk<T: suppaftp::tokio::TokioTlsStream + Send>(
    stream: &mut suppaftp::tokio::ImplAsyncFtpStream<T>, path: &str, offset: u64, length: u32,
) -> Result<Vec<u8>, FtpError> {
    if offset > 0 { stream.resume_transfer(offset as usize).await?; }
    let mut data = stream.retr_as_stream(path).await?;
    let mut bytes = Vec::with_capacity(length as usize);
    data.take(length as u64).read_to_end(&mut bytes).await.map_err(FtpError::ConnectionError)?;
    stream.finalize_retr_stream(data).await?;
    Ok(bytes)
}

async fn write_chunk<T: suppaftp::tokio::TokioTlsStream + Send>(
    stream: &mut suppaftp::tokio::ImplAsyncFtpStream<T>, path: &str, offset: u64, data: &[u8],
) -> Result<(), FtpError> {
    if offset > 0 { stream.resume_transfer(offset as usize).await?; }
    let mut data_stream = stream.put_with_stream(path).await?;
    data_stream.write_all(data).await.map_err(FtpError::ConnectionError)?;
    stream.finalize_put_stream(data_stream).await
}

fn parse_mlsx(value: &str, directory: &str) -> Option<FileEntry> {
    let (facts, name) = value.trim().split_once(' ')?;
    if name.is_empty() || matches!(name, "." | "..") { return None; }
    let mut kind = EntryKind::Other;
    let mut size = None;
    let mut modified_at = None;
    for fact in facts.split(';') {
        let (key, value) = fact.split_once('=')?;
        match key.to_ascii_lowercase().as_str() {
            "type" => kind = match value.to_ascii_lowercase().as_str() {
                "file" => EntryKind::File,
                "dir" => EntryKind::Directory,
                "cdir" | "pdir" => return None,
                _ => EntryKind::Other,
            },
            "size" => size = value.parse().ok(),
            "modify" => modified_at = NaiveDateTime::parse_from_str(value, "%Y%m%d%H%M%S")
                .ok().map(|time| DateTime::<Utc>::from_naive_utc_and_offset(time, Utc)),
            _ => {}
        }
    }
    Some(FileEntry { path: join_path(directory, name), name: name.to_string(), kind, size, modified_at, permissions: None, symlink_target: None, hidden: name.starts_with('.') })
}

fn fallback_entry(directory: &str, name: &str) -> Option<FileEntry> {
    let name = name.trim().rsplit('/').next()?;
    (!name.is_empty() && !matches!(name, "." | "..")).then(|| FileEntry {
        path: join_path(directory, name), name: name.to_string(), kind: EntryKind::Other,
        size: None, modified_at: None, permissions: None, symlink_target: None, hidden: name.starts_with('.'),
    })
}

fn join_path(directory: &str, name: &str) -> String {
    if directory == "/" { format!("/{name}") } else { format!("{}/{}", directory.trim_end_matches('/'), name) }
}

fn parent_path(path: &str) -> &str { path.rsplit_once('/').map(|(parent, _)| if parent.is_empty() { "/" } else { parent }).unwrap_or("/") }

fn is_missing(error: &FtpError) -> bool {
    matches!(error, FtpError::UnexpectedResponse(response) if response.status == Status::FileUnavailable)
}

fn timed_out() -> AppError { AppError::new(ErrorCode::TimedOut, "The FTP connection timed out").retryable() }

fn map_ftp_error(error: FtpError) -> AppError {
    let code = match &error {
        FtpError::ConnectionError(_) => ErrorCode::ConnectionFailed,
        FtpError::UnexpectedResponse(response) if response.status == Status::FileUnavailable => ErrorCode::NotFound,
        _ => ErrorCode::Io,
    };
    let message = match code {
        ErrorCode::ConnectionFailed => "Could not establish the FTP session",
        ErrorCode::NotFound => "The remote FTP path was not found",
        _ => "The FTP server could not complete the operation",
    };
    AppError::new(code, message).with_detail(error.to_string())
}
