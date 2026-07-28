use std::{borrow::Cow, path::PathBuf, sync::Arc, time::Duration};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use russh::{
    Channel, ChannelMsg, ChannelOpenFailure,
    client::{self, AuthResult, ChannelOpenHandle, Handle, Msg, Session},
    keys::{
        PrivateKeyWithHashAlg,
        agent::{AgentIdentity, client::AgentClient},
        ssh_key::{HashAlg, PublicKey},
    },
};
use russh_sftp::{
    client::SftpSession,
    protocol::{FileAttributes, FileType, OpenFlags},
};
use secrecy::{ExposeSecret, SecretString};
use siftlane_core::{
    AppError, ArchiveFormat, EntryKind, ErrorCode, FileEntry, RemoteCapabilities,
    RemoteCommandResult, RemoteFilesystem, SshAlgorithmPolicy, SshProxy, SshProxyKind,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWrite, AsyncWriteExt, SeekFrom},
    net::TcpStream,
    sync::Mutex,
    time::timeout,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedHostKey {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeyDecision {
    Trusted,
    Unknown,
    Changed,
}

#[async_trait]
pub trait HostKeyVerifier: Send + Sync {
    async fn classify(&self, key: &ObservedHostKey) -> HostKeyDecision;
}

#[derive(Clone)]
pub enum SftpAuth {
    Password(SecretString),
    PrivateKey {
        path: PathBuf,
        passphrase: Option<SecretString>,
    },
    Agent,
}

pub struct SftpConnectOptions {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SftpAuth,
    pub connect_timeout: Duration,
    pub response_timeout: Duration,
    pub keepalive_interval: Duration,
    pub proxy: Option<SshProxy>,
    pub proxy_jump: Option<SftpProxyJump>,
    pub agent_forwarding: bool,
    pub algorithms: SshAlgorithmPolicy,
}

#[derive(Clone)]
pub struct SftpProxyJump {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SftpAuth,
}

impl SftpConnectOptions {
    pub fn with_defaults(host: String, username: String, auth: SftpAuth) -> Self {
        Self {
            host,
            port: 22,
            username,
            auth,
            connect_timeout: Duration::from_secs(15),
            response_timeout: Duration::from_secs(30),
            keepalive_interval: Duration::from_secs(30),
            proxy: None,
            proxy_jump: None,
            agent_forwarding: false,
            algorithms: SshAlgorithmPolicy::default(),
        }
    }
}

#[derive(Debug)]
pub struct SftpConnectError {
    pub error: AppError,
    pub host_key: Option<ObservedHostKey>,
}

struct ClientHandler {
    host: String,
    port: u16,
    verifier: Arc<dyn HostKeyVerifier>,
    observation: Arc<Mutex<Option<(ObservedHostKey, HostKeyDecision)>>>,
    allow_agent_forwarding: bool,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let observed = ObservedHostKey {
            host: self.host.clone(),
            port: self.port,
            algorithm: server_public_key.algorithm().to_string(),
            fingerprint_sha256: server_public_key.fingerprint(HashAlg::Sha256).to_string(),
        };
        let decision = self.verifier.classify(&observed).await;
        *self.observation.lock().await = Some((observed, decision));
        Ok(decision == HostKeyDecision::Trusted)
    }

    fn server_channel_open_agent_forward(
        &mut self,
        channel: Channel<Msg>,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send {
        let allowed = self.allow_agent_forwarding;
        async move {
            if !allowed {
                reply
                    .reject(ChannelOpenFailure::AdministrativelyProhibited)
                    .await;
                return Ok(());
            }
            #[cfg(unix)]
            {
                let Some(socket_path) = std::env::var_os("SSH_AUTH_SOCK") else {
                    reply.reject(ChannelOpenFailure::ConnectFailed).await;
                    return Ok(());
                };
                let Ok(mut agent) = tokio::net::UnixStream::connect(socket_path).await else {
                    reply.reject(ChannelOpenFailure::ConnectFailed).await;
                    return Ok(());
                };
                reply.accept().await;
                tokio::spawn(async move {
                    let mut forwarded = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut forwarded, &mut agent).await;
                });
            }
            #[cfg(windows)]
            {
                let socket_path = std::env::var_os("SSH_AUTH_SOCK")
                    .unwrap_or_else(|| r"\\.\pipe\openssh-ssh-agent".into());
                let Ok(mut agent) =
                    tokio::net::windows::named_pipe::ClientOptions::new().open(socket_path)
                else {
                    reply.reject(ChannelOpenFailure::ConnectFailed).await;
                    return Ok(());
                };
                reply.accept().await;
                tokio::spawn(async move {
                    let mut forwarded = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut forwarded, &mut agent).await;
                });
            }
            Ok(())
        }
    }
}

pub struct SftpClient {
    sftp: SftpSession,
    _ssh: Mutex<Handle<ClientHandler>>,
    _proxy_jump: Option<Mutex<Handle<ClientHandler>>>,
    observed_host_keys: Vec<ObservedHostKey>,
    agent_forwarding: bool,
    /// Serialize SFTP requests. Concurrent calls on one `SftpSession` can fail
    /// with generic I/O errors (e.g. search overlapping pane listing).
    io: Mutex<()>,
}

const MAX_PRIVILEGED_OUTPUT_BYTES: usize = 4 * 1024 * 1024 + 1;

struct CommandOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    status: Option<u32>,
}

impl SftpClient {
    pub async fn connect(
        options: SftpConnectOptions,
        verifier: Arc<dyn HostKeyVerifier>,
    ) -> Result<Self, SftpConnectError> {
        let config =
            ssh_config(options.keepalive_interval, &options.algorithms).map_err(|error| {
                SftpConnectError {
                    error,
                    host_key: None,
                }
            })?;
        let (stream, proxy_jump, jump_observation) = if let Some(jump) = options.proxy_jump.clone()
        {
            let observation = Arc::new(Mutex::new(None));
            let handler = ClientHandler {
                host: jump.host.clone(),
                port: jump.port,
                verifier: verifier.clone(),
                observation: observation.clone(),
                allow_agent_forwarding: false,
            };
            let stream = open_tcp_stream(
                &jump.host,
                jump.port,
                options.proxy.as_ref(),
                options.connect_timeout,
            )
            .await
            .map_err(|error| SftpConnectError {
                error,
                host_key: None,
            })?;
            let connect = client::connect_stream(config.clone(), stream, handler);
            let mut handle = match timeout(options.connect_timeout, connect).await {
                Ok(Ok(handle)) => handle,
                Ok(Err(source)) => {
                    return Err(connect_error(
                        source.to_string(),
                        observation.lock().await.clone(),
                    ));
                }
                Err(_) => return Err(connect_timeout_error()),
            };
            authenticate(&mut handle, &jump.username, jump.auth)
                .await
                .map_err(|error| SftpConnectError {
                    error,
                    host_key: None,
                })?;
            let channel = handle
                .channel_open_direct_tcpip(
                    options.host.clone(),
                    u32::from(options.port),
                    "127.0.0.1",
                    0,
                )
                .await
                .map_err(|source| SftpConnectError {
                    error: connection_failure(format!(
                        "The bastion could not reach the destination: {source}"
                    )),
                    host_key: None,
                })?;
            (
                Box::new(channel.into_stream()) as BoxedStream,
                Some(handle),
                Some(observation),
            )
        } else {
            let stream = open_tcp_stream(
                &options.host,
                options.port,
                options.proxy.as_ref(),
                options.connect_timeout,
            )
            .await
            .map_err(|error| SftpConnectError {
                error,
                host_key: None,
            })?;
            (stream, None, None)
        };

        let observation = Arc::new(Mutex::new(None));
        let handler = ClientHandler {
            host: options.host.clone(),
            port: options.port,
            verifier,
            observation: observation.clone(),
            allow_agent_forwarding: options.agent_forwarding,
        };
        let connect = client::connect_stream(config, stream, handler);
        let mut ssh = match timeout(options.connect_timeout, connect).await {
            Ok(Ok(handle)) => handle,
            Ok(Err(source)) => {
                return Err(connect_error(
                    source.to_string(),
                    observation.lock().await.clone(),
                ));
            }
            Err(_) => return Err(connect_timeout_error()),
        };

        authenticate(&mut ssh, &options.username, options.auth)
            .await
            .map_err(|error| SftpConnectError {
                error,
                host_key: None,
            })?;

        let channel = ssh
            .channel_open_session()
            .await
            .map_err(|source| SftpConnectError {
                error: connection_failure(source.to_string()),
                host_key: None,
            })?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|source| SftpConnectError {
                error: connection_failure(source.to_string()),
                host_key: None,
            })?;
        let sftp = SftpSession::new(channel.into_stream())
            .await
            .map_err(|source| SftpConnectError {
                error: connection_failure(source.to_string()),
                host_key: None,
            })?;
        sftp.set_timeout(options.response_timeout.as_secs());

        let mut observed_host_keys = Vec::new();
        if let Some(observation) = jump_observation
            && let Some((key, _)) = observation.lock().await.clone()
        {
            observed_host_keys.push(key);
        }
        if let Some((key, _)) = observation.lock().await.clone() {
            observed_host_keys.push(key);
        }

        Ok(Self {
            sftp,
            _ssh: Mutex::new(ssh),
            _proxy_jump: proxy_jump.map(Mutex::new),
            observed_host_keys,
            agent_forwarding: options.agent_forwarding,
            io: Mutex::new(()),
        })
    }

    pub fn observed_host_keys(&self) -> &[ObservedHostKey] {
        &self.observed_host_keys
    }

    pub async fn disconnect(&self) -> Result<(), AppError> {
        let _guard = self.io.lock().await;
        self.sftp
            .close()
            .await
            .map_err(|source| connection_failure(source.to_string()))
    }

    async fn execute_command(
        &self,
        command: String,
        input: Option<Vec<u8>>,
    ) -> Result<CommandOutput, AppError> {
        let mut channel = {
            let ssh = self._ssh.lock().await;
            ssh.channel_open_session()
                .await
                .map_err(|source| connection_failure(source.to_string()))?
        };
        if self.agent_forwarding {
            channel
                .agent_forward(true)
                .await
                .map_err(|source| connection_failure(source.to_string()))?;
        }
        channel
            .exec(true, command)
            .await
            .map_err(|source| connection_failure(source.to_string()))?;
        if let Some(input) = input {
            channel
                .data_bytes(input)
                .await
                .map_err(|source| connection_failure(source.to_string()))?;
        }
        channel
            .eof()
            .await
            .map_err(|source| connection_failure(source.to_string()))?;

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut status = None;
        loop {
            let message = if status.is_some() {
                match timeout(Duration::from_secs(1), channel.wait()).await {
                    Ok(message) => message,
                    Err(_) => break,
                }
            } else {
                channel.wait().await
            };
            let Some(message) = message else { break };
            match message {
                ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                _ => {}
            }
            if stdout.len() + stderr.len() > MAX_PRIVILEGED_OUTPUT_BYTES {
                let _ = channel.close().await;
                return Err(AppError::new(
                    ErrorCode::InvalidInput,
                    "Privileged files larger than 4 MB cannot be edited in Siftlane",
                ));
            }
        }
        let _ = channel.close().await;
        Ok(CommandOutput {
            stdout,
            stderr,
            status,
        })
    }

    async fn execute_with_sudo(
        &self,
        no_password_command: String,
        password_command: String,
        password: Option<&SecretString>,
        content: &[u8],
    ) -> Result<CommandOutput, AppError> {
        let probe = self.execute_command(privileged_probe(false), None).await?;
        if probe.status == Some(0) {
            return self
                .execute_command(no_password_command, Some(content.to_vec()))
                .await;
        }
        let Some(password) = password else {
            return Err(privileged_error(&probe));
        };
        let mut input = password.expose_secret().as_bytes().to_vec();
        input.push(b'\n');
        input.extend_from_slice(content);
        self.execute_command(password_command, Some(input)).await
    }
}

trait AsyncStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> AsyncStream for T {}
type BoxedStream = Box<dyn AsyncStream>;

fn connect_timeout_error() -> SftpConnectError {
    SftpConnectError {
        error: AppError::new(ErrorCode::TimedOut, "The SSH connection timed out").retryable(),
        host_key: None,
    }
}

fn ssh_config(
    keepalive_interval: Duration,
    algorithms: &SshAlgorithmPolicy,
) -> Result<Arc<client::Config>, AppError> {
    let mut preferred = russh::Preferred::default();
    if !algorithms.key_exchange.is_empty() {
        preferred.kex = Cow::Owned(parse_names(
            &algorithms.key_exchange,
            "key exchange",
            |name| russh::kex::Name::try_from(name),
        )?);
    }
    if !algorithms.host_keys.is_empty() {
        preferred.key = Cow::Owned(
            algorithms
                .host_keys
                .iter()
                .map(|name| name.parse())
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| invalid_algorithm("host key"))?,
        );
    }
    if !algorithms.ciphers.is_empty() {
        preferred.cipher = Cow::Owned(parse_names(&algorithms.ciphers, "cipher", |name| {
            russh::cipher::Name::try_from(name)
        })?);
    }
    if !algorithms.macs.is_empty() {
        preferred.mac = Cow::Owned(parse_names(&algorithms.macs, "MAC", |name| {
            russh::mac::Name::try_from(name)
        })?);
    }
    Ok(Arc::new(client::Config {
        keepalive_interval: Some(keepalive_interval),
        keepalive_max: 3,
        nodelay: true,
        preferred,
        ..Default::default()
    }))
}

fn parse_names<T: Copy>(
    names: &[String],
    kind: &str,
    parser: impl Fn(&str) -> Result<T, ()>,
) -> Result<Vec<T>, AppError> {
    names
        .iter()
        .map(|name| parser(name).map_err(|()| invalid_algorithm(kind)))
        .collect()
}

fn invalid_algorithm(kind: &str) -> AppError {
    AppError::new(
        ErrorCode::InvalidInput,
        format!("The SSH {kind} policy contains an unsupported algorithm"),
    )
}

async fn open_tcp_stream(
    host: &str,
    port: u16,
    proxy: Option<&SshProxy>,
    connect_timeout: Duration,
) -> Result<BoxedStream, AppError> {
    let endpoint = proxy
        .map(|value| (value.host.as_str(), value.port))
        .unwrap_or((host, port));
    let mut stream = timeout(connect_timeout, TcpStream::connect(endpoint))
        .await
        .map_err(|_| {
            AppError::new(ErrorCode::TimedOut, "The TCP connection timed out").retryable()
        })?
        .map_err(|source| connection_failure(source.to_string()))?;
    stream
        .set_nodelay(true)
        .map_err(|source| connection_failure(source.to_string()))?;
    if let Some(proxy) = proxy {
        match proxy.kind {
            SshProxyKind::Socks5 => socks5_connect(&mut stream, host, port).await?,
            SshProxyKind::HttpConnect => http_connect(&mut stream, host, port).await?,
        }
    }
    Ok(Box::new(stream))
}

async fn socks5_connect(stream: &mut TcpStream, host: &str, port: u16) -> Result<(), AppError> {
    if host.len() > u8::MAX as usize {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "The SOCKS destination hostname is too long",
        ));
    }
    stream
        .write_all(&[5, 1, 0])
        .await
        .map_err(|source| connection_failure(source.to_string()))?;
    let mut greeting = [0_u8; 2];
    stream
        .read_exact(&mut greeting)
        .await
        .map_err(|source| connection_failure(source.to_string()))?;
    if greeting != [5, 0] {
        return Err(connection_failure(
            "The SOCKS5 proxy requires an unsupported authentication method",
        ));
    }
    let mut request = Vec::with_capacity(host.len() + 7);
    request.extend_from_slice(&[5, 1, 0, 3, host.len() as u8]);
    request.extend_from_slice(host.as_bytes());
    request.extend_from_slice(&port.to_be_bytes());
    stream
        .write_all(&request)
        .await
        .map_err(|source| connection_failure(source.to_string()))?;
    let mut response = [0_u8; 4];
    stream
        .read_exact(&mut response)
        .await
        .map_err(|source| connection_failure(source.to_string()))?;
    if response[0] != 5 || response[1] != 0 {
        return Err(connection_failure(format!(
            "The SOCKS5 proxy rejected the destination (code {})",
            response[1]
        )));
    }
    let address_length = match response[3] {
        1 => 4,
        3 => {
            let mut length = [0_u8; 1];
            stream
                .read_exact(&mut length)
                .await
                .map_err(|source| connection_failure(source.to_string()))?;
            usize::from(length[0])
        }
        4 => 16,
        _ => {
            return Err(connection_failure(
                "The SOCKS5 proxy returned an invalid address",
            ));
        }
    };
    let mut ignored = vec![0_u8; address_length + 2];
    stream
        .read_exact(&mut ignored)
        .await
        .map_err(|source| connection_failure(source.to_string()))?;
    Ok(())
}

async fn http_connect(stream: &mut TcpStream, host: &str, port: u16) -> Result<(), AppError> {
    let authority = format!("{host}:{port}");
    let request = format!(
        "CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\nProxy-Connection: keep-alive\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|source| connection_failure(source.to_string()))?;
    let mut response = Vec::with_capacity(256);
    while !response.ends_with(b"\r\n\r\n") {
        if response.len() >= 16 * 1024 {
            return Err(connection_failure(
                "The HTTP proxy returned an oversized response",
            ));
        }
        let byte = stream
            .read_u8()
            .await
            .map_err(|source| connection_failure(source.to_string()))?;
        response.push(byte);
    }
    let status = String::from_utf8_lossy(&response);
    let accepted = status
        .lines()
        .next()
        .is_some_and(|line| line.split_whitespace().nth(1) == Some("200"));
    if !accepted {
        return Err(connection_failure(
            "The HTTP proxy rejected the CONNECT request",
        ));
    }
    Ok(())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn privileged_command(program: &str, path: &str, password: bool) -> String {
    let sudo = if password {
        "sudo -k && sudo -S -p ''"
    } else {
        "sudo -n"
    };
    format!(
        "{sudo} -- sh -c 'exec {} \"$1\"' sh {}",
        program,
        shell_quote(path)
    )
}

fn privileged_probe(password: bool) -> String {
    if password {
        "sudo -k && sudo -S -p '' -- true".to_string()
    } else {
        "sudo -n -- true".to_string()
    }
}

fn privileged_shell_command(script: &str, path: &str, password: bool) -> String {
    let sudo = if password {
        "sudo -k && sudo -S -p ''"
    } else {
        "sudo -n"
    };
    format!(
        "{sudo} -- sh -c {} sh {}",
        shell_quote(script),
        shell_quote(path)
    )
}

fn privileged_error(output: &CommandOutput) -> AppError {
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let lower = detail.to_ascii_lowercase();
    let code = if lower.contains("password") || lower.contains("authentication") {
        ErrorCode::AuthenticationFailed
    } else if lower.contains("not allowed") || lower.contains("not permitted") {
        ErrorCode::PermissionDenied
    } else if lower.contains("not found") || lower.contains("no such file") {
        ErrorCode::NotFound
    } else {
        ErrorCode::PermissionDenied
    };
    AppError::new(code, "The remote sudo operation failed").with_detail(detail)
}

fn connect_error(
    source: String,
    observation: Option<(ObservedHostKey, HostKeyDecision)>,
) -> SftpConnectError {
    match observation {
        Some((key, HostKeyDecision::Unknown)) => SftpConnectError {
            error: AppError::new(
                ErrorCode::HostKeyUnknown,
                "The server host key is not trusted",
            ),
            host_key: Some(key),
        },
        Some((key, HostKeyDecision::Changed)) => SftpConnectError {
            error: AppError::new(
                ErrorCode::HostKeyChanged,
                "The server host key differs from the trusted key",
            ),
            host_key: Some(key),
        },
        _ => SftpConnectError {
            error: connection_failure(source),
            host_key: None,
        },
    }
}

async fn authenticate(
    ssh: &mut Handle<ClientHandler>,
    username: &str,
    auth: SftpAuth,
) -> Result<(), AppError> {
    let result = match auth {
        SftpAuth::Password(password) => ssh
            .authenticate_password(username, password.expose_secret())
            .await
            .map_err(|source| authentication_failure(source.to_string()))?,
        SftpAuth::PrivateKey { path, passphrase } => {
            let key = russh::keys::load_secret_key(
                &path,
                passphrase.as_ref().map(|value| value.expose_secret()),
            )
            .map_err(|source| {
                authentication_failure(format!("Could not open the selected private key: {source}"))
            })?;
            let hash = if key.algorithm().is_rsa() {
                ssh.best_supported_rsa_hash()
                    .await
                    .map_err(|source| authentication_failure(source.to_string()))?
                    .flatten()
            } else {
                None
            };
            ssh.authenticate_publickey(username, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await
                .map_err(|source| authentication_failure(source.to_string()))?
        }
        SftpAuth::Agent => authenticate_with_agent(ssh, username).await?,
    };

    if result.success() {
        Ok(())
    } else {
        Err(authentication_failure(
            "The server rejected the selected authentication method",
        ))
    }
}

#[cfg(unix)]
async fn authenticate_with_agent(
    ssh: &mut Handle<ClientHandler>,
    username: &str,
) -> Result<AuthResult, AppError> {
    let mut agent = AgentClient::connect_env()
        .await
        .map_err(|source| authentication_failure(format!("SSH agent unavailable: {source}")))?;
    try_agent_identities(ssh, username, &mut agent).await
}

#[cfg(windows)]
async fn authenticate_with_agent(
    ssh: &mut Handle<ClientHandler>,
    username: &str,
) -> Result<AuthResult, AppError> {
    let openssh_result = async {
        let mut agent = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent")
            .await
            .ok()?;
        let result = try_agent_identities(ssh, username, &mut agent).await.ok()?;
        result.success().then_some(result)
    }
    .await;
    if let Some(result) = openssh_result {
        return Ok(result);
    }
    let mut agent = AgentClient::connect_pageant()
        .await
        .map_err(|source| authentication_failure(format!("SSH agent unavailable: {source}")))?;
    try_agent_identities(ssh, username, &mut agent).await
}

async fn try_agent_identities<S>(
    ssh: &mut Handle<ClientHandler>,
    username: &str,
    agent: &mut AgentClient<S>,
) -> Result<AuthResult, AppError>
where
    S: russh::keys::agent::client::AgentStream + Send + Unpin,
{
    let identities = agent
        .request_identities()
        .await
        .map_err(|source| authentication_failure(source.to_string()))?;
    for identity in identities {
        let key = identity.public_key().into_owned();
        let hash = if key.algorithm().is_rsa() {
            ssh.best_supported_rsa_hash()
                .await
                .map_err(|source| authentication_failure(source.to_string()))?
                .flatten()
        } else {
            None
        };
        let result = match identity {
            AgentIdentity::PublicKey { .. } => {
                ssh.authenticate_publickey_with(username, key, hash, agent)
                    .await
            }
            AgentIdentity::Certificate { certificate, .. } => {
                ssh.authenticate_certificate_with(username, certificate, hash, agent)
                    .await
            }
        }
        .map_err(|source| authentication_failure(source.to_string()))?;
        if result.success() {
            return Ok(result);
        }
    }
    Err(authentication_failure(
        "No identity in the SSH agent was accepted",
    ))
}

#[async_trait]
impl RemoteFilesystem for SftpClient {
    fn capabilities(&self) -> RemoteCapabilities {
        RemoteCapabilities {
            chmod: true,
            symlinks: true,
            fsync: true,
            resume: true,
            atomic_rename: false,
        }
    }

    async fn disconnect(&self) -> Result<(), AppError> {
        SftpClient::disconnect(self).await
    }

    async fn list_directory(&self, path: &str) -> Result<Vec<FileEntry>, AppError> {
        let _guard = self.io.lock().await;
        let entries = self.sftp.read_dir(path).await.map_err(map_sftp_error)?;
        let mut result = Vec::new();
        for entry in entries {
            let name = entry.file_name();
            let path = entry.path();
            let metadata = entry.metadata();
            let kind = match entry.file_type() {
                FileType::Dir => EntryKind::Directory,
                FileType::File => EntryKind::File,
                FileType::Symlink => EntryKind::Symlink,
                FileType::Other => EntryKind::Other,
            };
            let symlink_target = if kind == EntryKind::Symlink {
                self.sftp.read_link(path.clone()).await.ok()
            } else {
                None
            };
            result.push(FileEntry {
                path,
                hidden: name.starts_with('.'),
                name,
                kind,
                size: if kind == EntryKind::Directory {
                    None
                } else {
                    metadata.size
                },
                modified_at: metadata.modified().ok().map(DateTime::<Utc>::from),
                permissions: metadata.permissions.map(|mode| mode & 0o7777),
                symlink_target,
            });
        }
        result.sort_by_cached_key(|entry| {
            (
                entry.kind != EntryKind::Directory,
                entry.name.to_lowercase(),
            )
        });
        Ok(result)
    }

    async fn metadata(&self, path: &str) -> Result<Option<FileEntry>, AppError> {
        let _guard = self.io.lock().await;
        let metadata = match self.sftp.symlink_metadata(path).await {
            Ok(metadata) => metadata,
            Err(russh_sftp::client::error::Error::Status(status))
                if status.status_code == russh_sftp::protocol::StatusCode::NoSuchFile =>
            {
                return Ok(None);
            }
            Err(error) => return Err(map_sftp_error(error)),
        };
        let name = path.rsplit('/').next().unwrap_or(path).to_string();
        let kind = match metadata.file_type() {
            FileType::Dir => EntryKind::Directory,
            FileType::File => EntryKind::File,
            FileType::Symlink => EntryKind::Symlink,
            FileType::Other => EntryKind::Other,
        };
        let symlink_target = if kind == EntryKind::Symlink {
            self.sftp.read_link(path).await.ok()
        } else {
            None
        };
        Ok(Some(FileEntry {
            path: path.to_string(),
            hidden: name.starts_with('.'),
            name,
            kind,
            size: metadata.size,
            modified_at: metadata.modified().ok().map(DateTime::<Utc>::from),
            permissions: metadata.permissions.map(|mode| mode & 0o7777),
            symlink_target,
        }))
    }

    async fn create_directory(&self, path: &str) -> Result<(), AppError> {
        let _guard = self.io.lock().await;
        self.sftp.create_dir(path).await.map_err(map_sftp_error)
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), AppError> {
        let _guard = self.io.lock().await;
        self.sftp.rename(from, to).await.map_err(map_sftp_error)
    }

    async fn remove_file(&self, path: &str) -> Result<(), AppError> {
        let _guard = self.io.lock().await;
        self.sftp.remove_file(path).await.map_err(map_sftp_error)
    }

    async fn remove_directory(&self, path: &str) -> Result<(), AppError> {
        let _guard = self.io.lock().await;
        self.sftp.remove_dir(path).await.map_err(map_sftp_error)
    }

    async fn set_permissions(&self, path: &str, permissions: u32) -> Result<(), AppError> {
        let _guard = self.io.lock().await;
        let mut metadata = self
            .sftp
            .symlink_metadata(path)
            .await
            .map_err(map_sftp_error)?;
        let file_type = metadata.permissions.unwrap_or_default() & !0o7777;
        metadata.permissions = Some(file_type | (permissions & 0o7777));
        self.sftp
            .set_metadata(path, metadata)
            .await
            .map_err(map_sftp_error)
    }

    async fn create_symlink(&self, path: &str, target: &str) -> Result<(), AppError> {
        let _guard = self.io.lock().await;
        self.sftp
            .symlink(path, target)
            .await
            .map_err(map_sftp_error)
    }

    async fn read_chunk(&self, path: &str, offset: u64, length: u32) -> Result<Vec<u8>, AppError> {
        let _guard = self.io.lock().await;
        let mut file = self.sftp.open(path).await.map_err(map_sftp_error)?;
        file.seek(SeekFrom::Start(offset))
            .await
            .map_err(map_io_error)?;
        let mut bytes = vec![0; length as usize];
        let read = file.read(&mut bytes).await.map_err(map_io_error)?;
        bytes.truncate(read);
        file.shutdown().await.map_err(map_io_error)?;
        Ok(bytes)
    }

    async fn write_chunk(&self, path: &str, offset: u64, data: &[u8]) -> Result<(), AppError> {
        let _guard = self.io.lock().await;
        let mut file = self
            .sftp
            .open_with_flags(path, OpenFlags::CREATE | OpenFlags::WRITE)
            .await
            .map_err(map_sftp_error)?;
        file.seek(SeekFrom::Start(offset))
            .await
            .map_err(map_io_error)?;
        file.write_all(data).await.map_err(map_io_error)?;
        file.flush().await.map_err(map_io_error)?;
        file.shutdown().await.map_err(map_io_error)
    }

    async fn sync_file(&self, path: &str) -> Result<(), AppError> {
        let _guard = self.io.lock().await;
        let mut file = self
            .sftp
            .open_with_flags(path, OpenFlags::WRITE)
            .await
            .map_err(map_sftp_error)?;
        file.sync_all().await.map_err(map_sftp_error)?;
        file.shutdown().await.map_err(map_io_error)
    }

    async fn read_privileged(
        &self,
        path: &str,
        password: Option<&SecretString>,
    ) -> Result<Vec<u8>, AppError> {
        let probe = self
            .execute_command(privileged_command("cat", path, false), None)
            .await?;
        let output = if probe.status == Some(0) {
            probe
        } else {
            let Some(password) = password else {
                return Err(privileged_error(&probe));
            };
            let mut input = password.expose_secret().as_bytes().to_vec();
            input.push(b'\n');
            let fallback = self
                .execute_command(privileged_command("cat", path, true), Some(input))
                .await?;
            if fallback.status != Some(0) {
                return Err(privileged_error(&fallback));
            }
            fallback
        };
        Ok(output.stdout)
    }

    async fn write_privileged(
        &self,
        path: &str,
        content: &[u8],
        password: Option<&SecretString>,
    ) -> Result<(), AppError> {
        let probe = self.execute_command(privileged_probe(false), None).await?;
        if probe.status == Some(0) {
            let output = self
                .execute_command(
                    privileged_command("tee >/dev/null", path, false),
                    Some(content.to_vec()),
                )
                .await?;
            if output.status != Some(0) {
                return Err(privileged_error(&output));
            }
            return Ok(());
        }
        let Some(password) = password else {
            return Err(privileged_error(&probe));
        };
        let mut input = password.expose_secret().as_bytes().to_vec();
        input.push(b'\n');
        input.extend_from_slice(content);
        let fallback = self
            .execute_command(
                privileged_command("tee >/dev/null", path, true),
                Some(input),
            )
            .await?;
        if fallback.status != Some(0) {
            return Err(privileged_error(&fallback));
        }
        Ok(())
    }

    async fn create_privileged(
        &self,
        path: &str,
        directory: bool,
        password: Option<&SecretString>,
    ) -> Result<(), AppError> {
        let operation = if directory {
            "if [ -e \"$1\" ]; then exit 17; fi; mkdir \"$1\""
        } else {
            "if [ -e \"$1\" ]; then exit 17; fi; set -C; : > \"$1\""
        };
        let output = self
            .execute_with_sudo(
                privileged_shell_command(operation, path, false),
                privileged_shell_command(operation, path, true),
                password,
                &[],
            )
            .await?;
        if output.status == Some(17) {
            return Err(AppError::new(
                ErrorCode::AlreadyExists,
                "An entry with that name already exists",
            ));
        }
        if output.status != Some(0) {
            return Err(privileged_error(&output));
        }
        Ok(())
    }

    async fn delete_privileged(
        &self,
        path: &str,
        directory: bool,
        password: Option<&SecretString>,
    ) -> Result<(), AppError> {
        let operation = if directory {
            "if [ ! -e \"$1\" ]; then exit 18; fi; rm -rf \"$1\""
        } else {
            "if [ ! -e \"$1\" ]; then exit 18; fi; rm -f \"$1\""
        };
        let output = self
            .execute_with_sudo(
                privileged_shell_command(operation, path, false),
                privileged_shell_command(operation, path, true),
                password,
                &[],
            )
            .await?;
        if output.status == Some(18) {
            return Err(AppError::new(
                ErrorCode::NotFound,
                "The entry no longer exists",
            ));
        }
        if output.status != Some(0) {
            return Err(privileged_error(&output));
        }
        Ok(())
    }

    async fn package_directory(
        &self,
        directory_path: &str,
        format: ArchiveFormat,
    ) -> Result<String, AppError> {
        let path = directory_path.trim_end_matches('/');
        if path.is_empty() || path == "/" {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "Cannot package the filesystem root",
            ));
        }
        let (parent, name) = match path.rsplit_once('/') {
            Some(("", name)) => ("/", name),
            Some((parent, name)) => (parent, name),
            None => {
                return Err(AppError::new(
                    ErrorCode::InvalidInput,
                    "A remote directory path is required",
                ));
            }
        };
        if name.is_empty() {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "A remote directory path is required",
            ));
        }
        let archive = if parent == "/" {
            format!("/{name}.{}", format.extension())
        } else {
            format!("{parent}/{name}.{}", format.extension())
        };
        // Prefer `tar` / `tar -z` — they ship with typical Linux bases. `zip` is often missing.
        let pack = match format {
            ArchiveFormat::Zip => {
                return Err(AppError::new(
                    ErrorCode::InvalidInput,
                    "ZIP is not supported for remote packaging",
                )
                .with_detail(
                    "Remote hosts may not have the zip command; use tar or tar.gz instead",
                ));
            }
            ArchiveFormat::Tar => format!(
                "tar -cf {archive} -C {parent} {name}",
                archive = shell_quote(&archive),
                parent = shell_quote(parent),
                name = shell_quote(name),
            ),
            ArchiveFormat::TarGz => format!(
                "tar -czf {archive} -C {parent} {name}",
                archive = shell_quote(&archive),
                parent = shell_quote(parent),
                name = shell_quote(name),
            ),
        };
        let command = format!(
            "if [ ! -d {dir} ]; then exit 18; fi; {pack}",
            dir = shell_quote(path),
        );
        let output = self.execute_command(command, None).await?;
        if output.status == Some(18) {
            return Err(AppError::new(
                ErrorCode::NotFound,
                "The remote directory was not found",
            ));
        }
        if output.status != Some(0) {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(
                AppError::new(ErrorCode::Io, "Could not package the remote directory").with_detail(
                    if detail.is_empty() {
                        format!("packager exited with status {:?}", output.status)
                    } else {
                        detail
                    },
                ),
            );
        }
        Ok(archive)
    }

    async fn execute_commands(
        &self,
        commands: &[String],
        working_directory: Option<&str>,
    ) -> Result<Vec<RemoteCommandResult>, AppError> {
        let commands: Vec<String> = commands
            .iter()
            .map(|command| command.trim().to_string())
            .filter(|command| !command.is_empty())
            .collect();
        if commands.is_empty() {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "At least one remote command is required",
            ));
        }
        let cwd = working_directory
            .map(str::trim)
            .filter(|path| !path.is_empty());
        let mut results = Vec::with_capacity(commands.len());
        for command in commands {
            let remote = wrap_remote_command(&command, cwd);
            let output = self.execute_command(remote, None).await?;
            let result = RemoteCommandResult {
                command,
                exit_status: output.status,
                stdout: truncate_command_output(&output.stdout),
                stderr: truncate_command_output(&output.stderr),
            };
            let failed = result.exit_status != Some(0);
            results.push(result);
            if failed {
                break;
            }
        }
        Ok(results)
    }
}

const MAX_COMMAND_OUTPUT_CHARS: usize = 64 * 1024;

fn wrap_remote_command(command: &str, working_directory: Option<&str>) -> String {
    match working_directory {
        Some(cwd) => format!("cd {} && {}", shell_quote(cwd), command),
        None => command.to_string(),
    }
}

fn truncate_command_output(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    if text.chars().count() <= MAX_COMMAND_OUTPUT_CHARS {
        return text.into_owned();
    }
    let truncated: String = text.chars().take(MAX_COMMAND_OUTPUT_CHARS).collect();
    format!("{truncated}\n… (truncated)")
}

fn authentication_failure(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::AuthenticationFailed, message)
}

fn connection_failure(message: impl Into<String>) -> AppError {
    AppError::new(
        ErrorCode::ConnectionFailed,
        "Could not establish the SFTP session",
    )
    .retryable()
    .with_detail(message)
}

fn map_sftp_error(source: russh_sftp::client::error::Error) -> AppError {
    AppError::new(ErrorCode::Io, "The remote file operation failed")
        .retryable()
        .with_detail(source.to_string())
}

fn map_io_error(source: std::io::Error) -> AppError {
    let code = match source.kind() {
        std::io::ErrorKind::NotFound => ErrorCode::NotFound,
        std::io::ErrorKind::AlreadyExists => ErrorCode::AlreadyExists,
        std::io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
        std::io::ErrorKind::TimedOut => ErrorCode::TimedOut,
        _ => ErrorCode::Io,
    };
    AppError::new(code, "The file operation failed").with_detail(source.to_string())
}

#[allow(dead_code)]
fn empty_attributes_with_permissions(permissions: u32) -> FileAttributes {
    let mut attributes = FileAttributes::empty();
    attributes.permissions = Some(permissions);
    attributes
}

#[cfg(test)]
mod tests {
    use super::{
        privileged_command, privileged_shell_command, shell_quote, ssh_config,
        truncate_command_output, wrap_remote_command,
    };
    use siftlane_core::SshAlgorithmPolicy;
    use std::time::Duration;

    #[test]
    fn shell_quote_keeps_remote_paths_in_one_argument() {
        assert_eq!(shell_quote("/etc/it's.conf"), "'/etc/it'\\''s.conf'");
    }

    #[test]
    fn wrap_remote_command_quotes_working_directory() {
        assert_eq!(
            wrap_remote_command("npm run build", Some("/var/www/app dir")),
            "cd '/var/www/app dir' && npm run build"
        );
        assert_eq!(wrap_remote_command("uptime", None), "uptime");
    }

    #[test]
    fn truncate_command_output_marks_overflow() {
        let oversized = "x".repeat(super::MAX_COMMAND_OUTPUT_CHARS + 8);
        let truncated = truncate_command_output(oversized.as_bytes());
        assert!(truncated.ends_with("… (truncated)"));
        assert!(truncated.chars().count() > super::MAX_COMMAND_OUTPUT_CHARS);
    }

    #[test]
    fn privileged_commands_use_fixed_programs_and_quoted_paths() {
        let command = privileged_command("cat", "/etc/app config", false);
        assert!(command.starts_with("sudo -n -- sh -c 'exec cat"));
        assert!(command.ends_with(" '/etc/app config'"));
    }

    #[test]
    fn privileged_create_and_delete_scripts_are_directory_aware() {
        let create = privileged_shell_command(
            "if [ -e \"$1\" ]; then exit 17; fi; mkdir \"$1\"",
            "/opt/app dir",
            false,
        );
        let delete = privileged_shell_command(
            "if [ ! -e \"$1\" ]; then exit 18; fi; rmdir \"$1\"",
            "/opt/app dir",
            false,
        );
        assert!(create.contains("exit 17"));
        assert!(delete.contains("rmdir"));
        assert!(create.ends_with(" '/opt/app dir'"));
    }

    #[test]
    fn rejects_unknown_algorithm_names_before_connecting() {
        let policy = SshAlgorithmPolicy {
            ciphers: vec!["not-a-real-cipher".into()],
            ..Default::default()
        };
        assert!(ssh_config(Duration::from_secs(30), &policy).is_err());
    }
}
