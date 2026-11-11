Add-Type @'
using System;
using System.Runtime.InteropServices;
public struct RoleboxRect { public int Left; public int Top; public int Right; public int Bottom; }
public class RoleboxWindowApi {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out RoleboxRect rect);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr handle, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
