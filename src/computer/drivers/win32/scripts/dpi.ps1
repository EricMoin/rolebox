Add-Type @'
using System;
using System.Runtime.InteropServices;
public class RoleboxDpi {
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int awareness);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool IsProcessDPIAware();
  public static void Enable() {
    try {
      if (SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero) return;
      if (SetThreadDpiAwarenessContext(new IntPtr(-3)) != IntPtr.Zero) return;
      throw new InvalidOperationException("could not enable per-monitor DPI awareness");
    } catch (EntryPointNotFoundException) { }
    try {
      if (SetProcessDpiAwareness(2) == 0) return;
      throw new InvalidOperationException("could not enable per-monitor DPI awareness");
    } catch (DllNotFoundException) { } catch (EntryPointNotFoundException) { }
    if (!SetProcessDPIAware() && !IsProcessDPIAware()) throw new InvalidOperationException("could not enable DPI awareness");
  }
}
'@
[RoleboxDpi]::Enable()
