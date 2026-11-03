// Rust libraries
use git2::{Repository, Status, StatusOptions};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Serialize)]
// Data structure for each entry in the file tree
struct TreeEntry {
    name: String,
    path: String,
    is_dir: bool,
    unreadable: bool,
    status: Option<String>,
    children: Vec<TreeEntry>,
}

// Reads the directory and creates the file tree structure
fn build_tree(path: &Path, repo_root: &Path, statuses: &HashMap<String, String>) -> TreeEntry {
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

        // Ignores hidden files
        if name.starts_with('.') {
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
                eprintln!(
                    "Could not read metadata for {}: {}",
                    entry_path.display(),
                    error
                );
                continue;
            }
        };

        let is_dir = metadata.is_dir() && !metadata.file_type().is_symlink();

        let (children, unreadable) = if is_dir {
            let child_tree = build_tree(&entry_path, repo_root, statuses);
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

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
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

#[tauri::command]
fn get_repository_tree(path: String) -> Result<TreeEntry, String> {
    let repo = Repository::open(&path)
        .map_err(|_| "The selected folder is not a valid Git repository.".to_string())?;

    let root = repo
        .workdir()
        .ok_or_else(|| "Empty repositories are not supported.".to_string())?;

    let statuses = get_repository_statuses(&repo)?;

    Ok(build_tree(root, root, &statuses))
}

// Creates a hash map of the statuses of each file in the repository, this seemed much faster than grabbing each one individually
fn get_repository_statuses(repo: &Repository) -> Result<HashMap<String, String>, String> {
    let mut options = StatusOptions::new();

    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .include_unmodified(false);

    let statuses = repo
        .statuses(Some(&mut options))
        .map_err(|error| error.to_string())?;

    let mut result = HashMap::new();

    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("Unknown").to_string();

        if let Some(status) = get_status_name(entry.status()) {
            result.insert(path, status.to_string());
        }
    }

    Ok(result)
}

// Turns the git2 status indicator into plain text
fn get_status_name(status: Status) -> Option<&'static str> {
    if status.contains(Status::CONFLICTED) {
        Some("conflicted")
    } else if status.contains(Status::WT_NEW) {
        Some("untracked")
    } else if status.contains(Status::INDEX_NEW) {
        Some("added")
    } else if status.contains(Status::WT_DELETED) || status.contains(Status::INDEX_DELETED) {
        Some("deleted")
    } else if status.contains(Status::WT_RENAMED) || status.contains(Status::INDEX_RENAMED) {
        Some("renamed")
    } else if status.contains(Status::WT_MODIFIED) || status.contains(Status::INDEX_MODIFIED) {
        Some("modified")
    } else {
        None
    }
}

#[tauri::command]
// Reads the file content
fn read_file(repo_path: String, file_path: String) -> Result<String, String> {
    let repo_root = std::fs::canonicalize(&repo_path).map_err(|error| error.to_string())?;

    let file = std::fs::canonicalize(&file_path).map_err(|error| error.to_string())?;

    if !file.starts_with(&repo_root) {
        return Err("File is outside the selected repository.".to_string());
    }

    if !file.is_file() {
        return Err("Selected path is not a file.".to_string());
    }

    let metadata = std::fs::metadata(&file).map_err(|error| error.to_string())?;

    if metadata.len() > 2 * 1024 * 1024 {
        return Err("File is too large to display (2 MB limit).".to_string());
    }

    std::fs::read_to_string(&file).map_err(|error| format!("Could not read file: {}", error))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![get_repository_tree, read_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
