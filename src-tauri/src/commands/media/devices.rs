#[cfg(any(target_os = "macos", test))]
use {plist::Value, std::collections::HashSet};

#[cfg(target_os = "macos")]
fn disk_inventory(physical_only: bool) -> Result<Value, String> {
    let mut command = std::process::Command::new("/usr/sbin/diskutil");
    command.args(["list", "-plist", "external"]);
    if physical_only {
        command.arg("physical");
    }
    let output = command
        .output()
        .map_err(|error| format!("Cannot inspect external disks: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "macOS external disk detection failed ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Value::from_reader_xml(std::io::Cursor::new(output.stdout))
        .map_err(|error| format!("Invalid macOS disk inventory: {error}"))
}

#[cfg(any(target_os = "macos", test))]
fn disks(inventory: &Value) -> Result<&[Value], String> {
    inventory
        .as_dictionary()
        .and_then(|values| values.get("AllDisksAndPartitions"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| "Invalid macOS disk inventory: missing AllDisksAndPartitions".into())
}

#[cfg(any(target_os = "macos", test))]
fn identifier(value: &Value) -> Option<&str> {
    value.as_dictionary()?.get("DeviceIdentifier")?.as_string()
}

#[cfg(any(target_os = "macos", test))]
fn children<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .as_dictionary()
        .and_then(|values| values.get(key))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

#[cfg(any(target_os = "macos", test))]
fn collect_identifiers<'a>(disk: &'a Value, identifiers: &mut HashSet<&'a str>) {
    if let Some(id) = identifier(disk) {
        identifiers.insert(id);
    }
    for partition in children(disk, "Partitions") {
        collect_identifiers(partition, identifiers);
    }
}

#[cfg(any(target_os = "macos", test))]
fn mounted_paths(disk: &Value, paths: &mut Vec<String>) {
    if let Some(values) = disk.as_dictionary() {
        if values.get("OSInternal").and_then(Value::as_boolean) == Some(true) {
            return;
        }
        if let Some(path) = values.get("MountPoint").and_then(Value::as_string) {
            if path.starts_with('/') && path != "/" {
                paths.push(path.to_string());
            }
        }
        for key in ["Partitions", "APFSVolumes"] {
            for child in children(disk, key) {
                mounted_paths(child, paths);
            }
        }
    }
}

#[cfg(any(target_os = "macos", test))]
fn external_mounts(inventory: &Value, physical: &Value) -> Result<Vec<String>, String> {
    let mut identifiers = HashSet::new();
    for disk in disks(physical)? {
        collect_identifiers(disk, &mut identifiers);
    }
    let mut paths = Vec::new();
    for disk in disks(inventory)? {
        let stores = children(disk, "APFSPhysicalStores");
        // APFS volumes are synthesized, but must be backed entirely by external hardware.
        let external_apfs = !stores.is_empty()
            && stores
                .iter()
                .all(|store| identifier(store).is_some_and(|id| identifiers.contains(id)));
        if identifier(disk).is_some_and(|id| identifiers.contains(id)) || external_apfs {
            mounted_paths(disk, &mut paths);
        }
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

pub(super) fn list() -> Result<Vec<String>, String> {
    log::debug!("[media:devices] inspecting physical external media");
    #[cfg(target_os = "macos")]
    {
        let physical = disk_inventory(true)?;
        let inventory = disk_inventory(false)?;
        let paths = external_mounts(&inventory, &physical)?;
        log::debug!(
            "[media:devices] found {} physical media volumes",
            paths.len()
        );
        Ok(paths)
    }
    #[cfg(target_os = "windows")]
    {
        let mut command = std::process::Command::new("powershell.exe");
        crate::services::background_process::configure(&mut command);
        let output = command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                r#"
$ErrorActionPreference = 'Stop'
$roots = @(Get-Disk | Where-Object {
    $_.BusType -in @('USB', 'SD', 'MMC', '1394') -and -not $_.IsBoot -and -not $_.IsSystem
} | Get-Partition | Where-Object {
    $_.DriveLetter -and -not $_.IsBoot -and -not $_.IsSystem -and -not $_.IsHidden
} | Get-Volume | Where-Object {
    $_.DriveLetter -and $_.DriveType -in @('Removable', 'Fixed')
} | ForEach-Object { $_.DriveLetter + ':\' })
ConvertTo-Json -Compress -InputObject @($roots | Sort-Object -Unique)
"#,
            ])
            .output()
            .map_err(|error| format!("Cannot inspect external media: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "Windows external media detection failed ({}): {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let paths: Vec<String> = serde_json::from_slice(&output.stdout)
            .map_err(|error| format!("Invalid Windows volume response: {error}"))?;
        log::debug!(
            "[media:devices] found {} physical media volumes",
            paths.len()
        );
        Ok(paths)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("Media-device detection supports macOS and Windows only".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dictionary(entries: &[(&str, Value)]) -> Value {
        Value::Dictionary(
            entries
                .iter()
                .map(|(key, value)| (key.to_string(), value.clone()))
                .collect(),
        )
    }

    fn inventory(disks: Vec<Value>) -> Value {
        dictionary(&[("AllDisksAndPartitions", Value::Array(disks))])
    }

    fn partition(id: &str, path: &str) -> Value {
        dictionary(&[("DeviceIdentifier", id.into()), ("MountPoint", path.into())])
    }

    fn disk(id: &str, partitions: Vec<Value>) -> Value {
        dictionary(&[
            ("DeviceIdentifier", id.into()),
            ("Partitions", Value::Array(partitions)),
        ])
    }

    fn apfs(id: &str, stores: &[&str], volumes: Vec<Value>) -> Value {
        dictionary(&[
            ("DeviceIdentifier", id.into()),
            (
                "APFSPhysicalStores",
                Value::Array(
                    stores
                        .iter()
                        .map(|store| dictionary(&[("DeviceIdentifier", (*store).into())]))
                        .collect(),
                ),
            ),
            ("APFSVolumes", Value::Array(volumes)),
        ])
    }

    #[test]
    fn ignores_virtual_external_mounts() {
        let inventory = dictionary(&[(
            "AllDisksAndPartitions",
            Value::Array(vec![dictionary(&[
                ("DeviceIdentifier", "disk4".into()),
                ("OSInternal", false.into()),
                (
                    "Partitions",
                    Value::Array(vec![dictionary(&[(
                        "MountPoint",
                        "/Users/example/e2e/.cache/out/volumes/system-cross-device".into(),
                    )])]),
                ),
            ])]),
        )]);
        let physical = dictionary(&[("AllDisksAndPartitions", Value::Array(vec![]))]);
        let paths = external_mounts(&inventory, &physical).unwrap();
        assert!(paths.is_empty(), "nonphysical volumes detected: {paths:?}");
    }

    #[test]
    fn keeps_physical_cards_drives_and_cameras_but_not_virtual_or_internal_disks() {
        let hardware = vec![
            disk("disk4", vec![partition("disk4s1", "/Volumes/SD Card")]),
            disk("disk5", vec![partition("disk5s1", "/Volumes/External SSD")]),
            disk("disk6", vec![partition("disk6s1", "/Volumes/Camera")]),
        ];
        let mut all = hardware.clone();
        all.extend([
            disk("disk0", vec![partition("disk0s1", "/System/Volumes/Data")]),
            disk("disk7", vec![partition("disk7s1", "/Volumes/Installer")]),
        ]);
        assert_eq!(
            external_mounts(&inventory(all), &inventory(hardware)).unwrap(),
            [
                "/Volumes/Camera",
                "/Volumes/External SSD",
                "/Volumes/SD Card"
            ]
        );
    }

    #[test]
    fn keeps_external_apfs_volumes_only_when_all_stores_are_physical_external() {
        let physical = inventory(vec![disk("disk4", vec![partition("disk4s2", "")])]);
        let all = inventory(vec![
            apfs(
                "disk5",
                &["disk4s2"],
                vec![partition("disk5s1", "/Volumes/APFS SSD")],
            ),
            apfs(
                "disk6",
                &["disk0s2"],
                vec![partition("disk6s1", "/Volumes/Internal")],
            ),
            apfs(
                "disk7",
                &["disk8s2"],
                vec![partition("disk7s1", "/Volumes/Image")],
            ),
            apfs("disk9", &[], vec![partition("disk9s1", "/Volumes/Unknown")]),
            apfs(
                "disk10",
                &["disk4s2", "disk0s2"],
                vec![partition("disk10s1", "/Volumes/Mixed")],
            ),
        ]);
        assert_eq!(
            external_mounts(&all, &physical).unwrap(),
            ["/Volumes/APFS SSD"]
        );
    }

    #[test]
    fn ignores_unmounted_system_relative_and_unrelated_paths_and_deduplicates() {
        let physical = inventory(vec![disk("disk4", vec![])]);
        let all = inventory(vec![dictionary(&[
            ("DeviceIdentifier", "disk4".into()),
            (
                "Partitions",
                Value::Array(vec![
                    partition("disk4s1", ""),
                    partition("disk4s2", "/"),
                    partition("disk4s3", "relative/path"),
                    partition("disk4s4", "/Volumes/Card"),
                    partition("disk4s4", "/Volumes/Card"),
                    dictionary(&[
                        ("MountPoint", "/Volumes/Preboot".into()),
                        ("OSInternal", true.into()),
                    ]),
                ]),
            ),
            (
                "UnrelatedMetadata",
                partition("other", "/Users/example/folder"),
            ),
        ])]);
        assert_eq!(external_mounts(&all, &physical).unwrap(), ["/Volumes/Card"]);
    }

    #[test]
    fn accepts_genuine_physical_volumes_mounted_outside_volumes_directory() {
        let physical = inventory(vec![disk("disk4", vec![])]);
        let all = inventory(vec![disk(
            "disk4",
            vec![partition("disk4s1", "/Users/example/mounts/card")],
        )]);
        assert_eq!(
            external_mounts(&all, &physical).unwrap(),
            ["/Users/example/mounts/card"]
        );
    }

    #[test]
    fn malformed_inventories_are_reported_instead_of_appearing_empty() {
        let valid = inventory(vec![]);
        let invalid = dictionary(&[]);
        assert!(external_mounts(&invalid, &valid).is_err());
        assert!(external_mounts(&valid, &invalid).is_err());
        assert!(external_mounts(&valid, &valid).unwrap().is_empty());
    }
}
