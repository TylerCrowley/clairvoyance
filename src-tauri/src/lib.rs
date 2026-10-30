// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

use git2::Repository;
use serde::Serialize;
use std::fs;
use std::path::{Path};

#[derive(Serialize)]
struct TreeEntry {
    name: String,
    path: String,
    is_dir: bool,
    unreadable: bool,
    children: Vec<TreeEntry>,
}

fn build_tree(path: &Path) -> TreeEntry {
    let mut entries = Vec::new();

    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Repository root".to_string());

    let read_dir = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) => {
            eprintln!(
                "Could not read directory {}: {}",
                path.display(),
                error
            );

            return TreeEntry {
                name,
                path: path.to_string_lossy().into_owned(),
                is_dir: true,
                unreadable: true,
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

    if name.starts_with('.') {
        continue;
    }

    let entry_path = entry.path();

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
        let child_tree = build_tree(&entry_path);
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
    Ok(build_tree(&root))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![greet])
        .invoke_handler(tauri::generate_handler![get_repository_tree])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
