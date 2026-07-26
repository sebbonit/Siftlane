use std::{
    collections::BTreeSet,
    path::{Component, Path, PathBuf},
};

use siftlane_core::{AppError, EntryKind, ErrorCode, RemoteFilesystem, SymlinkPolicy};

pub const MAX_TRANSFER_FILES: usize = 5_000;
pub const MAX_TRANSFER_DEPTH: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferPlanMode {
    /// Transfer the source directory as a named child under the destination.
    IncludeRoot,
    /// Transfer the contents of the source directory into the destination.
    ContentsOnly,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedFile {
    pub source_path: String,
    pub destination_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedSymlink {
    pub target: String,
    pub destination_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TransferPlan {
    /// Absolute destination directory paths, sorted shallowest-first.
    pub directories: Vec<String>,
    pub files: Vec<PlannedFile>,
    pub symlinks: Vec<PlannedSymlink>,
}

impl TransferPlan {
    pub fn is_empty(&self) -> bool {
        self.directories.is_empty() && self.files.is_empty() && self.symlinks.is_empty()
    }
}

pub fn plan_local_directory(
    source: &Path,
    destination_base: &str,
    destination_is_remote: bool,
    mode: TransferPlanMode,
    symlink_policy: SymlinkPolicy,
) -> Result<TransferPlan, AppError> {
    if !source.is_dir() {
        return Err(AppError::new(
            ErrorCode::NotFound,
            "The source directory was not found",
        ));
    }
    let root_name = directory_name(source)?;
    let prefix = match mode {
        TransferPlanMode::IncludeRoot => root_name,
        TransferPlanMode::ContentsOnly => String::new(),
    };

    let mut relative_dirs = BTreeSet::new();
    let mut relative_files: Vec<(String, String)> = Vec::new();
    let mut relative_symlinks: Vec<(String, String)> = Vec::new();
    let mut stack = vec![(source.to_path_buf(), 0usize)];

    while let Some((current, depth)) = stack.pop() {
        if depth > MAX_TRANSFER_DEPTH {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                format!("Directories deeper than {MAX_TRANSFER_DEPTH} levels cannot be queued"),
            ));
        }
        let entries = std::fs::read_dir(&current).map_err(|source| {
            AppError::new(ErrorCode::Io, "Could not read the local directory")
                .with_detail(source.to_string())
        })?;
        for item in entries {
            let item = item.map_err(|source| {
                AppError::new(ErrorCode::Io, "Could not read a local directory entry")
                    .with_detail(source.to_string())
            })?;
            let path = item.path();
            let mut metadata = std::fs::symlink_metadata(&path).map_err(|source| {
                AppError::new(ErrorCode::Io, "Could not read local entry metadata")
                    .with_detail(source.to_string())
            })?;
            if metadata.file_type().is_symlink() {
                match symlink_policy {
                    SymlinkPolicy::Skip => continue,
                    SymlinkPolicy::CopyLink => {
                        let relative = relative_from(source, &path)?;
                        let planned_relative = with_prefix(&prefix, &relative);
                        let target = std::fs::read_link(&path)
                            .map_err(|source| {
                                AppError::new(ErrorCode::Io, "Could not read symbolic link")
                                    .with_detail(source.to_string())
                            })?
                            .to_string_lossy()
                            .into_owned();
                        relative_symlinks.push((target, planned_relative));
                        continue;
                    }
                    SymlinkPolicy::Dereference => {
                        metadata = std::fs::metadata(&path).map_err(|source| {
                            AppError::new(
                                ErrorCode::Io,
                                "Could not dereference local symbolic link",
                            )
                            .with_detail(source.to_string())
                        })?;
                    }
                }
            }
            let relative = relative_from(source, &path)?;
            let planned_relative = with_prefix(&prefix, &relative);

            if metadata.is_dir() {
                if !planned_relative.is_empty() {
                    relative_dirs.insert(planned_relative);
                }
                stack.push((path, depth + 1));
            } else if metadata.is_file() {
                if relative_files.len() >= MAX_TRANSFER_FILES {
                    return Err(AppError::new(
                        ErrorCode::InvalidInput,
                        format!(
                            "Directories with more than {MAX_TRANSFER_FILES} files cannot be queued"
                        ),
                    ));
                }
                let source_path = path_to_string(&path)?;
                relative_files.push((source_path, planned_relative));
            }
        }
    }

    build_plan(
        destination_base,
        destination_is_remote,
        relative_dirs,
        relative_files,
        relative_symlinks,
        &prefix,
        mode,
    )
}

pub async fn plan_remote_directory(
    client: &dyn RemoteFilesystem,
    source: &str,
    destination_base: &str,
    destination_is_remote: bool,
    mode: TransferPlanMode,
    symlink_policy: SymlinkPolicy,
) -> Result<TransferPlan, AppError> {
    let source = source.trim_end_matches('/');
    let source = if source.is_empty() { "/" } else { source };
    let meta = client.metadata(source).await?;
    let Some(entry) = meta else {
        return Err(AppError::new(
            ErrorCode::NotFound,
            "The source directory was not found",
        ));
    };
    if entry.kind != EntryKind::Directory {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "The source path is not a directory",
        ));
    }
    let root_name = remote_directory_name(source)?;
    let prefix = match mode {
        TransferPlanMode::IncludeRoot => root_name,
        TransferPlanMode::ContentsOnly => String::new(),
    };

    let mut relative_dirs = BTreeSet::new();
    let mut relative_files: Vec<(String, String)> = Vec::new();
    let mut relative_symlinks: Vec<(String, String)> = Vec::new();
    let mut stack = vec![(source.to_string(), 0usize)];

    while let Some((current, depth)) = stack.pop() {
        if depth > MAX_TRANSFER_DEPTH {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                format!("Directories deeper than {MAX_TRANSFER_DEPTH} levels cannot be queued"),
            ));
        }
        let entries = client.list_directory(&current).await?;
        for entry in entries {
            match entry.kind {
                EntryKind::Other => continue,
                EntryKind::Symlink => match symlink_policy {
                    SymlinkPolicy::Skip => continue,
                    SymlinkPolicy::CopyLink => {
                        let relative = remote_relative(source, &entry.path)?;
                        let planned_relative = with_prefix(&prefix, &relative);
                        let target = entry.symlink_target.ok_or_else(|| {
                            AppError::new(
                                ErrorCode::Unsupported,
                                "The server did not report the symbolic link target",
                            )
                        })?;
                        relative_symlinks.push((target, planned_relative));
                        continue;
                    }
                    SymlinkPolicy::Dereference => {
                        return Err(AppError::new(
                            ErrorCode::InvalidInput,
                            format!(
                                "The remote protocol cannot safely dereference symbolic link {}",
                                entry.path
                            ),
                        ));
                    }
                },
                EntryKind::Directory => {
                    let relative = remote_relative(source, &entry.path)?;
                    let planned_relative = with_prefix(&prefix, &relative);
                    if !planned_relative.is_empty() {
                        relative_dirs.insert(planned_relative);
                    }
                    stack.push((entry.path, depth + 1));
                }
                EntryKind::File => {
                    if relative_files.len() >= MAX_TRANSFER_FILES {
                        return Err(AppError::new(
                            ErrorCode::InvalidInput,
                            format!(
                                "Directories with more than {MAX_TRANSFER_FILES} files cannot be queued"
                            ),
                        ));
                    }
                    let relative = remote_relative(source, &entry.path)?;
                    let planned_relative = with_prefix(&prefix, &relative);
                    relative_files.push((entry.path, planned_relative));
                }
            }
        }
    }

    build_plan(
        destination_base,
        destination_is_remote,
        relative_dirs,
        relative_files,
        relative_symlinks,
        &prefix,
        mode,
    )
}

fn build_plan(
    destination_base: &str,
    destination_is_remote: bool,
    relative_dirs: BTreeSet<String>,
    relative_files: Vec<(String, String)>,
    relative_symlinks: Vec<(String, String)>,
    prefix: &str,
    mode: TransferPlanMode,
) -> Result<TransferPlan, AppError> {
    let mut directories = BTreeSet::new();
    if mode == TransferPlanMode::IncludeRoot && !prefix.is_empty() {
        directories.insert(join_destination(
            destination_base,
            prefix,
            destination_is_remote,
        ));
    }
    for relative in relative_dirs {
        directories.insert(join_destination(
            destination_base,
            &relative,
            destination_is_remote,
        ));
        insert_ancestor_dirs(
            &mut directories,
            destination_base,
            &relative,
            destination_is_remote,
        );
    }
    for (_, relative) in &relative_files {
        if let Some(parent) = parent_relative(relative) {
            directories.insert(join_destination(
                destination_base,
                &parent,
                destination_is_remote,
            ));
            insert_ancestor_dirs(
                &mut directories,
                destination_base,
                &parent,
                destination_is_remote,
            );
        }
    }
    for (_, relative) in &relative_symlinks {
        if let Some(parent) = parent_relative(relative) {
            directories.insert(join_destination(
                destination_base,
                &parent,
                destination_is_remote,
            ));
        }
    }

    let mut directories: Vec<String> = directories.into_iter().collect();
    directories.sort_by_key(|path| path.matches('/').count() + path.matches('\\').count());

    let files = relative_files
        .into_iter()
        .map(|(source_path, relative)| {
            Ok(PlannedFile {
                source_path,
                destination_path: join_destination(
                    destination_base,
                    &relative,
                    destination_is_remote,
                ),
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    let symlinks = relative_symlinks
        .into_iter()
        .map(|(target, relative)| PlannedSymlink {
            target,
            destination_path: join_destination(destination_base, &relative, destination_is_remote),
        })
        .collect();

    let plan = TransferPlan {
        directories,
        files,
        symlinks,
    };
    if plan.is_empty() {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "No files or folders found to transfer",
        ));
    }
    Ok(plan)
}

fn insert_ancestor_dirs(
    directories: &mut BTreeSet<String>,
    destination_base: &str,
    relative: &str,
    destination_is_remote: bool,
) {
    let mut current = relative.to_string();
    while let Some(parent) = parent_relative(&current) {
        directories.insert(join_destination(
            destination_base,
            &parent,
            destination_is_remote,
        ));
        current = parent;
    }
}

pub fn join_destination(base: &str, relative: &str, remote: bool) -> String {
    if relative.is_empty() {
        return if remote {
            let trimmed = base.trim_end_matches('/');
            if trimmed.is_empty() {
                "/".to_string()
            } else {
                trimmed.to_string()
            }
        } else {
            base.to_string()
        };
    }
    if remote {
        let base = base.trim_end_matches('/');
        let base = if base.is_empty() { "" } else { base };
        format!("{base}/{}", relative.replace('\\', "/"))
    } else {
        let mut path = PathBuf::from(base);
        for segment in relative.split(['/', '\\']) {
            if segment.is_empty() || segment == "." {
                continue;
            }
            path.push(segment);
        }
        path_to_string(&path).unwrap_or_else(|_| path.to_string_lossy().into_owned())
    }
}

fn with_prefix(prefix: &str, relative: &str) -> String {
    if prefix.is_empty() {
        relative.to_string()
    } else if relative.is_empty() {
        prefix.to_string()
    } else {
        format!("{prefix}/{relative}")
    }
}

fn parent_relative(relative: &str) -> Option<String> {
    let trimmed = relative.trim_matches(['/', '\\']);
    if trimmed.is_empty() {
        return None;
    }
    let normalized = trimmed.replace('\\', "/");
    let (parent, _) = normalized.rsplit_once('/')?;
    if parent.is_empty() {
        None
    } else {
        Some(parent.to_string())
    }
}

fn relative_from(root: &Path, path: &Path) -> Result<String, AppError> {
    let relative = path.strip_prefix(root).map_err(|_| {
        AppError::new(
            ErrorCode::Internal,
            "Could not build a relative transfer path",
        )
    })?;
    let mut segments = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(value) => {
                let value = value.to_str().ok_or_else(|| {
                    AppError::new(
                        ErrorCode::InvalidInput,
                        "Transfer paths must be valid UTF-8",
                    )
                })?;
                segments.push(value);
            }
            Component::CurDir => {}
            _ => {
                return Err(AppError::new(
                    ErrorCode::InvalidInput,
                    "Transfer paths must stay inside the source directory",
                ));
            }
        }
    }
    Ok(segments.join("/"))
}

fn remote_relative(root: &str, path: &str) -> Result<String, AppError> {
    let root = root.trim_end_matches('/');
    let path = path.trim_end_matches('/');
    if path == root || (root.is_empty() && path == "/") {
        return Ok(String::new());
    }
    let prefix = if root.is_empty() || root == "/" {
        "/".to_string()
    } else {
        format!("{root}/")
    };
    let Some(relative) = path.strip_prefix(&prefix) else {
        return Err(AppError::new(
            ErrorCode::Internal,
            "Could not build a relative transfer path",
        ));
    };
    if relative.is_empty() || relative.split('/').any(|segment| segment == "..") {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Transfer paths must stay inside the source directory",
        ));
    }
    Ok(relative.replace('\\', "/"))
}

fn directory_name(path: &Path) -> Result<String, AppError> {
    path.file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            AppError::new(
                ErrorCode::InvalidInput,
                "Cannot transfer the filesystem root",
            )
        })
}

fn remote_directory_name(path: &str) -> Result<String, AppError> {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() || trimmed == "/" {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Cannot transfer the filesystem root",
        ));
    }
    trimmed
        .rsplit('/')
        .next()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            AppError::new(
                ErrorCode::InvalidInput,
                "Cannot transfer the filesystem root",
            )
        })
}

fn path_to_string(path: &Path) -> Result<String, AppError> {
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| AppError::new(ErrorCode::InvalidInput, "Paths must be valid UTF-8"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn utf8(path: &Path) -> &str {
        path.to_str().expect("utf8")
    }

    #[test]
    fn plans_local_include_root_with_nested_and_empty_dirs() {
        let root = tempfile::tempdir().expect("tempdir");
        let source = root.path().join("project");
        let dest = root.path().join("out");
        fs::create_dir_all(source.join("src/nested")).expect("mkdir");
        fs::create_dir_all(source.join("empty")).expect("mkdir");
        fs::write(source.join("readme.txt"), b"hi").expect("write");
        fs::write(source.join("src/main.rs"), b"fn main() {}").expect("write");

        let plan = plan_local_directory(
            &source,
            utf8(&dest),
            false,
            TransferPlanMode::IncludeRoot,
            SymlinkPolicy::Skip,
        )
        .expect("plan");

        assert!(
            plan.directories
                .iter()
                .any(|path| path.ends_with("project"))
        );
        assert!(
            plan.directories
                .iter()
                .any(|path| path.ends_with("project/empty") || path.ends_with("project\\empty"))
        );
        assert_eq!(plan.files.len(), 2);
        assert!(plan.files.iter().any(|file| {
            file.destination_path.ends_with("project/readme.txt")
                || file.destination_path.ends_with("project\\readme.txt")
        }));
        assert!(plan.files.iter().any(|file| {
            file.destination_path.ends_with("project/src/main.rs")
                || file.destination_path.ends_with("project\\src\\main.rs")
        }));
    }

    #[test]
    fn plans_local_contents_only() {
        let root = tempfile::tempdir().expect("tempdir");
        let source = root.path().join("project");
        let dest = root.path().join("out");
        fs::create_dir_all(source.join("src")).expect("mkdir");
        fs::write(source.join("src/main.rs"), b"fn main() {}").expect("write");

        let plan = plan_local_directory(
            &source,
            utf8(&dest),
            false,
            TransferPlanMode::ContentsOnly,
            SymlinkPolicy::Skip,
        )
        .expect("plan");

        assert!(
            !plan
                .directories
                .iter()
                .any(|path| path.ends_with("project"))
        );
        assert!(plan.files.iter().any(|file| {
            file.destination_path.ends_with("src/main.rs")
                || file.destination_path.ends_with("src\\main.rs")
        }));
    }

    #[test]
    fn skips_symlinks() {
        let root = tempfile::tempdir().expect("tempdir");
        let source = root.path().join("project");
        fs::create_dir_all(&source).expect("mkdir");
        fs::write(source.join("real.txt"), b"data").expect("write");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(source.join("real.txt"), source.join("link.txt"))
                .expect("symlink");
        }

        let plan = plan_local_directory(
            &source,
            utf8(&root.path().join("out")),
            false,
            TransferPlanMode::ContentsOnly,
            SymlinkPolicy::Skip,
        )
        .expect("plan");

        assert_eq!(plan.files.len(), 1);
        assert!(plan.files[0].source_path.ends_with("real.txt"));
    }

    #[test]
    fn rejects_over_file_cap() {
        let root = tempfile::tempdir().expect("tempdir");
        let source = root.path().join("project");
        fs::create_dir_all(&source).expect("mkdir");
        for index in 0..(MAX_TRANSFER_FILES + 1) {
            fs::write(source.join(format!("file-{index}.txt")), b"x").expect("write");
        }

        let error = plan_local_directory(
            &source,
            utf8(&root.path().join("out")),
            false,
            TransferPlanMode::ContentsOnly,
            SymlinkPolicy::Skip,
        )
        .expect_err("cap");
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert!(error.message.contains(&MAX_TRANSFER_FILES.to_string()));
    }

    #[test]
    fn join_destination_remote_preserves_slashes() {
        assert_eq!(
            join_destination("/var/www", "project/src/main.rs", true),
            "/var/www/project/src/main.rs"
        );
        assert_eq!(join_destination("/", "html", true), "/html");
    }
}
