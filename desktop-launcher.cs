using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("AI语忆")]
[assembly: AssemblyProduct("AI语忆")]
[assembly: AssemblyDescription("打开 AI语忆 本地管理界面")]
[assembly: AssemblyVersion("1.2.0.0")]

internal static class DesktopLauncher
{
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string script = Path.Combine(root, "launcher.py");
            if (!File.Exists(script))
                throw new FileNotFoundException("请把 EXE 保留在原程序目录中，或使用快捷方式启动。", script);
            string python = Path.Combine(root, "runtime", "python", "pythonw.exe");
            if (!File.Exists(python))
            {
                using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("python-path"))
                {
                    if (stream != null)
                        using (StreamReader reader = new StreamReader(stream))
                            python = reader.ReadToEnd().Trim();
                }
            }
            if (!File.Exists(python))
                throw new FileNotFoundException("程序运行环境不完整，请重新安装完整版本。", python);
            ProcessStartInfo info = new ProcessStartInfo(python, "-X utf8 \"" + script + "\"");
            info.WorkingDirectory = root;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            using (Process process = Process.Start(info))
            {
                process.WaitForExit();
                return process.ExitCode;
            }
        }
        catch (Exception error)
        {
            if (Array.IndexOf(args, "--no-dialog") < 0)
                MessageBox.Show(error.Message, "AI语忆", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
