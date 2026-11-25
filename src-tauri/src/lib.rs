// Clairvoyance: Git Demystified
// Copyright (C) 2026 Tyler Crowley
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3
// of the License, or (at your option) any later version.
//
// This program is distributed WITHOUT ANY WARRANTY.
// See the LICENSE file for details.

// -- Imports --

use git2::{
    build::CheckoutBuilder,
    BranchType,
    DiffFormat,
    DiffOptions,
    Repository,
    RepositoryState,
    Sort,
    Status,
    StatusOptions,
    ErrorCode,
    IndexAddOption,
    Oid,
    Patch,
    ReferenceType,
    Branch,
    RepositoryInitOptions,
};
use serde::Serialize;
use std::collections::{ HashMap, HashSet };
use std::path::{ Path, PathBuf };
use std::fs;

// -- Data Structures --

/// A filesystem entry and its children, serialized for the Explorer tree.
#[derive(Serialize)]
struct TreeEntry {
    name: String,
    path: String,
    is_dir: bool,
    unreadable: bool,
    status: Option<GitFileStatus>,
    children: Vec<TreeEntry>,
}

/// Top-level Git statistics displayed in the repository overview.
#[derive(Serialize)]
struct RepositorySummary {
    current_branch: Option<String>,
    changed_files: usize,
    total_commits: usize,
    branch_count: usize,
    contributor_count: usize,
    latest_commit: Option<String>,
}

/// Commit metadata and parent IDs used in the history table and graph.
#[derive(Serialize)]
struct CommitInfo {
    hash: String,
    message: String,
    author: String,
    timestamp: i64,
    parents: Vec<String>,
}

/// A file-level change and optional line statistics for a selected commit.
#[derive(Serialize)]
struct CommitFileChange {
    path: String,
    status: String,
    additions: Option<usize>,
    deletions: Option<usize>,
}

/// Commit timestamp and author used for recent activity calculations.
#[derive(Serialize)]
struct ActivityCommit {
    timestamp: i64,
    author: String,
}

/// Separate index (staged) and worktree (unstaged) status labels for a path.
#[derive(Serialize, Clone)]
struct GitFileStatus {
    staged: Option<String>,
    unstaged: Option<String>,
}

/// One added, removed, or context line with optional old/new line numbers.
#[derive(Serialize)]
struct FileDiffLine {
    old_line_number: Option<u32>,
    new_line_number: Option<u32>,
    line_type: String,
    content: String,
}

/// Local branch name, current-branch flag, and optional tip commit ID.
#[derive(Serialize)]
struct BranchInfo {
    name: String,
    is_current: bool,
    commit_hash: Option<String>,
}

// -- Validation & Initialization --

/// Checks whether the selected directory is the working-tree root of a Git repository.
///
/// # Arguments
///
/// * `path` - Directory selected by the user.
///
/// # Behavior
///
/// Resolves the directory and opens it as a repository. Returns `false` for bare
/// repositories and for paths inside a repository that are not its working-tree root.
///
/// # Returns
///
/// `Ok(true)` only for the repository's worktree root; otherwise `Ok(false)`
/// when no repository is found or the repository is bare.
///
/// # Errors
///
/// Returns an error for an invalid directory, filesystem resolution failure,
/// or a Git error other than a missing repository.
#[tauri::command]
fn is_git_repository(path: String) -> Result<bool, String> {
    let directory = std::path::Path
        ::new(&path)
        .canonicalize()
        .map_err(|e| e.to_string())?;

    if !directory.is_dir() {
        return Err("Selected path is not a directory.".into());
    }

    match Repository::open(&directory) {
        Ok(repo) => {
            let workdir = match repo.workdir() {
                Some(path) => path,
                None => {
                    return Ok(false);
                }
            };

            Ok(workdir.canonicalize().map_err(|e| e.to_string())? == directory)
        }
        Err(error) if error.code() == ErrorCode::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

/// Initializes a non-bare Git repository in a chosen directory.
///
/// # Arguments
///
/// * `parent_path` - Existing directory selected as the location.
/// * `new_name` - Optional name of a new subdirectory; `None` initializes the parent.
/// * `initial_branch` - Name assigned to the initial, as-yet-unborn branch.
///
/// # Behavior
///
/// Rejects invalid names and directories already inside another repository.
/// When `new_name` is supplied, creates the directory before initializing Git.
/// Initialization does not create an initial commit.
///
/// # Returns
///
/// The initialized repository directory as a string.
///
/// # Errors
///
/// Returns an error for invalid paths or names, an existing enclosing repository,
/// folder creation failures, or unsuccessful Git initialization.
#[tauri::command]
fn initialize_repository(
    parent_path: String,
    new_name: Option<String>,
    initial_branch: String
) -> Result<String, String> {
    let parent = Path::new(&parent_path)
        .canonicalize()
        .map_err(|e| format!("Invalid directory: {e}"))?;

    if !parent.is_dir() {
        return Err("The selected location is not a directory.".into());
    }

    let valid_branch = Branch::name_is_valid(&initial_branch).map_err(|e| e.to_string())?;

    if !valid_branch {
        return Err("Invalid Git branch name.".into());
    }

    // Avoid initializing a nested repository inside a discovered worktree.
    if Repository::discover(&parent).is_ok() {
        return Err("The selected directory is already inside a Git repository.".into());
    }

    let target = if let Some(name) = new_name {
        if
            name.is_empty() ||
            name == "." ||
            name == ".." ||
            name.contains('/') ||
            name.contains('\\') ||
            name.contains('\0') ||
            name.eq_ignore_ascii_case(".git")
        {
            return Err("Invalid repository name.".into());
        }

        let path = parent.join(name);

        fs::create_dir(&path).map_err(|e| format!("Cannot create repository folder: {e}"))?;

        path
    } else {
        parent
    };

    let mut options = RepositoryInitOptions::new();

    // Set the initial branch name without creating a commit.
    options.bare(false).no_reinit(true).initial_head(&initial_branch);

    Repository::init_opts(&target, &options).map_err(|e|
        format!("Failed to initialize repository: {e}")
    )?;

    Ok(target.to_string_lossy().into_owned())
}

// -- File Tree & Status --

/// Recursively constructs the directory tree displayed by the Explorer.
///
/// # Arguments
///
/// * `path` - Directory currently being traversed.
/// * `repo_root` - Working-tree root used for relative Git status lookups.
/// * `statuses` - Precomputed statuses indexed by repository-relative paths.
/// * `show_hidden` - Whether dot-prefixed entries should appear.
///
/// # Behavior
///
/// Excludes `.git` and, by default, dot-prefixed entries. Does not recurse through
/// symbolic links. Associates each entry with its Git status and sorts directories
/// before files, alphabetically without regard to case. Unreadable directories are
/// represented as such instead of aborting the full traversal.
///
/// # Returns
///
/// A `TreeEntry` containing the directory's children and metadata.
///
/// # Errors
///
/// Directory read errors are logged and represented in the returned tree rather
/// than propagated as a `Result`.
fn build_tree(
    path: &Path,
    repo_root: &Path,
    statuses: &HashMap<String, GitFileStatus>,
    show_hidden: bool
) -> TreeEntry {
    let mut entries = Vec::new();

    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Repository root".to_string());

    let read_dir = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) => {
            eprintln!("Could not read directory {}: {}", path.display(), error);

            return TreeEntry {
                name,
                path: path.to_string_lossy().into_owned(),
                is_dir: true,
                unreadable: true,
                status: None,
                children: entries,
            };
        }
    };

    for entry in read_dir {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                eprintln!("Could not read directory entry: {}", error);
                continue;
            }
        };

        let name = entry.file_name().to_string_lossy().into_owned();

        // Keep repository internals out of the Explorer even when hidden files are shown.
        if name == ".git" || (!show_hidden && name.starts_with('.')) {
            continue;
        }

        let entry_path = entry.path();

        let relative_path = entry_path
            .strip_prefix(repo_root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let status = statuses.get(&relative_path).cloned();

        let metadata = match fs::symlink_metadata(&entry_path) {
            Ok(metadata) => metadata,
            Err(error) => {
                eprintln!("Could not read metadata for {}: {}", entry_path.display(), error);
                continue;
            }
        };

        // Treat symlinks as leaves so traversal cannot follow recursive links.
        let is_dir = metadata.is_dir() && !metadata.file_type().is_symlink();

        let (children, unreadable) = if is_dir {
            let child_tree = build_tree(&entry_path, repo_root, statuses, show_hidden);
            let unreadable = child_tree.unreadable;

            (child_tree.children, unreadable)
        } else {
            (Vec::new(), false)
        };

        entries.push(TreeEntry {
            name,
            path: entry_path.to_string_lossy().into_owned(),
            is_dir,
            unreadable,
            status,
            children,
        });
    }

    // Match file-explorer convention: folders first, then case-insensitive names.
    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    TreeEntry {
        name,
        path: path.to_string_lossy().into_owned(),
        is_dir: true,
        unreadable: false,
        status: None,
        children: entries,
    }
}

/// Builds the Explorer tree for a repository, including Git status indicators.
///
/// # Arguments
///
/// * `path` - Path used to open the repository.
/// * `show_hidden` - Whether dot-prefixed filesystem entries are displayed.
///
/// # Returns
///
/// The root `TreeEntry`, including recursively collected children.
///
/// # Errors
///
/// Returns an error if the repository cannot be opened, lacks a worktree,
/// or its Git statuses cannot be read.
#[tauri::command]
fn get_repository_tree(path: String, show_hidden: bool) -> Result<TreeEntry, String> {
    let repo = Repository::open(&path).map_err(|_|
        "The selected folder is not a valid Git repository.".to_string()
    )?;

    let root = repo.workdir().ok_or_else(|| "Empty repositories are not supported.".to_string())?;

    let statuses = get_repository_statuses(&repo)?;

    Ok(build_tree(root, root, &statuses, show_hidden))
}

/// Collects file statuses from libgit2 for the Explorer and repository summary.
///
/// # Arguments
///
/// * `repo` - Open Git repository to inspect.
///
/// # Behavior
///
/// Queries tracked changes and recursively discovered untracked files while
/// excluding ignored and unchanged files. Separates index (`INDEX_*`) flags from
/// working-tree (`WT_*`) flags so the UI can distinguish staged and unstaged work.
/// Conflicts take precedence over other status classifications.
///
/// # Returns
///
/// A map from repository-relative path to staged/unstaged status labels.
///
/// # Errors
///
/// Returns an error if libgit2 cannot enumerate repository statuses.
fn get_repository_statuses(repo: &Repository) -> Result<HashMap<String, GitFileStatus>, String> {
    let mut options = StatusOptions::new();

    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .include_unmodified(false);

    let statuses = repo.statuses(Some(&mut options)).map_err(|error| error.to_string())?;

    let mut result = HashMap::new();

    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("Unknown").to_string();
        let status = entry.status();

        // INDEX flags describe the staged snapshot; conflicts take precedence.
        let staged = if status.contains(Status::CONFLICTED) {
            Some("conflicted".to_string())
        } else if status.contains(Status::INDEX_NEW) {
            Some("added".to_string())
        } else if status.contains(Status::INDEX_MODIFIED) {
            Some("modified".to_string())
        } else if status.contains(Status::INDEX_DELETED) {
            Some("deleted".to_string())
        } else if status.contains(Status::INDEX_RENAMED) {
            Some("renamed".to_string())
        } else if status.contains(Status::INDEX_TYPECHANGE) {
            Some("typechanged".to_string())
        } else {
            None
        };

        // WT flags describe changes not yet staged in the index.
        let unstaged = if status.contains(Status::CONFLICTED) {
            Some("conflicted".to_string())
        } else if status.contains(Status::WT_NEW) {
            Some("untracked".to_string())
        } else if status.contains(Status::WT_MODIFIED) {
            Some("modified".to_string())
        } else if status.contains(Status::WT_DELETED) {
            Some("deleted".to_string())
        } else if status.contains(Status::WT_RENAMED) {
            Some("renamed".to_string())
        } else if status.contains(Status::WT_TYPECHANGE) {
            Some("typechanged".to_string())
        } else {
            None
        };

        result.insert(path, GitFileStatus { staged, unstaged });
    }

    Ok(result)
}

// -- Reading & Writing --

/// Reads a repository file as UTF-8 text for the file viewer.
///
/// # Arguments
///
/// * `repo_path` - Selected repository directory.
/// * `file_path` - File to read.
///
/// # Behavior
///
/// Canonicalizes paths, limits reads to existing regular files within the
/// selected repository path, and rejects files larger than 2 MiB.
///
/// # Returns
///
/// The decoded UTF-8 file contents.
///
/// # Errors
///
/// Returns a filesystem or validation error, or `UNSUPPORTED_BINARY_FILE`
/// when the bytes are not valid UTF-8.
#[tauri::command]
fn read_file(repo_path: String, file_path: String) -> Result<String, String> {
    let repo_root = fs::canonicalize(&repo_path).map_err(|error| error.to_string())?;

    let file = fs::canonicalize(&file_path).map_err(|error| error.to_string())?;

    if !file.starts_with(&repo_root) {
        return Err("File is outside the selected repository.".to_string());
    }

    if !file.is_file() {
        return Err("Selected path is not a file.".to_string());
    }

    let metadata = fs::metadata(&file).map_err(|error| error.to_string())?;

    if metadata.len() > 2 * 1024 * 1024 {
        return Err("File exceeds the 2 MiB size limit..".to_string());
    }

    let bytes = fs::read(&file).map_err(|e| format!("Failed to read file: {e}"))?;

    let contents = String::from_utf8(bytes).map_err(|_| "UNSUPPORTED_BINARY_FILE".to_string())?;

    Ok(contents)
}

/// Reads a supported repository image as raw bytes for frontend display.
///
/// # Arguments
///
/// * `repo_path` - Selected repository.
/// * `file_path` - Absolute or repository-relative image path.
///
/// # Behavior
///
/// Resolves the path within the worktree, accepts PNG, JPEG, GIF, WebP and SVG
/// extensions, and enforces a 20 MiB maximum size.
///
/// # Returns
///
/// The image's original bytes, without decoding them in Rust.
///
/// # Errors
///
/// Returns an error for inaccessible or out-of-repository paths, unsupported
/// extensions, oversized files, and read failures.
#[tauri::command]
fn read_image(repo_path: String, file_path: String) -> Result<Vec<u8>, String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let workdir = repo.workdir().ok_or("Cannot read files in a bare repository.")?;

    let repo_root = workdir.canonicalize().map_err(|error| error.to_string())?;

    let supplied_path = Path::new(&file_path);

    let target = if supplied_path.is_absolute() {
        supplied_path.to_path_buf()
    } else {
        repo_root.join(supplied_path)
    };

    let resolved = target.canonicalize().map_err(|error| error.to_string())?;

    if !resolved.starts_with(&repo_root) {
        return Err("Cannot read images outside the repository.".to_string());
    }

    if !resolved.is_file() {
        return Err("The selected path is not a file.".to_string());
    }

    let extension = resolved
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_lowercase();

    if !["png", "jpg", "jpeg", "gif", "webp", "svg"].contains(&extension.as_str()) {
        return Err("Unsupported image format.".to_string());
    }

    let metadata = fs::metadata(&resolved).map_err(|error| error.to_string())?;

    if metadata.len() > 20 * 1024 * 1024 {
        return Err("Image exceeds the 20 MiB size limit.".to_string());
    }

    fs::read(&resolved).map_err(|error| format!("Failed to read image: {error}"))
}

/// Reads a supported document as bytes for the frontend PDF/DOCX viewer.
///
/// # Arguments
///
/// * `repo_path` - Selected repository.
/// * `file_path` - Absolute or repository-relative document path.
///
/// # Behavior
///
/// Resolves and validates the file path within the worktree, permits PDF and
/// DOCX extensions, and enforces a 20 MiB maximum size.
///
/// # Returns
///
/// The document's original bytes.
///
/// # Errors
///
/// Returns an error for invalid paths, unsupported extensions, size-limit
/// violations, and filesystem read failures.
#[tauri::command]
fn read_document(repo_path: String, file_path: String) -> Result<Vec<u8>, String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let workdir = repo.workdir().ok_or("Cannot read files in a bare repository.")?;

    let repo_root = workdir.canonicalize().map_err(|error| error.to_string())?;

    let supplied_path = std::path::Path::new(&file_path);

    let target = if supplied_path.is_absolute() {
        supplied_path.to_path_buf()
    } else {
        repo_root.join(supplied_path)
    };

    let resolved = target.canonicalize().map_err(|error| error.to_string())?;

    if !resolved.starts_with(&repo_root) {
        return Err("File is outside the selected repository.".to_string());
    }

    if !resolved.is_file() {
        return Err("Selected path is not a regular file.".to_string());
    }

    let extension = resolved
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_lowercase();

    if !["pdf", "docx"].contains(&extension.as_str()) {
        return Err("Unsupported document format.".to_string());
    }

    let metadata = fs::metadata(&resolved).map_err(|error| error.to_string())?;

    if metadata.len() > 20 * 1024 * 1024 {
        return Err("Document exceeds the 20 MiB limit.".to_string());
    }

    fs::read(&resolved).map_err(|error| format!("Failed to read document: {error}"))
}

/// Overwrites an existing text file inside the selected worktree.
///
/// # Arguments
///
/// * `repo_path` - Selected repository.
/// * `file_path` - Absolute or repository-relative file path.
/// * `contents` - Replacement text to write.
///
/// # Behavior
///
/// Canonicalizes the existing destination and checks that it is a regular file
/// inside the worktree before writing. This command does not stage the change.
///
/// # Returns
///
/// `Ok(())` after a successful write.
///
/// # Errors
///
/// Returns an error for bare repositories, invalid or escaping paths,
/// non-files, or unsuccessful writes.
#[tauri::command]
fn save_file(repo_path: String, file_path: String, contents: String) -> Result<(), String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let workdir = repo.workdir().ok_or("Cannot edit files in a bare repository.")?;

    let repo_root = workdir.canonicalize().map_err(|error| error.to_string())?;

    let supplied_path = Path::new(&file_path);

    let target = if supplied_path.is_absolute() {
        supplied_path.to_path_buf()
    } else {
        repo_root.join(supplied_path)
    };

    let resolved = target.canonicalize().map_err(|error| format!("Invalid file path: {error}"))?;

    if !resolved.starts_with(&repo_root) {
        return Err("Cannot save files outside the selected repository.".to_string());
    }

    if !resolved.is_file() {
        return Err("The selected path is not a regular file.".to_string());
    }

    fs::write(&resolved, contents).map_err(|error| format!("Failed to save file: {error}"))?;

    Ok(())
}

// -- Filesystem Management & Safety --

/// Creates a file or directory within the repository working tree.
///
/// # Arguments
///
/// * `repo_path` - Selected repository.
/// * `parent_path` - Existing destination directory, absolute or relative.
/// * `name` - New entry's filename or directory name.
/// * `is_directory` - Whether to create a directory instead of a file.
///
/// # Behavior
///
/// Rejects traversal-like names, separators and `.git`; canonicalizes the parent
/// and verifies that it stays within the worktree and outside Git metadata.
/// Files are created with `create_new` rather than overwriting existing ones.
///
/// # Returns
///
/// `Ok(())` after the entry is created.
///
/// # Errors
///
/// Returns an error for invalid names or parents, repository-boundary failures,
/// existing file targets, and filesystem creation errors.
#[tauri::command]
fn create_entry(
    repo_path: String,
    parent_path: String,
    name: String,
    is_directory: bool
) -> Result<(), String> {
    if
        name.is_empty() ||
        name == "." ||
        name == ".." ||
        name.contains('/') ||
        name.contains('\\') ||
        name.contains('\0') ||
        name.eq_ignore_ascii_case(".git")
    {
        return Err("Invalid file or folder name.".to_string());
    }

    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let workdir = repo.workdir().ok_or("Cannot create files in a bare repository.")?;

    let repo_root = workdir.canonicalize().map_err(|error| error.to_string())?;

    let supplied_parent = Path::new(&parent_path);

    let parent = if supplied_parent.is_absolute() {
        supplied_parent.to_path_buf()
    } else {
        repo_root.join(supplied_parent)
    };

    // Resolve the existing parent before checking the worktree boundary.
    let resolved_parent = parent.canonicalize().map_err(|error| error.to_string())?;

    if !resolved_parent.starts_with(&repo_root) {
        return Err("Cannot create entries outside the repository.".into());
    }

    if !resolved_parent.is_dir() {
        return Err("The selected parent is not a directory.".into());
    }

    let relative_parent = resolved_parent
        .strip_prefix(&repo_root)
        .map_err(|error| error.to_string())?;

    if
        relative_parent
            .components()
            .any(|component| {
                component.as_os_str().to_string_lossy().eq_ignore_ascii_case(".git")
            })
    {
        return Err("Cannot modify Git metadata.".into());
    }

    let target = resolved_parent.join(&name);

    if is_directory {
        fs::create_dir(&target).map_err(|error| format!("Failed to create folder: {error}"))?;
    } else {
        // create_new refuses to overwrite an existing file.
        fs::OpenOptions
            ::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|error| format!("Failed to create file: {error}"))?;
    }
    Ok(())
}

/// Permanently deletes an existing file or directory in the worktree.
///
/// # Arguments
///
/// * `repo_path` - Selected repository.
/// * `entry_path` - Existing file or directory to delete.
///
/// # Behavior
///
/// Rejects symbolic links, the repository root and paths within `.git`. Scans
/// candidate directories for nested Git metadata before recursively deleting them.
/// Deletion operates on the filesystem; Git does not automatically recover
/// untracked files or other uncommitted data.
///
/// # Returns
///
/// `Ok(())` after deletion succeeds.
///
/// # Errors
///
/// Returns an error for unsafe paths, Git metadata, unsupported entry types,
/// filesystem traversal failures, or unsuccessful deletion.
#[tauri::command]
fn delete_entry(repo_path: String, entry_path: String) -> Result<(), String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let workdir = repo.workdir().ok_or("Cannot delete files in a bare repository.")?;

    let repo_root = workdir.canonicalize().map_err(|error| error.to_string())?;

    let supplied_path = Path::new(&entry_path);

    let target = if supplied_path.is_absolute() {
        supplied_path.to_path_buf()
    } else {
        repo_root.join(supplied_path)
    };

    // Inspect the entry itself rather than following a symbolic link.
    let metadata = fs::symlink_metadata(&target).map_err(|error| error.to_string())?;

    if metadata.file_type().is_symlink() {
        return Err("Deleting symbolic links is not supported.".into());
    }

    let resolved = target.canonicalize().map_err(|error| error.to_string())?;

    if !resolved.starts_with(&repo_root) || resolved == repo_root {
        return Err("Cannot delete this path.".into());
    }

    let relative_path = resolved.strip_prefix(&repo_root).map_err(|error| error.to_string())?;

    if
        relative_path
            .components()
            .any(|component| {
                component.as_os_str().to_string_lossy().eq_ignore_ascii_case(".git")
            })
    {
        return Err("Cannot modify Git metadata.".into());
    }

    // A recursive delete must not erase another repository nested inside this folder.
    if metadata.is_dir() && contains_git_metadata(&resolved)? {
        return Err("This directory contains Git metadata and cannot be deleted.".into());
    }

    if metadata.is_dir() {
        fs
            ::remove_dir_all(&resolved)
            .map_err(|error| format!("Failed to delete directory: {error}"))?;
    } else if metadata.is_file() {
        fs::remove_file(&resolved).map_err(|error| format!("Failed to delete file: {error}"))?;
    } else {
        return Err("Unsupported filesystem entry.".into());
    }

    Ok(())
}

/// Renames a file or directory without moving it to another parent.
///
/// # Arguments
///
/// * `repo_path` - Selected repository.
/// * `entry_path` - Existing entry to rename.
/// * `new_name` - New leaf name, without path separators.
///
/// # Behavior
///
/// Rejects invalid names, symlinks, the worktree root, and `.git` paths.
/// Constructs the destination in the same parent and refuses to overwrite an
/// existing entry.
///
/// # Returns
///
/// `Ok(())` on success or when the destination equals the source.
///
/// # Errors
///
/// Returns an error for unsafe paths, naming collisions, invalid entry types,
/// or filesystem rename failures.
#[tauri::command]
fn rename_entry(repo_path: String, entry_path: String, new_name: String) -> Result<(), String> {
    if
        new_name.is_empty() ||
        new_name == "." ||
        new_name == ".." ||
        new_name.contains('/') ||
        new_name.contains('\\') ||
        new_name.contains('\0') ||
        new_name.eq_ignore_ascii_case(".git")
    {
        return Err("Invalid file or folder name.".into());
    }

    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let workdir = repo.workdir().ok_or("Cannot rename entries in a bare repository.")?;

    let repo_root = workdir.canonicalize().map_err(|error| error.to_string())?;

    let supplied_path = Path::new(&entry_path);

    let target = if supplied_path.is_absolute() {
        supplied_path.to_path_buf()
    } else {
        repo_root.join(supplied_path)
    };

    let metadata = fs::symlink_metadata(&target).map_err(|error| error.to_string())?;

    if metadata.file_type().is_symlink() {
        return Err("Renaming symbolic links is not supported.".into());
    }

    let resolved = target.canonicalize().map_err(|error| error.to_string())?;

    if !resolved.starts_with(&repo_root) || resolved == repo_root {
        return Err("Cannot rename this path.".into());
    }

    let relative_path = resolved.strip_prefix(&repo_root).map_err(|error| error.to_string())?;

    if
        relative_path
            .components()
            .any(|component| {
                component.as_os_str().to_string_lossy().eq_ignore_ascii_case(".git")
            })
    {
        return Err("Cannot modify Git metadata.".into());
    }

    let parent = resolved.parent().ok_or("Could not determine the parent directory.")?;

    let destination = parent.join(&new_name);

    if destination == resolved {
        return Ok(());
    }

    // Do not overwrite an existing entry with a rename.
    if fs::symlink_metadata(&destination).is_ok() {
        return Err("A file or folder with that name already exists.".into());
    }

    fs
        ::rename(&resolved, &destination)
        .map_err(|error| format!("Failed to rename entry: {error}"))?;

    Ok(())
}

/// Moves an existing worktree entry into another directory of the repository.
///
/// # Arguments
///
/// * `repo_path` - Selected repository.
/// * `entry_path` - File or directory to move.
/// * `destination_path` - Existing destination directory.
///
/// # Behavior
///
/// Resolves both paths within the worktree and disallows changes to `.git`,
/// the repository root, symlinks and directories containing Git metadata.
/// Refuses to move a directory into itself or overwrite a destination entry.
///
/// # Returns
///
/// `Ok(())` when the move succeeds or resolves to the existing path.
///
/// # Errors
///
/// Returns an error for unsafe paths, invalid destinations, name collisions,
/// Git metadata, or filesystem rename failures.
#[tauri::command]
fn move_entry(
    repo_path: String,
    entry_path: String,
    destination_path: String
) -> Result<(), String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let workdir = repo.workdir().ok_or("Cannot move files in a bare repository.")?;

    let repo_root = workdir.canonicalize().map_err(|error| error.to_string())?;

    let resolve = |path: &str| -> Result<PathBuf, String> {
        let supplied = Path::new(path);

        let target = if supplied.is_absolute() {
            supplied.to_path_buf()
        } else {
            repo_root.join(supplied)
        };

        target.canonicalize().map_err(|error| error.to_string())
    };

    let source = resolve(&entry_path)?;
    let destination_dir = resolve(&destination_path)?;

    if !source.starts_with(&repo_root) || !destination_dir.starts_with(&repo_root) {
        return Err("Cannot move files outside the repository.".into());
    }

    if source == repo_root {
        return Err("Cannot move the repository root.".into());
    }

    for path in [&source, &destination_dir] {
        let relative = path.strip_prefix(&repo_root).map_err(|error| error.to_string())?;

        if
            relative
                .components()
                .any(|component| {
                    component.as_os_str().to_string_lossy().eq_ignore_ascii_case(".git")
                })
        {
            return Err("Cannot modify Git metadata.".into());
        }
    }

    let supplied_source = Path::new(&entry_path);

    let original_source = if supplied_source.is_absolute() {
        supplied_source.to_path_buf()
    } else {
        repo_root.join(supplied_source)
    };

    let metadata = fs::symlink_metadata(&original_source).map_err(|error| error.to_string())?;

    if metadata.file_type().is_symlink() {
        return Err("Moving symbolic links is not supported.".into());
    }

    if !metadata.is_file() && !metadata.is_dir() {
        return Err("Unsupported filesystem entry.".into());
    }

    if !destination_dir.is_dir() {
        return Err("Destination must be a directory.".into());
    }

    // Moving a directory into itself would make the hierarchy invalid.
    if metadata.is_dir() && destination_dir.starts_with(&source) {
        return Err("Cannot move a folder inside itself.".into());
    }

    // Protect nested repositories from being relocated inadvertently.
    if metadata.is_dir() && contains_git_metadata(&source)? {
        return Err("Cannot move a directory containing Git metadata.".into());
    }

    let filename = source.file_name().ok_or("Could not determine the entry name.")?;

    let destination = destination_dir.join(filename);

    if destination == source {
        return Ok(());
    }

    if fs::symlink_metadata(&destination).is_ok() {
        return Err("A file or folder with that name already exists in the destination.".into());
    }

    fs::rename(&source, &destination).map_err(|error| format!("Failed to move entry: {error}"))?;

    Ok(())
}

/// Checks a directory tree for nested `.git` entries.
///
/// # Arguments
///
/// * `path` - Directory to inspect recursively.
///
/// # Returns
///
/// `Ok(true)` if `.git` is found; `Ok(false)` otherwise.
///
/// # Errors
///
/// Returns an error if a directory or its entry metadata cannot be read.
fn contains_git_metadata(path: &Path) -> Result<bool, String> {
    if !path.is_dir() {
        return Ok(false);
    }

    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;

        if entry.file_name().to_string_lossy() == ".git" {
            return Ok(true);
        }

        // Inspect link metadata so directory symlinks are not recursively followed.
        let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;

        if metadata.is_dir() && contains_git_metadata(&entry.path())? {
            return Ok(true);
        }
    }

    Ok(false)
}

// -- Git Staging & File Changes --

/// Adds a file's current worktree contents to the Git index (staging area).
///
/// # Arguments
///
/// * `repo_path` - Selected Git repository.
/// * `file_path` - File path supplied by the Explorer.
///
/// # Behavior
///
/// Converts the supplied path to a worktree-relative path because Git index
/// operations use paths relative to the repository. Adds the path to the index
/// and writes the updated index to disk.
///
/// # Returns
///
/// `Ok(())` when the index has been written.
///
/// # Errors
///
/// Returns an error for invalid repositories or paths, bare repositories,
/// or Git index update/write failures.
#[tauri::command]
fn stage_file(repo_path: String, file_path: String) -> Result<(), String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let repo_root = repo
        .workdir()
        .ok_or_else(|| "Cannot stage files in a bare repository.".to_string())?;

    // Git index paths are relative to the worktree, not absolute UI paths.
    let relative_path = Path::new(&file_path)
        .strip_prefix(repo_root)
        .map_err(|_| "File is outside the repository.".to_string())?;

    let mut index = repo.index().map_err(|error| error.to_string())?;

    index.add_path(relative_path).map_err(|error| format!("Could not stage file: {}", error))?;

    // Persist the staged snapshot for subsequent Git operations.
    index.write().map_err(|error| format!("Could not save Git index: {}", error))?;

    Ok(())
}

/// Resets a staged path in the index against HEAD, without editing its contents.
///
/// # Arguments
///
/// * `repo_path` - Selected Git repository.
/// * `file_path` - Existing file whose staged change should be reset.
///
/// # Behavior
///
/// Canonicalizes the worktree and file paths, then uses `reset_default` against
/// the current HEAD commit. Passes `None` for HEAD when the branch is unborn.
/// The existing-file requirement currently prevents unstaging a deleted file.
///
/// # Returns
///
/// `Ok(())` after a successful index reset.
///
/// # Errors
///
/// Returns an error for invalid or missing paths, bare repositories, HEAD
/// resolution errors, or Git reset failures.
#[tauri::command]
fn unstage_file(repo_path: String, file_path: String) -> Result<(), String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let repo_root = repo.workdir().ok_or("Cannot unstage files in a bare repository.")?;

    let repo_root = fs::canonicalize(repo_root).map_err(|error| error.to_string())?;

    let file = fs::canonicalize(&file_path).map_err(|error| error.to_string())?;

    let relative_path = file
        .strip_prefix(&repo_root)
        .map_err(|_| "File is outside the repository.")?;

    if !file.is_file() {
        return Err("Selected path is not a file.".to_string());
    }

    // An unborn branch has no parent commit to reset the index against.
    let head = match repo.head() {
        Ok(head) => {
            let commit = head.peel_to_commit().map_err(|error| error.to_string())?;

            Some(commit.into_object())
        }
        Err(error) if matches!(error.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => {
            None
        }
        Err(error) => {
            return Err(error.to_string());
        }
    };

    // Reset only this path in the index, leaving worktree contents alone.
    repo
        .reset_default(head.as_ref(), [relative_path])
        .map_err(|error| format!("Could not unstage file: {}", error))?;

    Ok(())
}

/// Builds a line-oriented diff for one file relative to the HEAD snapshot.
///
/// # Arguments
///
/// * `repo_path` - Selected Git repository.
/// * `file_path` - Existing file to compare.
///
/// # Behavior
///
/// Requests the combined HEAD-to-worktree diff using the index, includes untracked
/// content, and asks for three lines of context. Converts libgit2's patch lines
/// into added, removed and context records with their original/new line numbers.
///
/// # Returns
///
/// A vector of `FileDiffLine` records for the frontend diff viewer.
///
/// # Errors
///
/// Returns an error for invalid paths, missing files, repository/HEAD errors,
/// or diff generation/printing failures.
#[tauri::command]
fn get_file_diff(repo_path: String, file_path: String) -> Result<Vec<FileDiffLine>, String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let repo_root = repo.workdir().ok_or("Repository has no working directory.")?;

    let repo_root = fs::canonicalize(repo_root).map_err(|error| error.to_string())?;

    let file = fs::canonicalize(&file_path).map_err(|error| error.to_string())?;

    let relative_path = file
        .strip_prefix(&repo_root)
        .map_err(|_| "File is outside the repository.")?;

    if !file.is_file() {
        return Err("Selected path is not a file.".to_string());
    }

    // An unborn HEAD has no committed tree; libgit2 accepts an absent base tree.
    let head_tree = match repo.head() {
        Ok(head) => Some(head.peel_to_tree().map_err(|error| error.to_string())?),
        Err(error) if matches!(error.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => {
            None
        }
        Err(error) => {
            return Err(error.to_string());
        }
    };

    let mut options = DiffOptions::new();

    options
        .pathspec(relative_path)
        .show_untracked_content(true)
        .recurse_untracked_dirs(true)
        .context_lines(3);

    let diff = repo
        .diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut options))
        .map_err(|error| error.to_string())?;

    let mut lines = Vec::new();

    diff
        .print(DiffFormat::Patch, |_delta, _hunk, line| {
            let line_type = match line.origin() {
                '+' => "added",
                '-' => "removed",
                ' ' => "context",
                // Ignore patch headers and other non-content records.
                _ => {
                    return true;
                }
            };

            let content = String::from_utf8_lossy(line.content())
                .trim_end_matches(['\r', '\n'])
                .to_string();

            lines.push(FileDiffLine {
                old_line_number: line.old_lineno(),
                new_line_number: line.new_lineno(),
                line_type: line_type.to_string(),
                content,
            });

            true
        })
        .map_err(|error| error.to_string())?;

    Ok(lines)
}

// -- Git Commits & History --

/// Creates a Git commit from the current index, optionally staging all changes first.
///
/// # Arguments
///
/// * `repo_path` - Repository to commit to.
/// * `message` - Commit message supplied by the user.
/// * `commit_all` - Whether to stage tracked/untracked work before committing.
///
/// # Behavior
///
/// Optionally updates the index, writes a tree from the index snapshot, obtains
/// the configured Git identity, and creates a commit whose parent is the current
/// HEAD commit. The current implementation requires an existing parent commit,
/// so it does not handle a repository's first commit.
///
/// # Returns
///
/// The new commit's object ID as a string.
///
/// # Errors
///
/// Returns an error for missing Git identity, invalid repository/HEAD,
/// index/tree failures, or unsuccessful commit creation.
#[tauri::command]
fn commit_changes(repo_path: String, message: String, commit_all: bool) -> Result<String, String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let mut index = repo.index().map_err(|error| error.to_string())?;

    // Commit All first updates the index; Commit Staged leaves it untouched.
    if commit_all {
        index.add_all(["*"], IndexAddOption::DEFAULT, None).map_err(|error| error.to_string())?;

        index.update_all(["*"], None).map_err(|error| error.to_string())?;

        index.write().map_err(|error| error.to_string())?;
    }

    // A commit references an immutable tree snapshot written from the index.
    let tree_oid = index.write_tree().map_err(|error| error.to_string())?;

    let tree = repo.find_tree(tree_oid).map_err(|error| error.to_string())?;

    let signature = repo.signature().map_err(|error| error.to_string())?;

    // Current implementation assumes HEAD already points to a commit.
    let parent = repo
        .head()
        .map_err(|error| error.to_string())?
        .peel_to_commit()
        .map_err(|error| error.to_string())?;

    let commit_oid = repo
        .commit(Some("HEAD"), &signature, &signature, &message, &tree, &[&parent])
        .map_err(|error| error.to_string())?;
    Ok(commit_oid.to_string())
}

/// Retrieves a bounded list of commits for the history table and graph.
///
/// # Arguments
///
/// * `repo_path` - Repository whose history should be traversed.
///
/// # Behavior
///
/// Starts a libgit2 revision walk from local and remote branch references, with
/// topological and time sorting, and reads at most 50 reachable commits.
/// Includes each commit's parent IDs for graph connection calculations.
///
/// # Returns
///
/// Up to 50 `CommitInfo` records containing identifiers, summary, author,
/// timestamp and parent IDs.
///
/// # Errors
///
/// Returns an error if repository opening, revision walking, or commit
/// lookup fails.
#[tauri::command]
fn get_commit_history(repo_path: String) -> Result<Vec<CommitInfo>, String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let mut revwalk = repo.revwalk().map_err(|error| error.to_string())?;
    // Respect ancestry while making newer commits appear earlier where possible.
    revwalk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME).map_err(|error| error.to_string())?;
    revwalk.push_glob("refs/heads/*").map_err(|error| error.to_string())?;
    revwalk.push_glob("refs/remotes/*").map_err(|error| error.to_string())?;

    let mut commits = Vec::new();
    // Bound UI work by returning only the first 50 reachable commits.
    for oid_result in revwalk.take(50) {
        let oid = oid_result.map_err(|error| error.to_string())?;
        let commit = repo.find_commit(oid).map_err(|error| error.to_string())?;

        let info = CommitInfo {
            hash: commit.id().to_string(),
            message: commit
                .summary()
                .map_err(|error| error.to_string())?
                .unwrap_or("")
                .to_string(),
            author: commit.author().name().unwrap_or("Unknown").to_string(),
            timestamp: commit.time().seconds(),
            parents: commit
                .parent_ids()
                .map(|id| id.to_string())
                .collect(),
        };

        commits.push(info);
    }

    Ok(commits)
}

/// Summarizes files changed by a commit relative to its first parent.
///
/// # Arguments
///
/// * `repo_path` - Repository containing the commit.
/// * `commit_hash` - Object ID of the selected commit.
///
/// # Behavior
///
/// Diffs the selected commit's tree against its first parent's tree, or against
/// an empty tree for an initial commit. Performs similarity detection and gathers
/// per-file added/deleted line counts when a text patch is available. For merge
/// commits, the comparison uses only the first parent.
///
/// # Returns
///
/// A list of paths, change statuses and optional line counts.
///
/// # Errors
///
/// Returns an error for invalid commit IDs, missing objects, diff failures,
/// or patch/statistics errors.
#[tauri::command]
fn get_commit_file_changes(
    repo_path: String,
    commit_hash: String
) -> Result<Vec<CommitFileChange>, String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let oid = Oid::from_str(&commit_hash).map_err(|error| error.to_string())?;

    let commit = repo.find_commit(oid).map_err(|error| error.to_string())?;

    let commit_tree = commit.tree().map_err(|error| error.to_string())?;

    // Compare merge commits to their first parent; roots use an empty base.
    let parent_tree = if commit.parent_count() > 0 {
        Some(
            commit
                .parent(0)
                .map_err(|error| error.to_string())?
                .tree()
                .map_err(|error| error.to_string())?
        )
    } else {
        None
    };

    let mut diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), None)
        .map_err(|error| error.to_string())?;

    // Detect similar entries so renames can appear as renames in the UI.
    diff.find_similar(None).map_err(|error| error.to_string())?;

    let mut changes = Vec::new();

    for (index, delta) in diff.deltas().enumerate() {
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|| "Unknown file".to_string());

        let status = format!("{:?}", delta.status());

        let patch = Patch::from_diff(&diff, index).map_err(|error| error.to_string())?;

        let (additions, deletions) = match patch {
            Some(patch) => {
                let (_, added, removed) = patch.line_stats().map_err(|error| error.to_string())?;

                (Some(added), Some(removed))
            }
            None => (None, None),
        };

        changes.push(CommitFileChange {
            path,
            status,
            additions,
            deletions,
        });
    }

    Ok(changes)
}

// -- Git Branches --

/// Lists local branches with the current-branch flag and tip commit ID.
///
/// Returns `BranchInfo` records or a repository/branch lookup error.
#[tauri::command]
fn get_local_branches(repo_path: String) -> Result<Vec<BranchInfo>, String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let mut branches = Vec::new();

    let iterator = repo.branches(Some(BranchType::Local)).map_err(|error| error.to_string())?;

    for branch_result in iterator {
        let (branch, _) = branch_result.map_err(|error| error.to_string())?;

        let name = branch
            .name()
            .map_err(|error| error.to_string())?
            .unwrap_or("Unknown")
            .to_string();

        let is_current = branch.is_head();

        let commit_hash = branch
            .get()
            .target()
            .map(|oid| oid.to_string());

        branches.push(BranchInfo {
            name,
            is_current,
            commit_hash,
        });
    }

    Ok(branches)
}

/// Checks out a local branch while protecting uncommitted worktree changes.
///
/// # Arguments
///
/// * `repo_path` - Repository whose current branch will change.
/// * `branch_name` - Name of the destination local branch.
///
/// # Behavior
///
/// Returns immediately if the requested branch is already checked out. Otherwise
/// requires a clean Git operation state and no reported worktree/index changes,
/// including untracked entries. Performs a safe checkout of the destination commit
/// before updating HEAD to the destination branch reference.
///
/// # Returns
///
/// `Ok(())` when the branch is already current or switching succeeds.
///
/// # Errors
///
/// Returns an error for missing branches, pending operations, uncommitted
/// changes, unsafe checkouts or HEAD update failures.
#[tauri::command]
fn switch_branch(repo_path: String, branch_name: String) -> Result<(), String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let branch = repo
        .find_branch(&branch_name, BranchType::Local)
        .map_err(|error| error.to_string())?;

    if branch.is_head() {
        return Ok(());
    }

    // Do not interrupt an unfinished merge, rebase or other Git operation.
    if repo.state() != RepositoryState::Clean {
        return Err(
            "A Git operation is in progress. Finish or abort it before switching branches.".to_string()
        );
    }

    let mut options = StatusOptions::new();
    options.include_untracked(true).recurse_untracked_dirs(true);

    let statuses = repo.statuses(Some(&mut options)).map_err(|error| error.to_string())?;

    if !statuses.is_empty() {
        return Err(
            "Uncommitted changes detected. Commit, stash, or discard your changes before switching branches.".to_string()
        );
    }

    let reference_name = branch
        .get()
        .name()
        .map_err(|error| error.to_string())?
        .to_string();

    let commit = branch
        .get()
        .peel_to_commit()
        .map_err(|error| error.to_string())?;

    let object = repo.find_object(commit.id(), None).map_err(|error| error.to_string())?;

    // A safe checkout refuses changes that would overwrite local work.
    let mut checkout = CheckoutBuilder::new();
    checkout.safe();

    repo
        .checkout_tree(&object, Some(&mut checkout))
        .map_err(|error| format!("Branch checkout failed: {error}"))?;

    repo.set_head(&reference_name).map_err(|error| error.to_string())?;

    Ok(())
}

/// Creates a new local branch pointing at HEAD without checking it out.
///
/// Returns an error when Git is busy, HEAD is unresolved, or the name is invalid or taken.
#[tauri::command]
fn create_branch(repo_path: String, branch_name: String) -> Result<(), String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;
    let name = branch_name.trim();

    if name.is_empty() {
        return Err("Branch name cannot be empty.".to_string());
    }
    if repo.state() != RepositoryState::Clean {
        return Err("Finish the current Git operation before creating a branch.".to_string());
    }

    let head = repo.head().map_err(|error| error.to_string())?;

    let commit = head.peel_to_commit().map_err(|error| error.to_string())?;

    // false prevents overwriting an existing branch.
    repo.branch(name, &commit, false).map_err(|error| error.to_string())?;

    Ok(())
}

/// Merges a source local branch into a target local branch.
///
/// # Arguments
///
/// * `repo_path` - Repository containing both branches.
/// * `source_branch` - Branch supplying changes.
/// * `target_branch` - Branch receiving changes.
///
/// # Behavior
///
/// Requires a clean repository state and worktree. Detects an up-to-date target,
/// then chooses a fast-forward when the target is an ancestor of the source.
/// For diverged branches, previews a merge for conflicts before switching to
/// the target and performing a merge commit with both parents. Does not expose
/// interactive conflict resolution; the operation may still fail after changes
/// have begun if a checkout or merge step errors.
///
/// # Returns
///
/// A human-readable message identifying an up-to-date, fast-forward or
/// completed merge.
///
/// # Errors
///
/// Returns an error for invalid branches, uncommitted changes, detached HEAD,
/// conflicts, checkout failures, Git merge failures or commit/cleanup failures.
#[tauri::command]
fn merge_branches(
    repo_path: String,
    source_branch: String,
    target_branch: String
) -> Result<String, String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    if source_branch == target_branch {
        return Err("Cannot merge a branch into itself.".to_string());
    }
    if repo.state() != RepositoryState::Clean {
        return Err("Finish or abort the current Git operation before merging.".to_string());
    }
    if repo.head_detached().map_err(|error| error.to_string())? {
        return Err("Check out a local branch before merging.".to_string());
    }

    let mut status_options = StatusOptions::new();

    status_options.include_untracked(true).recurse_untracked_dirs(true);

    let statuses = repo.statuses(Some(&mut status_options)).map_err(|error| error.to_string())?;

    if !statuses.is_empty() {
        return Err(
            "Uncommitted changes detected. Commit or stash them before merging.".to_string()
        );
    }

    let source = repo
        .find_branch(&source_branch, BranchType::Local)
        .map_err(|error| error.to_string())?;

    let target = repo
        .find_branch(&target_branch, BranchType::Local)
        .map_err(|error| error.to_string())?;

    let source_commit = source
        .get()
        .peel_to_commit()
        .map_err(|error| error.to_string())?;

    let target_commit = target
        .get()
        .peel_to_commit()
        .map_err(|error| error.to_string())?;

    // If the target already descends from the source, it needs no update.
    let up_to_date =
        source_commit.id() == target_commit.id() ||
        repo
            .graph_descendant_of(target_commit.id(), source_commit.id())
            .map_err(|error| error.to_string())?;

    if up_to_date {
        return Ok(format!("{target_branch} already contains {source_branch}."));
    }

    // Fast-forward is possible when the target is an ancestor of the source.
    let fast_forward = repo
        .graph_descendant_of(source_commit.id(), target_commit.id())
        .map_err(|error| error.to_string())?;

    // Preview diverged history for conflicts before altering branches.
    if !fast_forward {
        let preview = repo
            .merge_commits(&target_commit, &source_commit, None)
            .map_err(|error| error.to_string())?;

        if preview.has_conflicts() {
            return Err(
                format!(
                    "Cannot automatically merge {source_branch} into \
                 {target_branch}: merge conflicts were detected. \
                 No branches were changed."
                )
            );
        }
    }

    // The target must be checked out before updating the working tree.
    if !target.is_head() {
        let object = repo.find_object(target_commit.id(), None).map_err(|error| error.to_string())?;

        let mut checkout = CheckoutBuilder::new();
        checkout.safe();

        repo.checkout_tree(&object, Some(&mut checkout)).map_err(|error| error.to_string())?;

        let reference_name = target
            .get()
            .name()
            .map_err(|error| error.to_string())?;

        repo.set_head(reference_name).map_err(|error| error.to_string())?;
    }

    // Advance the branch reference without producing a merge commit.
    if fast_forward {
        let object = repo.find_object(source_commit.id(), None).map_err(|error| error.to_string())?;

        let mut checkout = CheckoutBuilder::new();
        checkout.safe();

        repo.checkout_tree(&object, Some(&mut checkout)).map_err(|error| error.to_string())?;

        let mut target_ref = repo
            .find_reference(&format!("refs/heads/{target_branch}"))
            .map_err(|error| error.to_string())?;

        target_ref
            .set_target(source_commit.id(), "Fast-forward merge")
            .map_err(|error| error.to_string())?;

        return Ok(format!("Fast-forwarded {target_branch} to {source_branch}."));
    }

    // Diverged histories require a two-parent merge commit.
    let annotated = repo
        .find_annotated_commit(source_commit.id())
        .map_err(|error| error.to_string())?;

    let mut checkout = CheckoutBuilder::new();
    checkout.safe();

    repo.merge(&[&annotated], None, Some(&mut checkout)).map_err(|error| error.to_string())?;

    let mut index = repo.index().map_err(|error| error.to_string())?;

    if index.has_conflicts() {
        return Err(
            "The merge produced conflicts. Resolve or abort \
             the in-progress merge before continuing.".to_string()
        );
    }

    let tree_oid = index.write_tree().map_err(|error| error.to_string())?;

    let tree = repo.find_tree(tree_oid).map_err(|error| error.to_string())?;

    let signature = repo.signature().map_err(|error| error.to_string())?;

    let message = format!("Merge branch '{source_branch}' into {target_branch}");

    repo
        .commit(
            Some("HEAD"),
            &signature,
            &signature,
            &message,
            &tree,
            &[&target_commit, &source_commit]
        )
        .map_err(|error| error.to_string())?;

    // Clear Git's in-progress merge bookkeeping after a successful commit.
    repo.cleanup_state().map_err(|error| error.to_string())?;

    Ok(format!("Successfully merged {source_branch} into {target_branch}."))
}

// -- Repository Information --

/// Computes repository statistics for the overview panel.
///
/// # Arguments
///
/// * `repo_path` - Repository to inspect.
///
/// # Behavior
///
/// Finds the current branch, counts changed paths and local branches, and walks
/// commits reachable from HEAD to count history and unique author emails.
/// The latest commit ID is also read from HEAD. The current implementation calls
/// `revwalk.push_head()` before its unborn-HEAD guard, so empty repositories may
/// still produce an error.
///
/// # Returns
///
/// A `RepositorySummary` with branch, changed-path, commit, contributor and
/// latest-commit information.
///
/// # Errors
///
/// Returns an error for repository, reference, status or revision-walk failures.
#[tauri::command]
fn get_repository_summary(repo_path: String) -> Result<RepositorySummary, String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    // HEAD may be unborn; later calculations attempt to handle that case.
    let head_commit = match repo.head() {
        Ok(head) => Some(head.peel_to_commit().map_err(|error| error.to_string())?),
        Err(error) if matches!(error.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => {
            None
        }
        Err(error) => {
            return Err(error.to_string());
        }
    };

    let current_branch = match repo.head() {
        Ok(head) if head.is_branch() =>
            Some(
                head
                    .shorthand()
                    .map_err(|error| error.to_string())?
                    .to_string()
            ),
        Ok(_) => None, // Detached HEAD
        Err(error) if error.code() == ErrorCode::UnbornBranch => None,
        Err(error) => {
            return Err(error.to_string());
        }
    };

    let statuses = get_repository_statuses(&repo)?;

    let branches = repo.branches(Some(BranchType::Local)).map_err(|error| error.to_string())?;
    let branch_count = branches
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?
        .len();

    // NOTE: push_head below still fails on an unborn HEAD; leave behavior unchanged.
    let mut revwalk = repo.revwalk().map_err(|error| error.to_string())?;
    revwalk.push_head().map_err(|error| error.to_string())?;
    let mut total_commits = 0;
    let mut contributors = HashSet::new();
    // Count commits and distinct author emails reachable from the current tip.
    if let Some(ref commit) = head_commit {
        let mut revwalk = repo.revwalk().map_err(|error| error.to_string())?;
        revwalk.push(commit.id()).map_err(|error| error.to_string())?;

        for oid_result in revwalk {
            let oid = oid_result.map_err(|error| error.to_string())?;
            let commit = repo.find_commit(oid).map_err(|error| error.to_string())?;
            total_commits += 1;
            let author = commit.author();
            if let Ok(email) = author.email() {
                contributors.insert(email.to_string());
            }
        }
    }
    let contributor_count = contributors.len();

    let latest_commit = match repo.head() {
        Ok(head) => {
            let commit = head.peel_to_commit().map_err(|error| error.to_string())?;

            Some(commit.id().to_string())
        }
        Err(error) if error.code() == ErrorCode::UnbornBranch => None,
        Err(error) => {
            return Err(error.to_string());
        }
    };

    let summary = RepositorySummary {
        current_branch: current_branch,
        changed_files: statuses.len(),
        total_commits: total_commits,
        branch_count: branch_count,
        contributor_count: contributor_count,
        latest_commit: latest_commit,
    };

    Ok(summary)
}

/// Collects recent commits for the activity chart and contributor summary.
///
/// # Arguments
///
/// * `repo_path` - Repository to inspect.
///
/// # Behavior
///
/// Walks commits reachable from local and remote branch references, skipping
/// symbolic references. Retains commits timestamped within the preceding 91 days
/// and no later than the current system time, recording author names for each.
///
/// # Returns
///
/// A list of timestamp/author pairs for recent reachable commits.
///
/// # Errors
///
/// Returns an error for clock, repository, reference traversal or commit
/// lookup failures.
#[tauri::command]
fn get_repository_activity(repo_path: String) -> Result<Vec<ActivityCommit>, String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let mut revwalk = repo.revwalk().map_err(|error| error.to_string())?;

    let now = std::time::SystemTime
        ::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs() as i64;

    // Fetch a 91-day window to supply the frontend's 12-week chart.
    let cutoff = now - 91 * 24 * 60 * 60;

    let references = repo.references().map_err(|error| error.to_string())?;

    for reference in references {
        let reference = reference.map_err(|error| error.to_string())?;

        let name = reference.name().unwrap_or("");

        if !name.starts_with("refs/heads/") && !name.starts_with("refs/remotes/") {
            continue;
        }

        // Avoid duplicate traversal roots from symbolic references.
        if reference.kind() == Some(ReferenceType::Symbolic) {
            continue;
        }

        let commit = reference.peel_to_commit().map_err(|error| error.to_string())?;

        revwalk.push(commit.id()).map_err(|error| error.to_string())?;
    }

    let mut activity = Vec::new();

    for oid_result in revwalk {
        let oid = oid_result.map_err(|error| error.to_string())?;

        let commit = repo.find_commit(oid).map_err(|error| error.to_string())?;

        let timestamp = commit.time().seconds();

        // Exclude old commits and commits dated in the future.
        if timestamp < cutoff || timestamp > now {
            continue;
        }

        let author = commit.author().name().unwrap_or("Unknown").to_string();

        activity.push(ActivityCommit { timestamp, author });
    }

    Ok(activity)
}

// -- Tauri Initilization --

/// Configures and launches the Tauri application.
///
/// Registers Tauri plugins and exposes the repository, filesystem and Git
/// commands to the TypeScript frontend.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder
        ::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(
            tauri::generate_handler![
                get_repository_tree,
                read_file,
                stage_file,
                unstage_file,
                commit_changes,
                get_file_diff,
                get_commit_history,
                get_repository_summary,
                get_local_branches,
                get_commit_file_changes,
                switch_branch,
                get_repository_activity,
                create_branch,
                merge_branches,
                save_file,
                read_image,
                read_document,
                create_entry,
                rename_entry,
                delete_entry,
                move_entry,
                initialize_repository,
                is_git_repository
            ]
        )
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
