using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

// Invoked on demand through Maker Studio's existing open_path API.
public static class RecycleResources {
    [STAThread]
    public static int Main() {
        string script = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "recycle-resources.ps1");
        string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe");
        var start = new ProcessStartInfo(powershell, "-NoLogo -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File \"" + script + "\"");
        start.UseShellExecute = false; start.CreateNoWindow = true;
        using (var child = Process.Start(start)) { child.WaitForExit(); return child.ExitCode; }
    }
    public static void Recycle(string path) { Operate(path, null, null); }
    public static void Restore(string path, string parent, string name) { Operate(path, parent, name); }
    static void Operate(string path, string destination, string name) {
        var op = (IFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("3ad05575-8857-4850-9277-11b85bdb8e09")));
        IShellItem item = null, parent = null;
        try {
            Guid iid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
            Marshal.ThrowExceptionForHR(SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out item));
            // Silent, no confirmation/error UI, early failure. RECYCLEONDELETE
            // explicitly requests the Recycle Bin regardless of Explorer settings.
            Marshal.ThrowExceptionForHR(op.SetOperationFlags(0x00100414u | (destination == null ? 0x20080040u : 0u)));
            if (destination == null) Marshal.ThrowExceptionForHR(op.DeleteItem(item, IntPtr.Zero));
            else {
                if (Directory.Exists(Path.Combine(destination, name))) throw new IOException("Restore destination exists.");
                Marshal.ThrowExceptionForHR(SHCreateItemFromParsingName(destination, IntPtr.Zero, ref iid, out parent));
                Marshal.ThrowExceptionForHR(op.MoveItem(item, parent, name, IntPtr.Zero));
            }
            Marshal.ThrowExceptionForHR(op.PerformOperations());
            bool aborted; Marshal.ThrowExceptionForHR(op.GetAnyOperationsAborted(out aborted));
            if (aborted || (destination == null ? Directory.Exists(path) : !Directory.Exists(Path.Combine(destination, name))))
                throw new IOException("Windows did not complete the Recycle Bin operation.");
        } finally {
            if (item != null) Marshal.ReleaseComObject(item);
            if (parent != null) Marshal.ReleaseComObject(parent);
            Marshal.ReleaseComObject(op);
        }
    }
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=true)]
    static extern int SHCreateItemFromParsingName(string path, IntPtr bind, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IShellItem item);
    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IShellItem { }
    [ComImport, Guid("947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileOperation {
        [PreserveSig] int Advise(IntPtr sink, out uint cookie);
        [PreserveSig] int Unadvise(uint cookie);
        [PreserveSig] int SetOperationFlags(uint flags);
        [PreserveSig] int SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string message);
        [PreserveSig] int SetProgressDialog(IntPtr dialog);
        [PreserveSig] int SetProperties(IntPtr properties);
        [PreserveSig] int SetOwnerWindow(uint window);
        [PreserveSig] int ApplyPropertiesToItem(IShellItem item);
        [PreserveSig] int ApplyPropertiesToItems(IntPtr items);
        [PreserveSig] int RenameItem(IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
        [PreserveSig] int RenameItems(IntPtr items, [MarshalAs(UnmanagedType.LPWStr)] string name);
        [PreserveSig] int MoveItem(IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
        [PreserveSig] int MoveItems(IntPtr items, IShellItem destination);
        [PreserveSig] int CopyItem(IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
        [PreserveSig] int CopyItems(IntPtr items, IShellItem destination);
        [PreserveSig] int DeleteItem(IShellItem item, IntPtr sink);
        [PreserveSig] int DeleteItems(IntPtr items);
        [PreserveSig] int NewItem(IShellItem destination, uint attributes, [MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.LPWStr)] string template, IntPtr sink);
        [PreserveSig] int PerformOperations();
        [PreserveSig] int GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
    }
}
