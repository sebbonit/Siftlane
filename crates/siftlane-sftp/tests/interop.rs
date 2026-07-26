use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use secrecy::SecretString;
use siftlane_core::RemoteFilesystem;
use siftlane_sftp::{
    HostKeyDecision, HostKeyVerifier, ObservedHostKey, SftpAuth, SftpClient, SftpConnectOptions,
};

struct AcceptConfiguredTestHost;

#[async_trait]
impl HostKeyVerifier for AcceptConfiguredTestHost {
    async fn classify(&self, _key: &ObservedHostKey) -> HostKeyDecision {
        HostKeyDecision::Trusted
    }
}

#[tokio::test]
#[ignore = "requires SIFTLANE_TEST_SFTP_* environment variables"]
async fn transfers_and_resumes_against_a_real_sftp_server() {
    let host = required("SIFTLANE_TEST_SFTP_HOST");
    let port = required("SIFTLANE_TEST_SFTP_PORT").parse().unwrap();
    let username = required("SIFTLANE_TEST_SFTP_USERNAME");
    let password = SecretString::from(required("SIFTLANE_TEST_SFTP_PASSWORD"));
    let root = required("SIFTLANE_TEST_SFTP_ROOT");
    let unique = format!("siftlane-interop-{}", std::process::id());
    let directory = format!("{}/{}", root.trim_end_matches('/'), unique);
    let original = format!("{directory}/resume.bin");
    let renamed = format!("{directory}/renamed.bin");

    let client = SftpClient::connect(
        SftpConnectOptions {
            host,
            port,
            username,
            auth: SftpAuth::Password(password),
            connect_timeout: Duration::from_secs(15),
            response_timeout: Duration::from_secs(30),
            keepalive_interval: Duration::from_secs(30),
            proxy: None,
            proxy_jump: None,
            agent_forwarding: false,
            algorithms: Default::default(),
        },
        Arc::new(AcceptConfiguredTestHost),
    )
    .await
    .expect("connect to integration SFTP server");

    client.create_directory(&directory).await.unwrap();
    client.write_chunk(&original, 0, b"first-").await.unwrap();
    client.write_chunk(&original, 6, b"second").await.unwrap();
    assert_eq!(
        client.read_chunk(&original, 0, 64).await.unwrap(),
        b"first-second"
    );
    assert_eq!(
        client.metadata(&original).await.unwrap().unwrap().size,
        Some(12)
    );
    client.rename(&original, &renamed).await.unwrap();
    assert!(client.metadata(&original).await.unwrap().is_none());
    client.remove_file(&renamed).await.unwrap();
    client.remove_directory(&directory).await.unwrap();
    client.disconnect().await.unwrap();
}

fn required(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is required"))
}
