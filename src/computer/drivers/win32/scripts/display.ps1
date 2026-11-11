Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public struct RoleboxMonitorRect { public int Left; public int Top; public int Right; public int Bottom; }
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct RoleboxMonitorInfo {
  public int Size; public RoleboxMonitorRect Monitor; public RoleboxMonitorRect Work; public uint Flags;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Device;
}
public class RoleboxDisplay {
  public int id; public int x; public int y; public int width; public int height;
  public double scale; public bool primary; public string name;
}
public class RoleboxDisplayApi {
  private delegate bool MonitorEnumProc(IntPtr monitor, IntPtr dc, IntPtr rect, IntPtr data);
  [DllImport("user32.dll", SetLastError = true)] private static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorEnumProc callback, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetMonitorInfo(IntPtr monitor, ref RoleboxMonitorInfo info);
  [DllImport("shcore.dll")] private static extern int GetScaleFactorForMonitor(IntPtr monitor, out int scale);
  public static RoleboxDisplay[] Snapshot() {
    var monitors = new List<IntPtr>();
    if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr monitor, IntPtr dc, IntPtr rect, IntPtr data) {
      monitors.Add(monitor); return true;
    }, IntPtr.Zero)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "could not enumerate displays");
    var displays = new List<RoleboxDisplay>();
    foreach (var monitor in monitors) {
      var info = new RoleboxMonitorInfo(); info.Size = Marshal.SizeOf(typeof(RoleboxMonitorInfo));
      if (!GetMonitorInfo(monitor, ref info)) throw new InvalidOperationException("could not read monitor bounds");
      int scale;
      if (GetScaleFactorForMonitor(monitor, out scale) != 0 || scale <= 0) throw new InvalidOperationException("could not read monitor scale");
      var bounds = info.Monitor;
      if (bounds.Right <= bounds.Left || bounds.Bottom <= bounds.Top) throw new InvalidOperationException("display has empty bounds");
      displays.Add(new RoleboxDisplay { id = displays.Count, x = bounds.Left, y = bounds.Top,
        width = bounds.Right - bounds.Left, height = bounds.Bottom - bounds.Top,
        scale = scale / 100.0, primary = (info.Flags & 1) != 0, name = info.Device });
    }
    if (displays.Count == 0) throw new InvalidOperationException("no displays are available");
    return displays.ToArray();
  }
}
'@
