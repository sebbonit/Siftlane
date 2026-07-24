use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use serde::{Deserialize, Serialize};
use siftlane_core::{AppError, EntryKind, ErrorCode, FileEntry, RemoteFilesystem};
use uuid::Uuid;

pub const MAX_SEARCH_DEPTH: usize = 32;
pub const MAX_SEARCH_MATCHES: usize = 500;
pub const MAX_SEARCH_VISITED: usize = 1_500;
const PROGRESS_BATCH: usize = 40;

/// Directory names that dominate walk time and are rarely useful in filename search.
const SKIP_DIRECTORIES: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".jj",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".output",
    ".turbo",
    ".cache",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".idea",
    ".vscode",
    "Pods",
    "Carthage",
    "vendor",
];

pub fn should_skip_directory(name: &str) -> bool {
    SKIP_DIRECTORIES
        .iter()
        .any(|skip| name.eq_ignore_ascii_case(skip))
}

pub fn name_matches(name: &str, query_lower: &str) -> bool {
    if query_lower.is_empty() {
        return false;
    }
    name.to_lowercase().contains(query_lower)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SearchMatch {
    pub path: String,
    pub name: String,
    pub kind: EntryKind,
    pub parent_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SearchProgress {
    pub search_id: Uuid,
    pub matches: Vec<SearchMatch>,
    pub visited: usize,
    pub truncated: bool,
    pub done: bool,
    pub cancelled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn remote_parent_path(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() || trimmed == "/" {
        return "/".into();
    }
    match trimmed.rfind('/') {
        Some(0) => "/".into(),
        Some(index) => trimmed[..index].to_string(),
        None => "/".into(),
    }
}

pub fn local_parent_path(path: &Path) -> String {
    path.parent()
        .map(|parent| parent.to_string_lossy().to_string())
        .filter(|parent| !parent.is_empty())
        .unwrap_or_else(|| {
            if cfg!(windows) {
                path.to_string_lossy().to_string()
            } else {
                "/".into()
            }
        })
}

fn to_match(entry: &FileEntry, parent_path: String) -> SearchMatch {
    SearchMatch {
        path: entry.path.clone(),
        name: entry.name.clone(),
        kind: entry.kind,
        parent_path,
    }
}

struct WalkState<'a, F>
where
    F: FnMut(SearchProgress),
{
    search_id: Uuid,
    query: String,
    cancelled: Arc<AtomicBool>,
    matches: Vec<SearchMatch>,
    pending: Vec<SearchMatch>,
    visited: usize,
    truncated: bool,
    on_progress: &'a mut F,
}

impl<'a, F> WalkState<'a, F>
where
    F: FnMut(SearchProgress),
{
    fn new(
        search_id: Uuid,
        query: String,
        cancelled: Arc<AtomicBool>,
        on_progress: &'a mut F,
    ) -> Self {
        Self {
            search_id,
            query: query.to_lowercase(),
            cancelled,
            matches: Vec::new(),
            pending: Vec::new(),
            visited: 0,
            truncated: false,
            on_progress,
        }
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    fn push_match(&mut self, item: SearchMatch) {
        if self.matches.len() >= MAX_SEARCH_MATCHES {
            self.truncated = true;
            return;
        }
        self.matches.push(item.clone());
        self.pending.push(item);
        if self.pending.len() >= PROGRESS_BATCH {
            self.flush(false, false);
        }
        if self.matches.len() >= MAX_SEARCH_MATCHES {
            self.truncated = true;
        }
    }

    fn flush(&mut self, done: bool, cancelled: bool) {
        let batch = std::mem::take(&mut self.pending);
        if batch.is_empty() && !done && !cancelled {
            return;
        }
        (self.on_progress)(SearchProgress {
            search_id: self.search_id,
            matches: batch,
            visited: self.visited,
            truncated: self.truncated,
            done,
            cancelled,
            error: None,
        });
    }

    fn finish(&mut self, cancelled: bool) {
        self.flush(true, cancelled);
    }
}

pub fn search_local<F>(
    search_id: Uuid,
    root: PathBuf,
    query: String,
    cancelled: Arc<AtomicBool>,
    mut on_progress: F,
) -> Result<(), AppError>
where
    F: FnMut(SearchProgress),
{
    let mut state = WalkState::new(search_id, query, cancelled, &mut on_progress);
    if state.query.is_empty() {
        state.finish(false);
        return Ok(());
    }
    if !root.is_dir() {
        return Err(AppError::new(
            ErrorCode::NotFound,
            "The search root directory was not found",
        ));
    }

    let mut queue = VecDeque::from([(root, 0usize)]);
    while let Some((current, depth)) = queue.pop_front() {
        if state.is_cancelled() {
            state.finish(true);
            return Ok(());
        }
        if depth > MAX_SEARCH_DEPTH || state.visited >= MAX_SEARCH_VISITED {
            state.truncated = true;
            break;
        }
        if state.truncated {
            break;
        }

        state.visited += 1;
        let entries = std::fs::read_dir(&current).map_err(|source| {
            AppError::new(ErrorCode::Io, "Could not read the local directory")
                .with_detail(source.to_string())
        })?;

        let mut preferred = Vec::new();
        let mut other = Vec::new();
        for item in entries {
            if state.is_cancelled() {
                state.finish(true);
                return Ok(());
            }
            let item = item.map_err(|source| {
                AppError::new(ErrorCode::Io, "Could not read a local directory entry")
                    .with_detail(source.to_string())
            })?;
            let path = item.path();
            let file_type = match item.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            let kind = if file_type.is_symlink() {
                EntryKind::Symlink
            } else if file_type.is_dir() {
                EntryKind::Directory
            } else if file_type.is_file() {
                EntryKind::File
            } else {
                EntryKind::Other
            };
            if matches!(kind, EntryKind::Symlink | EntryKind::Other) {
                continue;
            }
            let name = item.file_name().to_string_lossy().to_string();
            let entry = FileEntry {
                path: path.to_string_lossy().to_string(),
                name: name.clone(),
                kind,
                size: None,
                modified_at: None,
                permissions: None,
                symlink_target: None,
                hidden: name.starts_with('.'),
            };
            let parent = local_parent_path(&path);
            if name_matches(&entry.name, &state.query) {
                state.push_match(to_match(&entry, parent));
                if state.truncated {
                    break;
                }
            }
            if kind == EntryKind::Directory && !should_skip_directory(&name) {
                if name_matches(&name, &state.query) {
                    preferred.push(path);
                } else {
                    other.push(path);
                }
            }
        }

        // Stream matches as soon as a folder listing produces them.
        if !state.pending.is_empty() {
            state.flush(false, false);
        }
        if state.truncated {
            break;
        }
        enqueue_children(&mut queue, depth + 1, preferred, other);
    }

    state.finish(false);
    Ok(())
}

fn enqueue_children(
    queue: &mut VecDeque<(PathBuf, usize)>,
    depth: usize,
    preferred: Vec<PathBuf>,
    other: Vec<PathBuf>,
) {
    // Breadth-first: visit every folder at this depth before going deeper.
    // Prefer directories whose names match the query so likely hits expand first.
    for path in other {
        queue.push_back((path, depth));
    }
    for path in preferred.into_iter().rev() {
        queue.push_front((path, depth));
    }
}

pub async fn search_remote<F>(
    client: &dyn RemoteFilesystem,
    search_id: Uuid,
    root: String,
    query: String,
    cancelled: Arc<AtomicBool>,
    mut on_progress: F,
) -> Result<(), AppError>
where
    F: FnMut(SearchProgress),
{
    let mut state = WalkState::new(search_id, query, cancelled, &mut on_progress);
    if state.query.is_empty() {
        state.finish(false);
        return Ok(());
    }

    // Prefer listing over metadata: MLST/stat can fail on servers where LIST works,
    // and avoids an extra round-trip before the walk.
    let mut queue = VecDeque::from([(root, 0usize)]);
    while let Some((current, depth)) = queue.pop_front() {
        if state.is_cancelled() {
            state.finish(true);
            return Ok(());
        }
        if depth > MAX_SEARCH_DEPTH || state.visited >= MAX_SEARCH_VISITED {
            state.truncated = true;
            break;
        }
        if state.truncated {
            break;
        }

        state.visited += 1;
        let entries = match client.list_directory(&current).await {
            Ok(entries) => entries,
            Err(error) if depth == 0 => return Err(error),
            // Skip directories the session cannot read and keep searching siblings.
            Err(_) => continue,
        };
        let mut preferred = Vec::new();
        let mut other = Vec::new();
        for entry in entries {
            if state.is_cancelled() {
                state.finish(true);
                return Ok(());
            }
            match entry.kind {
                EntryKind::Symlink | EntryKind::Other => continue,
                EntryKind::Directory | EntryKind::File => {
                    let parent = remote_parent_path(&entry.path);
                    if name_matches(&entry.name, &state.query) {
                        state.push_match(to_match(&entry, parent));
                        if state.truncated {
                            break;
                        }
                    }
                    if entry.kind == EntryKind::Directory && !should_skip_directory(&entry.name) {
                        if name_matches(&entry.name, &state.query) {
                            preferred.push(entry.path);
                        } else {
                            other.push(entry.path);
                        }
                    }
                }
            }
        }

        if !state.pending.is_empty() {
            state.flush(false, false);
        }
        if state.truncated {
            break;
        }
        for path in other {
            queue.push_back((path, depth + 1));
        }
        for path in preferred.into_iter().rev() {
            queue.push_front((path, depth + 1));
        }
    }

    state.finish(false);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;
    use std::sync::Mutex;

    use async_trait::async_trait;
    use secrecy::SecretString;
    use siftlane_core::{ArchiveFormat, RemoteCapabilities};

    fn collect_progress() -> (Arc<Mutex<Vec<SearchProgress>>>, impl FnMut(SearchProgress)) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        (events, move |progress| {
            sink.lock().unwrap().push(progress);
        })
    }

    fn all_matches(events: &Mutex<Vec<SearchProgress>>) -> Vec<SearchMatch> {
        events
            .lock()
            .unwrap()
            .iter()
            .flat_map(|event| event.matches.clone())
            .collect()
    }

    fn temp_tree() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(dir.path().join("assets/images")).unwrap();
        fs::write(dir.path().join("index.html"), b"ok").unwrap();
        fs::write(dir.path().join("assets/logo.svg"), b"<svg/>").unwrap();
        fs::write(dir.path().join("assets/images/hero.png"), b"png").unwrap();
        fs::write(dir.path().join("assets/images/thumb.png"), b"png").unwrap();
        dir
    }

    #[test]
    fn name_match_is_case_insensitive_substring() {
        assert!(name_matches("Index.HTML", "index"));
        assert!(name_matches("hero.png", "ero"));
        assert!(!name_matches("hero.png", "logo"));
        assert!(!name_matches("hero.png", ""));
    }

    #[test]
    fn skips_heavy_dependency_directories() {
        assert!(should_skip_directory("node_modules"));
        assert!(should_skip_directory(".git"));
        assert!(should_skip_directory("Target"));
        assert!(!should_skip_directory("assets"));
    }

    #[test]
    fn remote_parent_handles_roots() {
        assert_eq!(remote_parent_path("/"), "/");
        assert_eq!(remote_parent_path("/var"), "/");
        assert_eq!(remote_parent_path("/var/www/html"), "/var/www");
    }

    #[test]
    fn local_search_finds_nested_names() {
        let dir = temp_tree();
        let (events, on_progress) = collect_progress();
        search_local(
            Uuid::new_v4(),
            dir.path().to_path_buf(),
            "png".into(),
            Arc::new(AtomicBool::new(false)),
            on_progress,
        )
        .unwrap();
        let matches = all_matches(&events);
        assert_eq!(matches.len(), 2);
        assert!(matches.iter().all(|item| item.name.contains("png")));
        let last = events.lock().unwrap().last().cloned().unwrap();
        assert!(last.done);
        assert!(!last.truncated);
        assert!(!last.cancelled);
    }

    #[test]
    fn local_search_respects_match_cap() {
        let dir = tempfile::tempdir().unwrap();
        for index in 0..(MAX_SEARCH_MATCHES + 20) {
            fs::write(dir.path().join(format!("file-{index}.txt")), b"x").unwrap();
        }
        let (events, on_progress) = collect_progress();
        search_local(
            Uuid::new_v4(),
            dir.path().to_path_buf(),
            "file".into(),
            Arc::new(AtomicBool::new(false)),
            on_progress,
        )
        .unwrap();
        let matches = all_matches(&events);
        assert_eq!(matches.len(), MAX_SEARCH_MATCHES);
        let last = events.lock().unwrap().last().cloned().unwrap();
        assert!(last.truncated);
        assert!(last.done);
    }

    #[test]
    fn local_search_stops_when_cancelled() {
        let dir = temp_tree();
        let (events, on_progress) = collect_progress();
        search_local(
            Uuid::new_v4(),
            dir.path().to_path_buf(),
            "png".into(),
            Arc::new(AtomicBool::new(true)),
            on_progress,
        )
        .unwrap();
        let matches = all_matches(&events);
        assert!(matches.is_empty());
        let last = events.lock().unwrap().last().cloned().unwrap();
        assert!(last.cancelled);
        assert!(last.done);
    }

    struct FakeRemote {
        entries: Mutex<HashMap<String, Vec<FileEntry>>>,
    }

    impl FakeRemote {
        fn new() -> Self {
            let mut entries = HashMap::new();
            entries.insert(
                "/".into(),
                vec![
                    FileEntry {
                        path: "/www".into(),
                        name: "www".into(),
                        kind: EntryKind::Directory,
                        size: None,
                        modified_at: None,
                        permissions: None,
                        symlink_target: None,
                        hidden: false,
                    },
                    FileEntry {
                        path: "/readme.txt".into(),
                        name: "readme.txt".into(),
                        kind: EntryKind::File,
                        size: Some(1),
                        modified_at: None,
                        permissions: None,
                        symlink_target: None,
                        hidden: false,
                    },
                ],
            );
            entries.insert(
                "/www".into(),
                vec![
                    FileEntry {
                        path: "/www/index.html".into(),
                        name: "index.html".into(),
                        kind: EntryKind::File,
                        size: Some(2),
                        modified_at: None,
                        permissions: None,
                        symlink_target: None,
                        hidden: false,
                    },
                    FileEntry {
                        path: "/www/logo.png".into(),
                        name: "logo.png".into(),
                        kind: EntryKind::File,
                        size: Some(3),
                        modified_at: None,
                        permissions: None,
                        symlink_target: None,
                        hidden: false,
                    },
                ],
            );
            Self {
                entries: Mutex::new(entries),
            }
        }
    }

    #[async_trait]
    impl RemoteFilesystem for FakeRemote {
        fn capabilities(&self) -> RemoteCapabilities {
            RemoteCapabilities {
                chmod: false,
                symlinks: false,
                fsync: false,
                resume: false,
                atomic_rename: false,
            }
        }
        async fn disconnect(&self) -> Result<(), AppError> {
            Ok(())
        }
        async fn list_directory(&self, path: &str) -> Result<Vec<FileEntry>, AppError> {
            Ok(self
                .entries
                .lock()
                .unwrap()
                .get(path)
                .cloned()
                .unwrap_or_default())
        }
        async fn metadata(&self, path: &str) -> Result<Option<FileEntry>, AppError> {
            if path == "/" || self.entries.lock().unwrap().contains_key(path) {
                return Ok(Some(FileEntry {
                    path: path.into(),
                    name: path.rsplit('/').next().unwrap_or("/").into(),
                    kind: EntryKind::Directory,
                    size: None,
                    modified_at: None,
                    permissions: None,
                    symlink_target: None,
                    hidden: false,
                }));
            }
            Ok(None)
        }
        async fn create_directory(&self, _path: &str) -> Result<(), AppError> {
            unreachable!()
        }
        async fn rename(&self, _from: &str, _to: &str) -> Result<(), AppError> {
            unreachable!()
        }
        async fn remove_file(&self, _path: &str) -> Result<(), AppError> {
            unreachable!()
        }
        async fn remove_directory(&self, _path: &str) -> Result<(), AppError> {
            unreachable!()
        }
        async fn set_permissions(&self, _path: &str, _permissions: u32) -> Result<(), AppError> {
            unreachable!()
        }
        async fn read_chunk(
            &self,
            _path: &str,
            _offset: u64,
            _length: u32,
        ) -> Result<Vec<u8>, AppError> {
            unreachable!()
        }
        async fn write_chunk(
            &self,
            _path: &str,
            _offset: u64,
            _data: &[u8],
        ) -> Result<(), AppError> {
            unreachable!()
        }
        async fn sync_file(&self, _path: &str) -> Result<(), AppError> {
            unreachable!()
        }
        async fn read_privileged(
            &self,
            _path: &str,
            _password: Option<&SecretString>,
        ) -> Result<Vec<u8>, AppError> {
            unreachable!()
        }
        async fn write_privileged(
            &self,
            _path: &str,
            _content: &[u8],
            _password: Option<&SecretString>,
        ) -> Result<(), AppError> {
            unreachable!()
        }
        async fn create_privileged(
            &self,
            _path: &str,
            _directory: bool,
            _password: Option<&SecretString>,
        ) -> Result<(), AppError> {
            unreachable!()
        }
        async fn delete_privileged(
            &self,
            _path: &str,
            _directory: bool,
            _password: Option<&SecretString>,
        ) -> Result<(), AppError> {
            unreachable!()
        }
        async fn package_directory(
            &self,
            _directory_path: &str,
            _format: ArchiveFormat,
        ) -> Result<String, AppError> {
            unreachable!()
        }
    }

    #[tokio::test]
    async fn remote_search_finds_nested_file() {
        let client = FakeRemote::new();
        let (events, on_progress) = collect_progress();
        search_remote(
            &client,
            Uuid::new_v4(),
            "/".into(),
            "logo".into(),
            Arc::new(AtomicBool::new(false)),
            on_progress,
        )
        .await
        .unwrap();
        let matches = all_matches(&events);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].path, "/www/logo.png");
        assert_eq!(matches[0].parent_path, "/www");
    }
}
