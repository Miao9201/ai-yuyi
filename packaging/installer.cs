using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("AI语忆安装程序")]
[assembly: AssemblyProduct("AI语忆")]
[assembly: AssemblyVersion("1.2.0.0")]

internal static class Installer
{
    // User files are never replaced by an upgrade, even when defaults ship in the ZIP.
    internal static bool Preserve(string relative)
    {
        string p = relative.Replace('\\', '/').ToLowerInvariant();
        return p.StartsWith("data/") || p.StartsWith("private/") ||
            p.StartsWith("upstream-v1.2.0/data/") || p.StartsWith("upstream-v1.2.0/private/") ||
            p.StartsWith("upstream-v1.2.0/personas/") ||
            p == "settings.json" || p == "config.json" || p.EndsWith("/.env");
    }

    [STAThread]
    private static int Main(string[] args)
    {
        bool quiet = Array.IndexOf(args, "/quiet") >= 0;
        string target = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "AIYuYi");
        for (int i = 0; i < args.Length; i++)
            if (args[i] == "/target" && i + 1 < args.Length) target = args[++i];
        try
        {
            target = Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar);
            Directory.CreateDirectory(target);
            string prefix = target + Path.DirectorySeparatorChar;
            using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            using (ZipArchive zip = new ZipArchive(payload, ZipArchiveMode.Read))
            {
                // Validate every entry before writing any file.
                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    string destination = Path.GetFullPath(Path.Combine(target, entry.FullName));
                    if (!destination.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || entry.FullName.Contains(":"))
                        throw new InvalidDataException("安装包路径无效：" + entry.FullName);
                    string ancestor = Path.GetDirectoryName(destination);
                    while (ancestor != null && ancestor.StartsWith(target, StringComparison.OrdinalIgnoreCase))
                    {
                        if (Directory.Exists(ancestor) && (File.GetAttributes(ancestor) & FileAttributes.ReparsePoint) != 0)
                            throw new InvalidDataException("安装路径包含链接，请选择普通文件夹。");
                        ancestor = Path.GetDirectoryName(ancestor);
                    }
                    if (File.Exists(destination) && (File.GetAttributes(destination) & FileAttributes.ReparsePoint) != 0)
                        throw new InvalidDataException("安装路径包含链接。");
                }
                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    string destination = Path.GetFullPath(Path.Combine(target, entry.FullName));
                    if (String.IsNullOrEmpty(entry.Name)) { Directory.CreateDirectory(destination); continue; }
                    if (File.Exists(destination) && Preserve(entry.FullName)) continue;
                    Directory.CreateDirectory(Path.GetDirectoryName(destination));
                    // Replace each program file atomically; never truncate an existing file.
                    string temporary = destination + ".install-" + Guid.NewGuid().ToString("N");
                    try
                    {
                        entry.ExtractToFile(temporary);
                        if (File.Exists(destination)) File.Replace(temporary, destination, null);
                        else File.Move(temporary, destination);
                    }
                    finally { if (File.Exists(temporary)) File.Delete(temporary); }
                }
            }
            string executable = Path.Combine(target, "AI语忆.exe");
            if (Array.IndexOf(args, "/no-shortcut") < 0)
            {
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                object shell = Activator.CreateInstance(shellType);
                string path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "AI语忆.lnk");
                object link = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
                link.GetType().InvokeMember("TargetPath", BindingFlags.SetProperty, null, link, new object[] { executable });
                link.GetType().InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, link, new object[] { target });
                link.GetType().InvokeMember("Save", BindingFlags.InvokeMethod, null, link, null);
            }
            if (Array.IndexOf(args, "/no-launch") < 0)
                Process.Start(new ProcessStartInfo(executable) { WorkingDirectory = target, UseShellExecute = true });
            if (!quiet) MessageBox.Show("AI语忆安装完成。桌面快捷方式可再次打开控制台。\n升级时已有配置和聊天数据均会保留。", "AI语忆", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 0;
        }
        catch (Exception error)
        {
            try
            {
                File.AppendAllText(Path.Combine(target, "install-error.log"),
                    DateTime.UtcNow.ToString("O") + Environment.NewLine + error.ToString() + Environment.NewLine);
            }
            catch { /* A failed diagnostic write must not replace the installation error. */ }
            if (!quiet) MessageBox.Show("安装未完成：" + error.Message + "\n请关闭正在运行的程序后重试。", "AI语忆", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
