Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class RoleboxWindowList {
  private delegate bool EnumWindowsProc(IntPtr handle, IntPtr data);
  [DllImport("user32.dll", SetLastError = true)] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, StringBuilder text, int capacity);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  public static IntPtr[] VisibleWindows() {
    var windows = new List<IntPtr>();
    if (!EnumWindows(delegate(IntPtr handle, IntPtr data) {
      if (IsWindowVisible(handle)) windows.Add(handle);
      return true;
    }, IntPtr.Zero)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "could not enumerate desktop windows");
    return windows.ToArray();
  }
}
'@
