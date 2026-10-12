use std::process::Command;

/// Suppress console allocation for background helpers without hiding GUI apps.
pub fn configure(command: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = command;
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn powershell_helper_has_no_console_window() {
        let mut command = Command::new("powershell.exe");
        configure(&mut command);
        let output = command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Add-Type -Name ConsoleWindow -Namespace ImmichTest -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"kernel32.dll\")] public static extern System.IntPtr GetConsoleWindow();'; [ImmichTest.ConsoleWindow]::GetConsoleWindow().ToInt64()",
            ])
            .output()
            .expect("PowerShell must launch for background-process regression test");
        assert!(
            output.status.success(),
            "PowerShell failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "0");
    }
}
