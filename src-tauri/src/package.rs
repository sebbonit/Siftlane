use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use flate2::{Compression, write::GzEncoder};
use siftlane_core::{AppError, ArchiveFormat, ErrorCode};
use tar::Builder;
use walkdir::WalkDir;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

const MAX_PACKAGED_FILES: usize = 5_000;

pub fn package_local_directory(
    directory_path: &str,
    format: ArchiveFormat,
) -> Result<String, AppError> {
    let source = PathBuf::from(directory_path);
    if !source.is_dir() {
        return Err(AppError::new(
            ErrorCode::NotFound,
            "The local directory was not found",
        ));
    }
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppError::new(
                ErrorCode::InvalidInput,
                "Cannot package the filesystem root",
            )
        })?;
    let archive = source
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!("{name}.{}", format.extension()));
    if archive.exists() {
        return Err(AppError::new(
            ErrorCode::AlreadyExists,
            format!("Archive already exists at {}", archive.display()),
        ));
    }

    match format {
        ArchiveFormat::Zip => package_zip(&source, &archive)?,
        ArchiveFormat::Tar => package_tar(&source, name, &archive, false)?,
        ArchiveFormat::TarGz => package_tar(&source, name, &archive, true)?,
    }
    Ok(archive.to_string_lossy().into_owned())
}

fn package_zip(source: &Path, archive: &Path) -> Result<(), AppError> {
    let file = File::create(archive).map_err(package_io_error)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut count = 0usize;
    let mut buffer = Vec::new();

    for entry in WalkDir::new(source).into_iter().filter_map(Result::ok) {
        let path = entry.path();
        let relative = path.strip_prefix(source).map_err(|_| {
            AppError::new(
                ErrorCode::Internal,
                "Could not build a relative archive path",
            )
        })?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        let name_in_archive = relative
            .to_str()
            .ok_or_else(|| {
                AppError::new(ErrorCode::InvalidInput, "Archive paths must be valid UTF-8")
            })?
            .replace('\\', "/");

        if entry.file_type().is_dir() {
            zip.add_directory(format!("{name_in_archive}/"), options)
                .map_err(package_zip_error)?;
            continue;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        count += 1;
        if count > MAX_PACKAGED_FILES {
            let _ = std::fs::remove_file(archive);
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                format!("Directories with more than {MAX_PACKAGED_FILES} files cannot be packaged"),
            ));
        }
        zip.start_file(&name_in_archive, options)
            .map_err(package_zip_error)?;
        buffer.clear();
        File::open(path)
            .and_then(|mut input| input.read_to_end(&mut buffer))
            .map_err(package_io_error)?;
        zip.write_all(&buffer).map_err(package_io_error)?;
    }

    zip.finish().map_err(package_zip_error)?;
    Ok(())
}

fn package_tar(source: &Path, name: &str, archive: &Path, gzip: bool) -> Result<(), AppError> {
    let count = WalkDir::new(source)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .count();
    if count > MAX_PACKAGED_FILES {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            format!("Directories with more than {MAX_PACKAGED_FILES} files cannot be packaged"),
        ));
    }

    let file = File::create(archive).map_err(package_io_error)?;
    if gzip {
        let encoder = GzEncoder::new(file, Compression::default());
        let mut builder = Builder::new(encoder);
        builder
            .append_dir_all(name, source)
            .map_err(package_io_error)?;
        let encoder = builder.into_inner().map_err(package_io_error)?;
        encoder.finish().map_err(package_io_error)?;
    } else {
        let mut builder = Builder::new(file);
        builder
            .append_dir_all(name, source)
            .map_err(package_io_error)?;
        builder.finish().map_err(package_io_error)?;
    }
    Ok(())
}

fn package_io_error(source: std::io::Error) -> AppError {
    let code = match source.kind() {
        std::io::ErrorKind::NotFound => ErrorCode::NotFound,
        std::io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
        std::io::ErrorKind::AlreadyExists => ErrorCode::AlreadyExists,
        _ => ErrorCode::Io,
    };
    AppError::new(code, "Could not package the local directory").with_detail(source.to_string())
}

fn package_zip_error(source: zip::result::ZipError) -> AppError {
    AppError::new(ErrorCode::Io, "Could not package the local directory")
        .with_detail(source.to_string())
}

#[cfg(test)]
mod tests {
    use super::package_local_directory;
    use siftlane_core::ArchiveFormat;
    use std::{fs, path::PathBuf};

    #[test]
    fn packages_local_directory_into_zip() {
        let root = tempfile::tempdir().expect("tempdir");
        let folder = root.path().join("project");
        fs::create_dir_all(folder.join("src")).expect("mkdir");
        fs::write(folder.join("readme.txt"), b"hello").expect("write");
        fs::write(folder.join("src/main.rs"), b"fn main() {}").expect("write");

        let archive = package_local_directory(folder.to_str().expect("utf8"), ArchiveFormat::Zip)
            .expect("package");
        assert!(PathBuf::from(&archive).exists());
        assert!(archive.ends_with("project.zip"));
    }

    #[test]
    fn packages_local_directory_into_tar_gz() {
        let root = tempfile::tempdir().expect("tempdir");
        let folder = root.path().join("project");
        fs::create_dir_all(&folder).expect("mkdir");
        fs::write(folder.join("readme.txt"), b"hello").expect("write");

        let archive = package_local_directory(folder.to_str().expect("utf8"), ArchiveFormat::TarGz)
            .expect("package");
        assert!(PathBuf::from(&archive).exists());
        assert!(archive.ends_with("project.tar.gz"));
    }

    #[test]
    fn packages_local_directory_into_tar() {
        let root = tempfile::tempdir().expect("tempdir");
        let folder = root.path().join("project");
        fs::create_dir_all(&folder).expect("mkdir");
        fs::write(folder.join("readme.txt"), b"hello").expect("write");

        let archive = package_local_directory(folder.to_str().expect("utf8"), ArchiveFormat::Tar)
            .expect("package");
        assert!(PathBuf::from(&archive).exists());
        assert!(archive.ends_with("project.tar"));
    }
}
