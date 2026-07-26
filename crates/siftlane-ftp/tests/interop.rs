use std::time::Duration;

use secrecy::SecretString;
use siftlane_core::RemoteFilesystem;
use siftlane_ftp::{FtpClient, FtpConnectOptions, FtpSecurity};

#[tokio::test]
#[ignore = "requires SIFTLANE_TEST_FTP_* environment variables"]
async fn transfers_and_resumes_against_a_real_ftp_or_ftps_server() {
    let host = required("SIFTLANE_TEST_FTP_HOST");
    let port = required("SIFTLANE_TEST_FTP_PORT").parse().unwrap();
    let username = required("SIFTLANE_TEST_FTP_USERNAME");
    let password = SecretString::from(required("SIFTLANE_TEST_FTP_PASSWORD"));
    let root = required("SIFTLANE_TEST_FTP_ROOT");
    let security = match std::env::var("SIFTLANE_TEST_FTP_SECURITY").as_deref() {
        Ok("explicit_tls") => FtpSecurity::ExplicitTls,
        Ok("plain") | Err(_) => FtpSecurity::Plain,
        Ok(value) => panic!("unsupported SIFTLANE_TEST_FTP_SECURITY={value}"),
    };
    let unique = format!("siftlane-interop-{}", std::process::id());
    let directory = format!("{}/{}", root.trim_end_matches('/'), unique);
    let original = format!("{directory}/resume.bin");
    let renamed = format!("{directory}/renamed.bin");

    let client = FtpClient::connect(FtpConnectOptions {
        host,
        port,
        username,
        password,
        security,
        connect_timeout: Duration::from_secs(15),
    })
    .await
    .expect("connect to integration FTP server");

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
