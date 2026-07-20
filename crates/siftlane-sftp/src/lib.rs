//! Russh-backed SFTP adapter.

mod client;

pub use client::{
    HostKeyDecision, HostKeyVerifier, ObservedHostKey, SftpAuth, SftpClient, SftpConnectError,
    SftpConnectOptions,
};
