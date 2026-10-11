use std::path::Path;

pub fn native_preview(input: &Path, output: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("/usr/bin/sips")
        .args(["-s", "format", "jpeg", "--resampleHeightWidthMax", "240"])
        .arg(input)
        .arg("--out")
        .arg(output)
        .output();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PREVIEW])
        .env("IMMICH_PREVIEW_INPUT", input)
        .env("IMMICH_PREVIEW_OUTPUT", output)
        .output();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return Err("Native import previews support macOS and Windows only".into());
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let result = result.map_err(|e| format!("Native preview launch failed: {e}"))?;
        if !result.status.success() || !output.is_file() {
            log::warn!(
                "[media:preview] native codec unavailable input={} status={} error={}",
                input.display(),
                result.status,
                String::from_utf8_lossy(&result.stderr)
            );
            return Err("Preview unavailable: install an operating-system codec for this camera/format; the original can still be imported".into());
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
const WINDOWS_PREVIEW: &str = r#"
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class ImmichPreview {
    [StructLayout(LayoutKind.Sequential)] public struct Size { public int X; public int Y; }
    [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ImageFactory {
        [PreserveSig] int GetImage(Size size, int flags, out IntPtr bitmap);
    }
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]
    static extern void SHCreateItemFromParsingName(string path, IntPtr context, ref Guid id,
        [MarshalAs(UnmanagedType.Interface)] out ImageFactory factory);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr bitmap);
    public static void Save(string input, string output) {
        Guid id=typeof(ImageFactory).GUID;
        ImageFactory factory=null;
        IntPtr bitmap=IntPtr.Zero;
        try {
            SHCreateItemFromParsingName(input, IntPtr.Zero, ref id, out factory);
            int result=factory.GetImage(new Size {X=240,Y=240}, 8, out bitmap);
            Marshal.ThrowExceptionForHR(result);
            using (Bitmap image=Image.FromHbitmap(bitmap)) image.Save(output,ImageFormat.Jpeg);
        } finally {
            if(bitmap!=IntPtr.Zero) DeleteObject(bitmap);
            if(factory!=null) Marshal.ReleaseComObject(factory);
        }
    }
}
'@
[ImmichPreview]::Save($env:IMMICH_PREVIEW_INPUT,$env:IMMICH_PREVIEW_OUTPUT)
"#;
