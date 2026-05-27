use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const DATABASE_FILE_NAME: &str = "lmb_touch_crm.db";
const APP_LOCK_FILE_NAME: &str = "lmb_touch_crm.lock";
const APP_UNLOCK_CODE: &str = "LMB-42FC-D75A";
const APP_TRIAL_DAYS: i64 = 7;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    platform: String,
    app_config_dir: String,
    database_path: String,
    temp_dir: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppLockStatus {
    is_locked: bool,
    unlocked: bool,
    trial_started_epoch_day: i64,
    days_remaining: i64,
    trial_days: i64,
}

struct StoredLockState {
    trial_started_epoch_day: i64,
    unlocked: bool,
}

fn ensure_app_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;

    if !config_dir.exists() {
        fs::create_dir_all(&config_dir).map_err(|error| error.to_string())?;
    }

    Ok(config_dir)
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(ensure_app_config_dir(app)?.join(DATABASE_FILE_NAME))
}

fn lock_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(ensure_app_config_dir(app)?.join(APP_LOCK_FILE_NAME))
}

fn current_epoch_day() -> Result<i64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?;

    Ok((duration.as_secs() / 86_400) as i64)
}

fn parse_lock_state(contents: &str) -> Option<StoredLockState> {
    let mut trial_started_epoch_day = None;
    let mut unlocked = false;

    for line in contents.lines() {
        let mut parts = line.splitn(2, '=');
        let key = parts.next()?.trim();
        let value = parts.next()?.trim();

        match key {
            "trial_started_epoch_day" => trial_started_epoch_day = value.parse::<i64>().ok(),
            "unlocked" => unlocked = value.eq_ignore_ascii_case("true"),
            _ => {}
        }
    }

    trial_started_epoch_day.map(|started| StoredLockState {
        trial_started_epoch_day: started,
        unlocked,
    })
}

fn serialize_lock_state(state: &StoredLockState) -> String {
    format!(
        "trial_started_epoch_day={}\nunlocked={}\n",
        state.trial_started_epoch_day, state.unlocked
    )
}

fn read_or_create_lock_state(app: &AppHandle) -> Result<StoredLockState, String> {
    let path = lock_state_path(app)?;

    if path.exists() {
        if let Some(state) = parse_lock_state(&fs::read_to_string(&path).map_err(|error| error.to_string())?) {
            return Ok(state);
        }
    }

    let state = StoredLockState {
        trial_started_epoch_day: current_epoch_day()?,
        unlocked: false,
    };
    fs::write(&path, serialize_lock_state(&state)).map_err(|error| error.to_string())?;
    Ok(state)
}

fn write_lock_state(app: &AppHandle, state: &StoredLockState) -> Result<(), String> {
    fs::write(lock_state_path(app)?, serialize_lock_state(state)).map_err(|error| error.to_string())
}

fn lock_status_from_state(state: StoredLockState) -> Result<AppLockStatus, String> {
    let elapsed_days = current_epoch_day()?.saturating_sub(state.trial_started_epoch_day);
    let days_remaining = if state.unlocked {
        APP_TRIAL_DAYS
    } else {
        APP_TRIAL_DAYS.saturating_sub(elapsed_days)
    };

    Ok(AppLockStatus {
        is_locked: !state.unlocked && elapsed_days >= APP_TRIAL_DAYS,
        unlocked: state.unlocked,
        trial_started_epoch_day: state.trial_started_epoch_day,
        days_remaining,
        trial_days: APP_TRIAL_DAYS,
    })
}

#[cfg(target_os = "windows")]
fn shell_quote_single(value: &str) -> String {
    value.replace('\'', "''")
}

fn command_output_lines(command: &mut Command) -> Result<Vec<String>, String> {
    let output = command.output().map_err(|error| error.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.trim().to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut rows = stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();

    rows.sort();
    rows.dedup();
    Ok(rows)
}

#[tauri::command]
fn get_runtime_info(app: AppHandle) -> Result<RuntimeInfo, String> {
    let config_dir = ensure_app_config_dir(&app)?;
    let temp_dir = std::env::temp_dir();
    let database_path = config_dir.join(DATABASE_FILE_NAME);

    Ok(RuntimeInfo {
        platform: std::env::consts::OS.to_string(),
        app_config_dir: config_dir.display().to_string(),
        database_path: database_path.display().to_string(),
        temp_dir: temp_dir.display().to_string(),
    })
}

#[tauri::command]
fn get_app_lock_status(app: AppHandle) -> Result<AppLockStatus, String> {
    lock_status_from_state(read_or_create_lock_state(&app)?)
}

#[tauri::command]
fn unlock_app(app: AppHandle, code: String) -> Result<AppLockStatus, String> {
    if code.trim().to_uppercase() != APP_UNLOCK_CODE {
        return Err("Invalid unlock code.".to_string());
    }

    let mut state = read_or_create_lock_state(&app)?;
    state.unlocked = true;
    write_lock_state(&app, &state)?;
    lock_status_from_state(state)
}

#[tauri::command]
fn write_binary_file(path: String, bytes: Vec<u8>) -> Result<String, String> {
    let target_path = PathBuf::from(path);
    let parent = target_path
        .parent()
        .ok_or_else(|| "A valid destination path is required.".to_string())?;

    if !parent.exists() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    fs::write(&target_path, bytes).map_err(|error| error.to_string())?;
    Ok(format!("Saved {}", target_path.display()))
}

#[tauri::command]
fn backup_database(app: AppHandle, destination_path: String) -> Result<String, String> {
    let source_path = database_path(&app)?;

    if !source_path.exists() {
      return Err("The local database file does not exist yet.".to_string());
    }

    let target_path = PathBuf::from(destination_path);
    let parent = target_path
        .parent()
        .ok_or_else(|| "A valid backup destination path is required.".to_string())?;

    if !parent.exists() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    fs::copy(&source_path, &target_path).map_err(|error| error.to_string())?;
    Ok(format!("Backup saved to {}", target_path.display()))
}

#[tauri::command]
fn list_printers() -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        return command_output_lines(
            Command::new("powershell").args([
                "-NoProfile",
                "-Command",
                "Get-Printer | Select-Object -ExpandProperty Name",
            ]),
        );
    }

    #[cfg(target_os = "macos")]
    {
        return command_output_lines(Command::new("sh").args([
            "-lc",
            "lpstat -a | awk '{print $1}'",
        ]));
    }

    #[cfg(target_os = "linux")]
    {
        return command_output_lines(Command::new("sh").args([
            "-lc",
            "lpstat -a | awk '{print $1}'",
        ]));
    }

    #[allow(unreachable_code)]
    Err("Printer discovery is not supported on this operating system.".to_string())
}

#[tauri::command]
fn test_printer(printer_name: String, profile_type: String) -> Result<String, String> {
    if printer_name.trim().is_empty() {
        return Err("Choose a printer before running a test.".to_string());
    }

    let temp_file = std::env::temp_dir().join(format!(
        "lmb_touch_crm_{}_printer_test.txt",
        profile_type.replace(' ', "_")
    ));
    let message = format!(
        "Acksync CRM Printer Test\nProfile: {}\nPrinter: {}\nStatus: OK\n",
        profile_type, printer_name
    );
    fs::write(&temp_file, message).map_err(|error| error.to_string())?;

    #[cfg(target_os = "windows")]
    {
        let command = format!(
            "Get-Content -Path '{}' | Out-Printer -Name '{}'",
            shell_quote_single(&temp_file.display().to_string()),
            shell_quote_single(printer_name.trim())
        );

        let output = Command::new("powershell")
            .args(["-NoProfile", "-Command", &command])
            .output()
            .map_err(|error| error.to_string())?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }

        return Ok(format!("Test page sent to {}", printer_name));
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let output = Command::new("lp")
            .args(["-d", printer_name.trim(), temp_file.to_string_lossy().as_ref()])
            .output()
            .map_err(|error| error.to_string())?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }

        return Ok(format!("Test page sent to {}", printer_name));
    }

    #[allow(unreachable_code)]
    Err("Test printing is not supported on this operating system.".to_string())
}

#[tauri::command]
fn print_receipt_text(printer_name: String, receipt_text: String) -> Result<String, String> {
    if printer_name.trim().is_empty() {
        return Err("Choose a receipt printer before printing.".to_string());
    }
    if receipt_text.trim().is_empty() {
        return Err("Receipt content is empty.".to_string());
    }

    let temp_file = std::env::temp_dir().join("lmb_touch_crm_receipt.txt");
    fs::write(&temp_file, receipt_text).map_err(|error| error.to_string())?;

    #[cfg(target_os = "windows")]
    {
        let command = format!(
            "Get-Content -Path '{}' | Out-Printer -Name '{}'",
            shell_quote_single(&temp_file.display().to_string()),
            shell_quote_single(printer_name.trim())
        );

        let output = Command::new("powershell")
            .args(["-NoProfile", "-Command", &command])
            .output()
            .map_err(|error| error.to_string())?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }

        return Ok(format!("Receipt sent to {}", printer_name));
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let output = Command::new("lp")
            .args(["-d", printer_name.trim(), temp_file.to_string_lossy().as_ref()])
            .output()
            .map_err(|error| error.to_string())?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }

        return Ok(format!("Receipt sent to {}", printer_name));
    }

    #[allow(unreachable_code)]
    Err("Receipt printing is not supported on this operating system.".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            backup_database,
            get_app_lock_status,
            get_runtime_info,
            list_printers,
            print_receipt_text,
            test_printer,
            unlock_app,
            write_binary_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
